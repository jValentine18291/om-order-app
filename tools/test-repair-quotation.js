// The Repair Quotation the customer is sent to approve.
//
//   node tools/test-repair-quotation.js C:/temp/scratch.db
//
// THE RULE THIS GUARDS
// The quotation and the Sales Order are two documents describing one repair.
// Sales send the quotation, the customer approves it, then the order is raised
// from the same slip. If the two disagree - a line in one and not the other, or
// a different figure at the bottom - the customer has been told two different
// things about the same job, and whichever they read second is the one they
// will argue from.
//
// So both are built from slipBlockLines(). What follows checks that they really
// are the same lines, that the money adds up, and that asking for a quotation
// changes nothing about the slip - Sales must be able to produce one, be asked
// a question, and produce it again without the slip having moved on.
const path = require("path");
const target = process.argv[2];
const live = path.resolve(__dirname, "..", "backend", "om_orders.db");
if (!target) {
  console.error("Give a scratch database path, e.g. node " + path.basename(__filename) + " C:/temp/scratch.db");
  process.exit(2);
}
if (path.resolve(target) === live) {
  console.error("Refusing to run against the live database: " + live);
  process.exit(2);
}
process.env.OM_DB_PATH = target;
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  const slip = await data.slips.createSlip({
    company: "ATL MAINTENANCE PTE LTD", debtor_code: "300-A001",
    contact_name: "Mr Tariqul", contact_number: "97293454",
    machines: [
      { desc: "HB2302 Handheld Blower", serial: "", remarks: "no start" },
      { desc: "PHT1500 Long reach Trimmer", serial: "P9", remarks: "service" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const [blower, trimmer] = slip.machines;

  // Priced exactly as the template's own example is.
  await data.slips.setMachineLabour(blower.id, 55);
  await data.slips.addPartToMachine(blower.id, {
    item_code: "A8 SPARE PARTS", description: "Piston", uom: "PC", unit_price: 31.10, quantity: 1, technician: "KS" });
  await data.slips.addPartToMachine(blower.id, {
    item_code: "A8 SPARE PARTS", description: "Piston Ring", uom: "PC", unit_price: 5.05, quantity: 2, technician: "KS" });
  await data.slips.setMachineComment(blower.id, "Machine mixed with Chemical - (Beyond repair)");

  await data.slips.setMachineLabour(trimmer.id, 15);
  await data.slips.addPartToMachine(trimmer.id, {
    item_code: "SZEN 550082171", description: "Element", uom: "PC", unit_price: 3.20, quantity: 1, technician: "KS" });

  const q = await data.slips.quotationForSlip(no);

  console.log("-- what the header carries --");
  check("the quotation is named after the slip", q.quotation_no, "QT-" + no);
  check("the customer", q.customer, "ATL MAINTENANCE PTE LTD");
  check("their account, for looking the address up", q.debtor_code, "300-A001");
  check("the contact, spaced the way the order spaces it",
    [q.contact_name, q.contact_number], ["Mr Tariqul", "9729 3454"]);

  console.log("\n-- the money --");
  // 55.00 + 31.10 + (5.05 x 2) + 15.00 + 3.20
  check("subtotal is the priced lines, nothing else", q.subtotal, 114.4);
  check("GST at 9%", q.gst, 10.3);
  check("total", q.total, 124.7);
  check("and the total is the two added", q.total, Math.round((q.subtotal + q.gst) * 100) / 100);

  console.log("\n-- it is good for thirty days --");
  const days = (new Date(q.valid_until) - new Date(q.date)) / 86400000;
  check("valid_until is 30 days after the date", days, 30);
  check("and says so in words too", q.valid_days, 30);

  console.log("\n-- the note rows carry no money --");
  const notes = q.lines.filter((l) => l.note);
  check("every note line is unpriced", notes.every((l) => !l.unit_price && !l.quantity), true);
  check("SubTotal appears once per machine",
    q.lines.filter((l) => l.description === "SubTotal").length, 2);
  check("the technician's comment is carried, marked with its *",
    q.lines.some((l) => l.description === "*Machine mixed with Chemical - (Beyond repair)"), true);
  check("and the contact is the last line", q.lines[q.lines.length - 1].description, "Mr Tariqul 9729 3454");

  console.log("\n-- a service line opens every machine --");
  const svc = q.lines.filter((l) => l.item_code === "A1 SVR LANDSCAPE");
  check("one per machine", svc.length, 2);
  check("charged as the labour, one NOS each",
    svc.map((l) => [l.unit_price, l.quantity, l.uom]), [[55, 1, "NOS"], [15, 1, "NOS"]]);
  check("described the way AutoCount describes it",
    [...new Set(svc.map((l) => l.description))], ["Being repair & replacement of part :-"]);

  console.log("\n-- asking for it changes nothing --");
  const before = await data.slips.getSlip(no);
  await data.slips.quotationForSlip(no);
  await data.slips.quotationForSlip(no);
  const after = await data.slips.getSlip(no);
  check("the slip's status is untouched", after.status, before.status);
  check("no machine has been marked converted",
    (after.machines || []).every((m) => !m.converted_at), true);
  check("and no Sales Order has appeared", await data.slips.getSlipOrder(no), null);

  console.log("\n-- and it is the SAME block the Sales Order uses --");
  // The one that matters. Raise the order and compare line for line.
  const q2 = await data.slips.quotationForSlip(no);
  const so = await data.slips.createSlipOrder(no, [blower.id, trimmer.id]);
  const order = await data.slips.getSlipOrder(no);
  const shape = (l) => [l.item_code || "", l.description || "",
                        Number(l.unit_price) || 0, Number(l.qty || l.quantity) || 0];
  check("line for line, the quotation and the order agree",
    q2.lines.map(shape), (order.lines || []).map(shape));
  const orderTotal = (order.lines || []).reduce(
    (n, l) => n + (Number(l.unit_price) || 0) * (Number(l.qty || l.quantity) || 0), 0);
  check("and the quotation's subtotal is the order's total, before GST",
    Math.round(orderTotal * 100) / 100, q2.subtotal);

  console.log("\n-- the running number, and what counts as a revision --");
  // Technicians forget a part and Sales re-send. That is a revision and earns
  // a number. Pressing the button twice on the same figures is not, and must
  // not be, or the customer holds two numbers for one quotation and has to ask
  // which one stands.
  const rq = await data.slips.createSlip({
    company: "RUNNING NUMBER TEST", contact_name: "Mr Ong", contact_number: "91112222",
    machines: [{ desc: "Husqvarna 525LK", serial: "R1", remarks: "service" }], signature: sig,
  });
  const rn = rq.slip_number;
  const rm = rq.machines[0].id;
  await data.slips.setMachineLabour(rm, 30);
  const T = { payment: "30 Days", delivery: "Ex-Singapore", who: "Chiu Yan" };

  const first = await data.slips.issueQuotation(rn, T);
  check("the first carries no suffix", first.quotation_no, "QT-" + rn);
  check("and is not a revision", first.revision, false);

  const again = await data.slips.issueQuotation(rn, T);
  check("sending the same thing again keeps its number", again.quotation_no, "QT-" + rn);
  check("and is still not a revision", again.revision, false);
  check("nothing extra was recorded", (await data.slips.slipQuotations(rn)).length, 1);

  // The forgotten part.
  await data.slips.addPartToMachine(rm, {
    item_code: "A8 SPARE PARTS", description: "Air Filter", uom: "PC",
    unit_price: 12.50, quantity: 1, technician: "KS" });
  const second = await data.slips.issueQuotation(rn, T);
  check("adding a part makes it -2", second.quotation_no, `QT-${rn}-2`);
  check("and says so", second.revision, true);
  // 30.00 + 12.50 = 42.50, GST 3.825 which is charged at 3.83, so 46.33.
  // Rounded to cents on the tax, not on the multiplication - a quotation
  // quoting a third of a cent is a quotation nobody can pay.
  check("its total moved with it", [second.subtotal, second.gst, second.total],
    [42.5, 3.83, 46.33]);

  // A price correction is a revision too - same lines, different money.
  const partId = (await data.slips.getSlip(rn)).machines[0].parts[0].id;
  await data.slips.setPartPrice(partId, 15);
  const third = await data.slips.issueQuotation(rn, T);
  check("a price change makes it -3", third.quotation_no, `QT-${rn}-3`);

  // So is a change of terms: it is a different offer on paper.
  const fourth = await data.slips.issueQuotation(rn, { ...T, payment: "C.O.D" });
  check("changing the payment term makes it -4", fourth.quotation_no, `QT-${rn}-4`);
  const fourthAgain = await data.slips.issueQuotation(rn, { ...T, payment: "C.O.D" });
  check("and re-sending THAT keeps -4", fourthAgain.quotation_no, `QT-${rn}-4`);

  console.log("\n-- the record of what was sent --");
  const hist = await data.slips.slipQuotations(rn);
  check("four quotations recorded", hist.length, 4);
  check("numbered in order", hist.map((h) => h.ref),
    ["QT-" + rn, `QT-${rn}-2`, `QT-${rn}-3`, `QT-${rn}-4`]);
  check("each remembers who sent it", [...new Set(hist.map((h) => h.issued_by))], ["Chiu Yan"]);
  check("and the terms it went out on", hist[3].payment_term, "C.O.D");

  console.log("\n-- and the preview knows what has gone before --");
  const preview = await data.slips.quotationForSlip(rn);
  check("it names the last one sent", preview.quotation_no, `QT-${rn}-4`);
  check("and what a revision would be called", preview.next_if_revised, `QT-${rn}-5`);
  check("without recording anything", (await data.slips.slipQuotations(rn)).length, 4);

  console.log("\n-- forcing the service item, on the quotation only --");
  // For a slip written before the app could tell a rider from a brushcutter.
  // It must not reach the Sales Order: an exception there is made in AutoCount,
  // where the order is keyed.
  const ov = await data.slips.createSlip({
    company: "OVERRIDE TEST", contact_name: "Mr Tan", contact_number: "93334444",
    machines: [{ desc: "Husqvarna 525LK Brushcutter", serial: "O1", remarks: "service" }],
    signature: sig,
  });
  const on = ov.slip_number, om = ov.machines[0].id;
  await data.slips.setMachineLabour(om, 60);

  const auto = await data.slips.quotationForSlip(on);
  check("left alone, a brushcutter is A1",
    auto.lines[0].item_code, "A1 SVR LANDSCAPE");

  const asRideOn = await data.slips.quotationForSlip(on, undefined, { service: "A3" });
  check("forced to A3, the code changes", asRideOn.lines[0].item_code, "A3 SVR RIDE-ON EQUIPT");
  check("and the wording with it", asRideOn.lines[0].description,
    "Being Service of ride-on mower/tractor & parts changed:");
  check("the money is untouched", asRideOn.subtotal, auto.subtotal);

  check("an unknown code is ignored rather than obeyed",
    (await data.slips.quotationForSlip(on, undefined, { service: "A99" })).lines[0].item_code,
    "A1 SVR LANDSCAPE");

  // An override is a different quotation on paper, so it earns a number.
  const o1 = await data.slips.issueQuotation(on, { payment: "30 Days", delivery: "Ex-Singapore" });
  const o2 = await data.slips.issueQuotation(on, { payment: "30 Days", delivery: "Ex-Singapore", service: "A3" });
  check("issuing it forced makes a revision", [o1.quotation_no, o2.quotation_no],
    [`QT-${on}`, `QT-${on}-2`]);
  check("and the revision carries the forced code", o2.lines[0].item_code, "A3 SVR RIDE-ON EQUIPT");

  const ovOrder = await data.slips.createSlipOrder(on, [om]);
  const ovLines = (await data.slips.getSlipOrder(on)).lines;
  check("but the Sales Order still says what the machine is",
    ovLines[0].item_code, "A1 SVR LANDSCAPE");

  console.log("\n-- and a ride-on reaches the order as A3 by itself --");
  // No override anywhere: the machine's own name is enough, on the quotation
  // and on the order alike.
  const rd = await data.slips.createSlip({
    company: "RIDE-ON TEST", contact_name: "Mr Sim", contact_number: "95556666",
    machines: [{ desc: "FERRIS IS2600Z Zero-Turn Mower", serial: "F1", remarks: "service" },
               { desc: "HUSQVARNA AM550 EPOS Robotic Automower", serial: "A1", remarks: "no charge" }],
    signature: sig,
  });
  const rdn = rd.slip_number;
  await data.slips.setMachineLabour(rd.machines[0].id, 250);
  await data.slips.setMachineLabour(rd.machines[1].id, 120);
  const rdq = await data.slips.quotationForSlip(rdn);
  check("the Ferris opens with A3", rdq.lines[0].item_code, "A3 SVR RIDE-ON EQUIPT");
  check("the Automower with A12",
    rdq.lines.filter((l) => !l.note)[1].item_code, "A12 SVR AUTOMOWER");
  await data.slips.createSlipOrder(rdn, rd.machines.map((m) => m.id));
  const rdLines = (await data.slips.getSlipOrder(rdn)).lines.filter((l) => l.item_code);
  check("and the Sales Order agrees, without anyone choosing",
    [rdLines[0].item_code, rdLines[1].item_code],
    ["A3 SVR RIDE-ON EQUIPT", "A12 SVR AUTOMOWER"]);

  console.log("\n-- a slip with nothing on it is refused, not quoted --");
  const empty = await data.slips.createSlip({
    company: "EMPTY", contact_name: "X", contact_number: "90000000",
    machines: [{ desc: "A machine", serial: "", remarks: "" }], signature: sig,
  });
  let msg = "";
  try { await data.slips.quotationForSlip(empty.slip_number); }
  catch (e) { msg = e.message; }
  check("it says so", msg, "No work recorded on this slip yet.");

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
