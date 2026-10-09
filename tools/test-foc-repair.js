// FREE OF CHARGE REPAIRS. Run against a throwaway database:
//
//   node tools/test-foc-repair.js C:/temp/scratch.db
//
// John, 9 Oct 2026: some repairs are FOC. A technician may mark a machine
// fully repaired with no parts and no labour once they confirm it is free of
// charge, and it can still go on a Sales Order, which says "*No servicing
// (FOC)" with the usual machine details. A machine with only a note, still $0,
// is asked the same and its order says "*FOC" under the note.
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
async function refused(what, fn, like) {
  try { await fn(); check(what, "allowed", "refused"); }
  catch (e) { check(what, like.test(e.message) ? "refused" : e.message, "refused"); }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const notes = async (so) => (await data.orders.getOrder(so)).lines
  .map((l) => l.description).filter((d) => /^\*/.test(d || ""));

(async () => {
  console.log("-- nothing recorded --");
  const s = await data.slips.createSlip({ company: "FOC", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "525BX - 1/2" }, { desc: "HBZ260 - 2/2" }] });
  const [a, b] = s.machines.map((m) => m.id);
  await refused("plain fully repaired is still refused",
    () => data.slips.saveMachineWork(a, "repaired", "WJ"), /Nothing has been recorded/);
  const r = await data.slips.saveMachineWork(a, "repaired", "WJ", { foc: true });
  check("FOC: marked repaired", [r.state, r.moved], ["REPAIRED", true]);
  check("and marked free of charge", r.slip.machines.find((m) => m.id === a).foc, 1);
  const so = await data.slips.createSlipOrder(s.slip_number, [a], "WJ");
  check("it goes on an SO", !!so.so_number, true);
  check("which says so", await notes(so.so_number), ["*No servicing (FOC)"]);
  check("at $0", (await data.orders.getOrder(so.so_number)).total_amount, 0);
  const lines = (await data.orders.getOrder(so.so_number)).lines.map((l) => l.description);
  check("with the usual machine details", lines.some((d) => /525BX.*S\/S: 0*\d+ - 1\/2/.test(d || "")), true);

  console.log("\n-- a note, still $0 --");
  await data.slips.setMachineComment(b, "Checked, no fault found");
  const r2 = await data.slips.saveMachineWork(b, "repaired", "WJ", { foc: true });
  check("FOC with a note: repaired", r2.state, "REPAIRED");
  const so2 = await data.slips.createSlipOrder(s.slip_number, [b], "WJ");
  check("the note, then *FOC", await notes(so2.so_number), ["*Checked, no fault found", "*FOC"]);

  console.log("\n-- not free --");
  const t = await data.slips.createSlip({ company: "PAID", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "M1 - 1/1" }] });
  const [c] = t.machines.map((m) => m.id);
  await data.slips.setMachineLabour(c, 20);
  await refused("a machine with a charge cannot be FOC",
    () => data.slips.saveMachineWork(c, "repaired", "WJ", { foc: true }), /has a charge on it/);
  await data.slips.saveMachineWork(c, "repaired", "WJ");
  const so3 = await data.slips.createSlipOrder(t.slip_number, [c], "WJ");
  check("an ordinary SO says nothing about FOC", await notes(so3.so_number), []);

  console.log("\n-- FOC, then work added after all --");
  const u = await data.slips.createSlip({ company: "CHANGED", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "M2 - 1/1" }] });
  const [d] = u.machines.map((m) => m.id);
  await data.slips.saveMachineWork(d, "repaired", "WJ", { foc: true });
  await data.slips.setMachineState(u.slip_number, d, "TO_REPAIR", "KS");
  await data.slips.setMachineLabour(d, 15);
  await data.slips.saveMachineWork(d, "repaired", "WJ");
  check("a plain save clears FOC", (await data.slips.getSlip(u.slip_number)).machines[0].foc, 0);
  const so4 = await data.slips.createSlipOrder(u.slip_number, [d], "WJ");
  check("and the SO charges it, with no FOC line", [await notes(so4.so_number), (await data.orders.getOrder(so4.so_number)).total_amount], [[], 15]);

  console.log("\n-- put back to the start --");
  const v = await data.slips.createSlip({ company: "UNDO", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "M3 - 1/1" }] });
  const [e] = v.machines.map((m) => m.id);
  await data.slips.saveMachineWork(e, "repaired", "WJ", { foc: true });
  await data.slips.undoMachineDecision(v.slip_number, e, "KS");
  check("undoing it clears FOC", (await data.slips.getSlip(v.slip_number)).machines[0].foc, 0);
  await refused("and an empty machine cannot then go on an SO",
    () => data.slips.createSlipOrder(v.slip_number, [e], "KS"), /Not finished|No work recorded/);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
