// Whose status is the quoting — the machine's, or the slip's?
//
//   node tools/test-quote-statuses.js C:/temp/scratch.db
//
// WHAT CHANGED, AND WHY
// A slip used to take on the state of whichever machine was furthest from
// done. One machine sent for quoting and the WHOLE slip read "Need to Quote",
// even with three others on the bench being worked on. That is not what is
// happening to the slip - the slip is in progress - and it told the workshop a
// machine was blocked when it was not. John's call, Sep 2026: the slip stays
// In Progress until a Sales Order is raised.
//
// THE TRAP THIS GUARDS
// Sales find their work on the Need to Quote screen, and that screen used to
// ask "which slips have status NEED_QUOTE". Stop setting that status without
// changing the screen and it goes empty - Sales quietly stop being told there
// is anything to quote, and nothing anywhere says so. It now asks the
// machines, which is the truer question in any case.
//
// WHAT IS CHECKED
//  1. The slip reads In Progress through quoting, quoted, and the customer's
//     answer.
//  2. The Need to Quote screen still finds it, every step of the way.
//  3. The counts beside the status are right, because they are the only thing
//     left carrying the fact.
//  4. Raising a Sales Order still moves the slip on, exactly as before.
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const slip = data.slips.createSlip({
  company: "GREENSCAPE PTE LTD", contact_name: "Mr Tan", contact_number: "91234567",
  signature: SIG,
  machines: [
    { desc: "525BX Blower", serial: "A1", remarks: "" },
    { desc: "EBZ8500 Blower", serial: "B2", remarks: "" },
    { desc: "125B Blower", serial: "C3", remarks: "" },
  ],
});
const SLIP = slip.slip_number;
const m = data.slips.getSlip(SLIP).machines;
const [m1, m2, m3] = m.map((x) => x.id);

const statusOf = () => data.slips.getSlip(SLIP).status;
const counts = () => {
  const row = data.slips.listSlips("active").find((s) => s.slip_number === SLIP) || {};
  return [row.to_quote || 0, row.quote_waiting || 0];
};
const onQuoteScreen = () =>
  data.slips.listSlips("need_quote").some((s) => s.slip_number === SLIP);

// Something on each machine, or converting refuses them later.
for (const id of [m1, m2, m3]) data.slips.setMachineLabour(id, 40);

console.log("\n-- a technician sends one machine for quoting --");
data.slips.setMachineState(SLIP, m1, "AWAITING_QUOTE", "KM");
check("the machine is waiting to be quoted",
  data.slips.getSlip(SLIP).machines.find((x) => x.id === m1).state, "AWAITING_QUOTE");
// THE change. This used to be "NEED_QUOTE".
check("but the SLIP is just in progress", statusOf(), "IN_PROGRESS");
check("and Sales are still told about it", onQuoteScreen(), true);
check("with a count to show for it", counts(), [1, 0]);

console.log("\n-- a second machine joins it, the third is still on the bench --");
data.slips.setMachineState(SLIP, m2, "AWAITING_QUOTE", "KM");
check("still in progress", statusOf(), "IN_PROGRESS");
check("two to quote now", counts(), [2, 0]);

console.log("\n-- Sales quote them --");
data.slips.setMachineState(SLIP, m1, "QUOTED", "KS");
data.slips.setMachineState(SLIP, m2, "QUOTED", "KS");
check("the slip has not moved", statusOf(), "IN_PROGRESS");
check("nothing left to quote, two waiting on the customer", counts(), [0, 2]);
// Nothing is waiting on Sales any more, so it comes off their screen.
check("and it leaves the Need to Quote screen", onQuoteScreen(), false);

console.log("\n-- the customer answers: one repair, one condemned --");
data.slips.setMachineState(SLIP, m1, "TO_REPAIR", "KS");
data.slips.setMachineState(SLIP, m2, "CONDEMNED", "KS");
check("STILL in progress, which is the whole point", statusOf(), "IN_PROGRESS");
check("and the counts are clear", counts(), [0, 0]);

console.log("\n-- and a Sales Order moves it on, as it always did --");
data.slips.finishRepair(m1, "KM");
data.slips.finishRepair(m3, "KM");
const so = data.slips.createSlipOrder(SLIP, [m1, m3], {});
check("two machines billed", so.machines_converted.length, 2);
// The condemned one is still in the building, so there is work outstanding.
check("the slip moves off In Progress once something is billed",
  statusOf() !== "IN_PROGRESS", true);
check("it is a part-order state", ["PART_SO", "ALL_REPAIRED"].includes(statusOf()), true);

console.log("\n-- a machine sent back for quoting after an order does not undo that --");
// The order exists. A late quote request must not drag the slip back to
// looking untouched, or sales lose the order they have already raised.
data.slips.setMachineState(SLIP, m2, "AWAITING_QUOTE", "KS");
check("still reads as having an order", ["PART_SO", "ALL_REPAIRED"].includes(statusOf()), true);
check("but Sales are told about the machine", onQuoteScreen(), true);
check("and the count says so", counts(), [1, 0]);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
