// Sending a quotation for some of the machines on a slip.
//
//   node tools/test-quote-machines.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// John asked for it in September 2026: a customer brings four machines in and
// wants a price for two of them now. Until then a quotation was the whole
// slip, every machine with work recorded on it, with no way to say otherwise.
//
// WHAT IS CHECKED, worst consequence first
//  1. A quotation nobody narrowed is EXACTLY what it was before this existed.
//     A change here would alter documents already going out daily, silently.
//  2. A narrowed quotation prices only what was chosen - no line, no sub-total
//     and no penny of a machine the customer did not ask about.
//  3. A machine keeps its place on the SLIP. Quoting the third of four reads
//     "3/4", because the customer matches this against a slip they were given.
//  4. What the picker offers and what the quotation accepts are the same set,
//     so a machine cannot be ticked and then quietly dropped, or dropped and
//     then quietly quoted.
//  5. Choosing nothing is refused, and says which of the two problems it is.
//  6. A quotation for a different set of machines is a different document and
//     gets its own number; the same set again does not.
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
async function throws(what, fn, wantMessage) {
  try {
    await fn();
    failures++;
    console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = !wantMessage || e.message === wantMessage;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${e.message}`);
  }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  // Four machines: two ordinary, one condemned, one nobody has touched.
  const slip = await data.slips.createSlip({
    company: "FOUR MACHINE PTE LTD", debtor_code: "300-F001",
    contact_name: "Mr Lim", contact_number: "91234567",
    machines: [
      { desc: "525LK Combi Trimmer", serial: "A1", remarks: "no start" },
      { desc: "EBZ5100 Backpack Blower", serial: "B2", remarks: "service" },
      { desc: "K770 Power Cutter", serial: "C3", remarks: "smoking" },
      { desc: "PHT1500 Long reach Trimmer", serial: "D4", remarks: "not looked at yet" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const [trimmer, blower, cutter, untouched] = slip.machines;

  await data.slips.setMachineLabour(trimmer.id, 50);
  await data.slips.addPartToMachine(trimmer.id, {
    item_code: "A8 SPARE PARTS", description: "Spool", uom: "PC", unit_price: 20, quantity: 1, technician: "KS" });
  // Trimmer: 50 + 20 = 70

  await data.slips.setMachineLabour(blower.id, 30);
  await data.slips.addPartToMachine(blower.id, {
    item_code: "A8 SPARE PARTS", description: "Filter", uom: "PC", unit_price: 5, quantity: 2, technician: "KS" });
  // Blower: 30 + 10 = 40

  // Condemned, and priced at nothing however much was scanned onto it first.
  await data.slips.setMachineLabour(cutter.id, 99);
  await data.slips.addPartToMachine(cutter.id, {
    item_code: "A8 SPARE PARTS", description: "Belt", uom: "PC", unit_price: 44, quantity: 1, technician: "KS" });
  await data.slips.setMachineState(no, cutter.id, "CONDEMNED", "KS");
  // Cutter: 0

  console.log("-- rule 4: what the picker is offered --");
  const q = await data.slips.quotationForSlip(no);
  check("three machines, not the one nobody has touched",
    q.machines_available.map((m) => m.machine_desc),
    ["525LK Combi Trimmer", "EBZ5100 Backpack Blower", "K770 Power Cutter"]);
  check("each with what it comes to", q.machines_available.map((m) => m.amount), [70, 40, 0]);
  check("the condemned one is marked as such, and quoted at nothing",
    q.machines_available.filter((m) => m.condemned).map((m) => [m.machine_desc, m.amount]),
    [["K770 Power Cutter", 0]]);
  // Its place on the SLIP, so three identical blowers can be told apart on the
  // picker. Counted over every machine, not over this list - the list holds
  // only what can be quoted, and the customer is holding a slip of four.
  check("each carries its position on the slip, not in this list",
    q.machines_available.map((m) => [m.position, m.of]), [[1, 4], [2, 4], [3, 4]]);
  check("their parts and labour, for the line under each name",
    q.machines_available.map((m) => [m.parts, m.labour]), [[1, 50], [1, 30], [0, 0]]);
  check("and what this quotation actually covers",
    q.machines_included, [trimmer.id, blower.id, cutter.id]);

  console.log("\n-- rule 1: a quotation nobody narrowed is the whole slip --");
  check("subtotal is every machine with work on it", q.subtotal, 110);
  check("one SubTotal per machine quoted",
    q.lines.filter((l) => l.description === "SubTotal").length, 3);
  // The same call with an explicit "all of them" has to come out identically,
  // because that is what the screen now sends on a sheet nobody touched.
  const explicit = await data.slips.quotationForSlip(no, [trimmer.id, blower.id, cutter.id]);
  check("and ticking all of them by hand is the same document",
    explicit.lines, q.lines);

  console.log("\n-- rule 2: narrowed to one machine --");
  const one = await data.slips.quotationForSlip(no, [blower.id]);
  check("only that machine's block", one.lines.filter((l) => l.description === "SubTotal").length, 1);
  check("only its money", [one.subtotal, one.gst, one.total], [40, 3.6, 43.6]);
  check("the other machine's part is nowhere on it",
    one.lines.some((l) => l.description === "Spool"), false);
  check("nor its labour", one.lines.filter((l) => l.uom === "NOS").map((l) => l.unit_price), [30]);
  check("but the customer's contact is still the last line",
    one.lines[one.lines.length - 1].description, "Mr Lim 9123 4567");

  console.log("\n-- rule 3: a machine keeps its place on the SLIP --");
  // The customer is holding a service slip with four machines on it. A
  // quotation for the second must say 2/4, not 1/1, or the two documents
  // cannot be laid side by side.
  const second = one.lines.find((l) => l.note && String(l.description).includes("S/S:"));
  check("the blower is still 2 of 4", second.description.endsWith(" - 2/4"), true);
  check("and says what the machine is, not just its model",
    second.description.startsWith("EBZ5100 Backpack Blower"), true);
  const third = (await data.slips.quotationForSlip(no, [cutter.id]))
    .lines.find((l) => l.note && String(l.description).includes("S/S:"));
  check("quoting the third alone reads 3/4", third.description.endsWith(" - 3/4"), true);

  console.log("\n-- rule 4 again: nothing can be quoted that was not offered --");
  // Asking for the machine nobody has worked on gets an empty quotation, not
  // a block with no lines in it. The picker never offers it; this is what
  // happens if something else asks.
  await throws("a machine with no work recorded cannot be forced on",
    () => data.slips.quotationForSlip(no, [untouched.id]),
    "Nothing chosen for this quotation.");
  const mixed = await data.slips.quotationForSlip(no, [blower.id, untouched.id]);
  check("and asking for it alongside a real one quotes only the real one",
    mixed.subtotal, 40);
  // A machine from somebody else's slip is not on this one and cannot join it.
  const other = await data.slips.createSlip({
    company: "SOMEBODY ELSE PTE LTD", contact_name: "Mr Tan", contact_number: "98887777",
    machines: [{ desc: "Husqvarna 545 Chainsaw", serial: "X9", remarks: "service" }], signature: sig,
  });
  await data.slips.setMachineLabour(other.machines[0].id, 500);
  const notOurs = await data.slips.quotationForSlip(no, [blower.id, other.machines[0].id]);
  check("another slip's machine cannot be quoted onto this one", notOurs.subtotal, 40);

  console.log("\n-- rule 5: choosing nothing --");
  await throws("no machines and no extras is refused",
    () => data.slips.quotationForSlip(no, [untouched.id], { extras: false }),
    "Nothing chosen for this quotation.");
  // And the OTHER message still belongs to the other problem - a slip nobody
  // has worked on at all, which is not the same mistake and must not read as
  // though somebody forgot to tick something.
  const bare = await data.slips.createSlip({
    company: "NOTHING DONE YET PTE LTD", contact_name: "Mr Goh", contact_number: "90001111",
    machines: [{ desc: "525BX Blower", serial: "Z1", remarks: "in" }], signature: sig,
  });
  await throws("an untouched slip still says so in its own words",
    () => data.slips.quotationForSlip(bare.slip_number),
    "No work recorded on this slip yet.");

  console.log("\n-- the slip's own parts sit alongside the choice --");
  data.slips.addPartToSlip(no, {
    item_code: "A8 SPARE PARTS", description: "2T Oil", uom: "BTL",
    unit_price: 12, quantity: 2, technician: "KS" });
  const withExtras = await data.slips.quotationForSlip(no, [blower.id]);
  check("one machine plus the loose parts", withExtras.subtotal, 64);
  // The sheet is opened from View Slips as often as from the slip itself, and
  // there the browser has no copy of the parts to add up. The figure beside
  // the tick, and the running total under it, come from here or from nowhere.
  check("and what they come to travels with the quotation", withExtras.extras_total, 24);
  check("extras can be left off independently of the machines",
    (await data.slips.quotationForSlip(no, [blower.id], { extras: false })).subtotal, 40);
  check("and the loose parts alone are a quotation in their own right",
    (await data.slips.quotationForSlip(no, [untouched.id])).subtotal, 24);

  console.log("\n-- rule 6: a different set is a different document --");
  const T = { payment: "30 Days", delivery: "Ex-Singapore", who: "Chiu Yan" };
  const all = await data.slips.issueQuotation(no, { ...T });
  check("the first one is named after the slip", all.quotation_no, "QT-" + no);
  check("and is not a revision", all.revision, false);
  const same = await data.slips.issueQuotation(no, { ...T });
  check("sending the same thing again keeps its number", same.quotation_no, "QT-" + no);
  check("because a re-send is a re-send", same.revision, false);

  const justBlower = await data.slips.issueQuotation(no, { ...T, machines: [blower.id] });
  check("a quotation for one machine earns its own number",
    justBlower.quotation_no, "QT-" + no + "-2");
  check("and is marked as the second document for this slip", justBlower.revision, true);
  check("priced at that machine and the loose parts", justBlower.total, 69.76);
  const blowerAgain = await data.slips.issueQuotation(no, { ...T, machines: [blower.id] });
  check("sending THAT one again does not raise the number either",
    [blowerAgain.quotation_no, blowerAgain.revision], ["QT-" + no + "-2", false]);

  console.log("\n-- and none of it moves the slip on --");
  const after = await data.slips.getSlip(no);
  check("no machine has been marked converted",
    (after.machines || []).every((m) => !m.converted_at), true);
  check("and no Sales Order has appeared", await data.slips.getSlipOrder(no), null);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
