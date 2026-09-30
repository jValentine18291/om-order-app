// A MACHINE ON A SALES ORDER THAT IS NOT FINISHED.
// Run against a throwaway database, never the real one:
//
//   node tools/test-billed-unfinished.js C:/temp/scratch.db
//
// Slip 00080, 1 Oct 2026: its EBZ3000 - 3/5 went on SO-2609-033 on 22 Sep
// while still Quoted - allowed then - and was corrected to In Progress on 30
// Sep. Billed AND unfinished, it had no button anywhere to move it on: the
// machine sheet hid its row, "fully repaired" refused anything billed, and
// finishRepair() does too. Two more like it on the live book (00098, 00021).
//
// Two things are checked. The way on exists - "fully repaired" and Mark as
// repaired both take a billed, unfinished machine to Repaired. And the way in
// is closed - Correct status only offers a billed machine Repaired or
// Condemned, since under the rule from 30 Sep that is all it can be.
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
const db = require(path.resolve(__dirname, "..", "backend", "db"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const refuse = async (what, fn, re) => {
  let err = "";
  try { await fn(); } catch (e) { err = e.message; }
  const ok = re.test(err);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(err)}`);
};
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const stateOf = async (no, id) => (await data.slips.getSlip(no)).machines.find((m) => m.id === id).state;

// 00080's shape: billed (the way it was before 30 Sep), then left In Progress
// on a quote-first slip.
async function stuck(company) {
  const s = await data.slips.createSlip({
    company, contact_name: "A", contact_number: "1", signature: sig, quote_first: true,
    machines: [{ desc: "EBZ3000 - 3/5", serial: "E3" }],
  });
  const id = s.machines[0].id;
  await data.slips.setMachineLabour(id, 60);
  await data.slips.setMachineState(s.slip_number, id, "REPAIRED", "WJ");
  await data.slips.createSlipOrder(s.slip_number, [id], "KS");
  // What happened on 30 Sep, done directly: Correct status now refuses it.
  db.prepare("UPDATE slip_machines SET state = 'TO_REPAIR', quote_approved_at = '' WHERE id = ?").run(id);
  return { no: s.slip_number, id };
}

(async () => {
  console.log("-- a technician's Save - fully repaired --");
  const a = await stuck("SLIP 00080 SHAPE");
  check("billed and In Progress, as 00080 was", await stateOf(a.no, a.id), "TO_REPAIR");
  const r = await data.slips.saveMachineWork(a.id, "repaired", "WJ");
  check("goes to Repaired, quote-first slip or not - the order already exists",
    [r.moved, await stateOf(a.no, a.id)], [true, "REPAIRED"]);
  check("and can then be collected", (await data.slips.setMachineDisposal(a.no, a.id, "COLLECTED", "CY"))
    .machines[0].disposal, "COLLECTED");

  console.log("\n-- Sales' Mark as repaired --");
  const b = await stuck("SLIP 00098 SHAPE");
  await data.slips.setMachineState(b.no, b.id, "REPAIRED", "CY");
  check("the state route takes it to Repaired", await stateOf(b.no, b.id), "REPAIRED");

  console.log("\n-- the way in is closed: Correct status on a billed machine --");
  const c = await stuck("CORRECTED PTE LTD");
  await refuse("Quoted is refused, naming the order",
    () => data.slips.correctMachine(c.no, c.id, { state: "QUOTED", who: "J" }), /can only be Repaired or Condemned/);
  await refuse("so is Need Repair",
    () => data.slips.correctMachine(c.no, c.id, { state: "RECEIVED", who: "J" }), /can only be Repaired or Condemned/);
  await data.slips.correctMachine(c.no, c.id, { state: "REPAIRED", who: "J" });
  check("Repaired is allowed", await stateOf(c.no, c.id), "REPAIRED");

  console.log("\n-- an unbilled machine is corrected exactly as before --");
  const d = await data.slips.createSlip({
    company: "NOT BILLED PTE LTD", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410", serial: "N1" }],
  });
  await data.slips.correctMachine(d.slip_number, d.machines[0].id, { state: "TO_REPAIR", who: "J" });
  check("any state still allowed", await stateOf(d.slip_number, d.machines[0].id), "TO_REPAIR");

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
