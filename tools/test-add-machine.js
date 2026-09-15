// A machine added to a slip that is already registered.
//
//   node tools/test-add-machine.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// The counter writes a slip with the machines in front of them, the customer
// signs it, and then a third machine comes out of the van. Before this, the
// only way to record it was a second slip - or a quiet edit that renamed a
// machine into a different one and lost the first.
//
// THE RULES IT GUARDS
//  1. An added machine is on the slip, and on everything built from the slip:
//     the Quotation and the Sales Order both have to see it, or the customer
//     is quoted for a repair they are then invoiced twice for.
//  2. The customer's signature is untouched. The slip changed; what they put
//     their name to did not, and the amendment log is what says so.
//  3. The "- 1/3" tails stay honest. They are how five machines on one slip
//     are told apart on the workshop floor, and a slip reading "1/2, 2/2, 3/3"
//     is worse than one with no numbers at all.
//  4. A closed slip is refused - the same bar as editing one.
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
async function refuses(what, fn, status) {
  let got = "no error";
  try { await fn(); } catch (e) { got = e.status || e.message; }
  check(what, got, status);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const descs = (slip) => (slip.machines || []).map((m) => m.machine_desc);

(async () => {
  // Registered the way the counter registers one: two machines, so the tails
  // are already there and have to move when a third arrives.
  const slip = await data.slips.createSlip({
    company: "ATL MAINTENANCE PTE LTD", debtor_code: "300-A001",
    contact_name: "Mr Tariqul", contact_number: "97293454",
    machines: [
      { desc: "HB2302 - 1/2", serial: "H1", remarks: "no start" },
      { desc: "PHT1500 - 2/2", serial: "P9", remarks: "service" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;

  console.log("-- the machine that was in the van --");
  const after = await data.slips.addMachineToSlip(no, {
    desc: "EBZ5100", serial: "E7", remarks: "blows weak",
  }, "JT");
  check("it is on the slip", (after.machines || []).length, 3);
  const added = (after.machines || [])[2];
  check("with what was typed about it",
    [added.serial_no, added.remarks, added.state], ["E7", "blows weak", "RECEIVED"]);
  check("and it came back as an id, so the caller can point at it",
    after.added_machine_ids.length, 1);

  console.log("\n-- the numbers move, and no machine's own number moves --");
  // The whole reason appending is safe: 1 stays 1, 2 stays 2, only the total
  // changes. A customer holding a slip that says "1/2" still has machine 1.
  check("the tails are renumbered across the slip",
    descs(after), ["HB2302 - 1/3", "PHT1500 - 2/3", "EBZ5100 - 3/3"]);

  console.log("\n-- what the customer signed is untouched --");
  const s = await data.slips.getSlipSignature(no);
  check("their copy still lists the two they signed for",
    s.signed_content.machines.map((m) => m.machine_desc), ["HB2302 - 1/2", "PHT1500 - 2/2"]);
  check("and the signature itself is the same image", s.signature, sig);

  console.log("\n-- and the slip says a machine was added --");
  const amend = (await data.slips.getSlip(no, true)).amendments || [];
  const rows = amend.filter((a) => a.field === "Machine added");
  check("one line, in those words", rows.length, 1);
  check("naming the machine, and who added it",
    [rows[0].after, rows[0].changed_by], ["EBZ5100", "JT"]);
  check("with nothing in the before column, because there was nothing there",
    rows[0].before, "");

  console.log("\n-- it is billable work like any other --");
  await data.slips.setMachineLabour(added.id, 45);
  await data.slips.addPartToMachine(added.id, {
    item_code: "A8 SPARE PARTS", description: "Impeller", uom: "PC",
    unit_price: 22.50, quantity: 1, technician: "KS" });

  const q = await data.slips.quotationForSlip(no, [added.id]);
  check("the quotation names it, with its type spelled out and its place on the slip",
    q.lines.some((l) => l.description === `EBZ5100 Backpack Blower, S/N: E7, S/S: ${no} (KS) - 3/3`), true);
  check("and carries its labour", q.lines.some((l) => l.unit_price === 45), true);
  check("and its part", q.lines.some((l) => l.description === "Impeller"), true);

  // The one that matters: the customer approves the quotation, then the order
  // is raised from the same slip. If the two disagreed about the machine that
  // was added, they would be billed for a repair they never approved.
  await data.slips.createSlipOrder(no, [added.id]);
  const so = await data.slips.getSlipOrder(no);
  check("and the Sales Order says exactly the same thing",
    (so.lines || []).map((l) => l.description), q.lines.map((l) => l.description));

  console.log("\n-- a slip with one machine gains tails; nothing is left at 1/1 --");
  const solo = await data.slips.createSlip({
    company: "ONE MACHINE PTE LTD",
    machines: [{ desc: "120i", serial: "", remarks: "" }],
    signature: sig,
  });
  check("registered with no tail", descs(solo), ["120i"]);
  const two = await data.slips.addMachineToSlip(solo.slip_number, { desc: "525BX" }, "JT");
  check("both get one once there are two", descs(two), ["120i - 1/2", "525BX - 2/2"]);

  console.log("\n-- several of the same model, the way the counter adds them --");
  const three = await data.slips.addMachineToSlip(solo.slip_number, { desc: "BK3410", qty: 3 }, "JT");
  check("three separate machines, numbered",
    descs(three).slice(2), ["BK3410 - 3/5", "BK3410 - 4/5", "BK3410 - 5/5"]);
  check("and one amendment line for the lot, not three",
    ((await data.slips.getSlip(solo.slip_number, true)).amendments || [])
      .filter((a) => a.field === "Machine added").map((a) => a.after),
    ["525BX", "BK3410 \u00d73"]);

  console.log("\n-- what it refuses --");
  await refuses("a machine with no name", () => data.slips.addMachineToSlip(no, { desc: "  " }), 400);
  await refuses("a slip that does not exist",
    () => data.slips.addMachineToSlip("99999", { desc: "EBZ5100" }), 404);

  // The same bar as editing: a closed slip is a finished record. Taken all the
  // way through on a slip of its own - repaired, ordered, invoiced, collected -
  // because that is the only way a slip legitimately reaches CLOSED.
  const done = await data.slips.createSlip({
    company: "FINISHED PTE LTD", machines: [{ desc: "345BT" }], signature: sig,
  });
  await data.slips.setMachineLabour(done.machines[0].id, 30);
  await data.slips.createSlipOrder(done.slip_number, [done.machines[0].id]);
  await data.slips.setSlipInvoiced(done.slip_number, "INV-9001", "JT");
  await data.slips.closeSlip(done.slip_number, "DO-9001", "JT");
  check("that slip is closed", (await data.slips.getSlip(done.slip_number)).status, "CLOSED");
  await refuses("a closed slip",
    () => data.slips.addMachineToSlip(done.slip_number, { desc: "EBZ5100" }), 409);
  check("and nothing was added to it",
    (await data.slips.getSlip(done.slip_number)).machines.length, 1);

  console.log("\n-- but a slip already billed is not closed, and still takes one --");
  // A machine that turns up after the invoice still turns up. Refusing it
  // would not make it go away, it would just leave it unrecorded.
  const billed = await data.slips.createSlip({
    company: "ALREADY BILLED PTE LTD", machines: [{ desc: "531RB" }], signature: sig,
  });
  await data.slips.setMachineLabour(billed.machines[0].id, 30);
  await data.slips.createSlipOrder(billed.slip_number, [billed.machines[0].id]);
  await data.slips.setSlipInvoiced(billed.slip_number, "INV-9002", "JT");
  const late = await data.slips.addMachineToSlip(billed.slip_number, { desc: "125B" }, "JT");
  check("the machine is on it", descs(late), ["531RB - 1/2", "125B - 2/2"]);

  // The slip still says INVOICED, and that is correct - somebody raised a real
  // invoice and the app does not get to un-say it. What must not happen is the
  // machine going missing behind that word, which is slip 00007 exactly. The
  // workshop list asks the MACHINES, not the status, so it comes back.
  check("the status still records the invoice that was raised", late.status, "INVOICED");
  const working = await data.slips.listSlips("working");
  check("and the workshop sees the slip again",
    working.some((s) => s.slip_number === billed.slip_number), true);

  console.log("\n-- an unsigned slip is recorded quietly --");
  // Nothing to depart from, so nothing to report - the same rule the edit
  // screen follows. The machine still lands.
  const unsigned = await data.slips.createSlip({
    company: "NO SIGNATURE PTE LTD",
    machines: [{ desc: "EB6200" }],
    signature: sig,
  });
  // Take the signature away to stand in for the slips that predate it.
  require(path.resolve(__dirname, "..", "backend", "db.js"))
    .prepare("DELETE FROM slip_signatures WHERE slip_id = (SELECT id FROM service_slips WHERE slip_number = ?)")
    .run(unsigned.slip_number);
  const u = await data.slips.addMachineToSlip(unsigned.slip_number, { desc: "HBZ260" }, "JT");
  check("the machine is on it", descs(u), ["EB6200 - 1/2", "HBZ260 - 2/2"]);
  check("and no amendment was written",
    ((await data.slips.getSlip(unsigned.slip_number, true)).amendments || []).length, 0);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
