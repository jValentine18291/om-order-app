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
