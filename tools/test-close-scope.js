// Which slips Close Service offers, and which it must not.
// Run against a throwaway database, never the real one:
//
//   node tools/test-machine-states.js C:/temp/scratch.db
//
// The path is REQUIRED and is checked against the live file. Without this, a
// forgotten argument sends db.js to backend/om_orders.db and these tests write
// test slips straight into the workshop's records.
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
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
let bad = 0;
const check = (what, got, want) => {
  const ok = got === want; if (!ok) bad++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${got}${ok ? "" : ` (expected ${want})`}`);
};
const make = async (company, descs) => data.slips.createSlip({
  company, contact_name: "x", contact_number: "1", signature: sig,
  machines: descs.map((d) => ({ desc: d })),
});
(async () => {
  const offered = async (no) =>
    (await data.slips.listSlips("repaired")).some((r) => r.slip_number === no);

  // A: everything billed - the ordinary case Close Service has always shown.
  let s = await make("A ALL BILLED", ["M1"]);
  await data.slips.setMachineLabour(s.machines[0].id, 50);
  await data.slips.createSlipOrder(s.slip_number, [s.machines[0].id]);
  check("everything billed is offered", await offered(s.slip_number), true);

  // B: one billed, one condemned and unaccounted for - nothing left to repair,
  // but it cannot close yet. It must still be FOUND, or staff hit a dead end.
  s = await make("B BLOCKED", ["M1", "M2"]);
  await data.slips.setMachineLabour(s.machines[0].id, 50);
  await data.slips.createSlipOrder(s.slip_number, [s.machines[0].id]);
  await data.slips.setMachineState(s.slip_number, s.machines[1].id, "CONDEMNED", "IR");
  check("blocked by a condemned machine is offered", await offered(s.slip_number), true);
  s = await data.slips.getSlip(s.slip_number);
  check("  and its status is honest", s.status, "IN_PROGRESS");

  // C: one billed, one still being repaired. This has ALWAYS been offered for
  // closing - ALL_REPAIRED has meant "partly converted" since long before this
  // change - so it is recorded here as existing behaviour, not endorsed.
  s = await make("C UNFINISHED", ["M1", "M2"]);
  await data.slips.setMachineLabour(s.machines[0].id, 50);
  await data.slips.createSlipOrder(s.slip_number, [s.machines[0].id]);
  check("part-billed slip still offered (unchanged)", await offered(s.slip_number), true);
  check("  and a machine on it is untouched", (await data.slips.getSlip(s.slip_number)).machines[1].state, "RECEIVED");

  // D: a slip whose only machine was condemned, nothing billed at all.
  s = await make("D CONDEMNED ONLY", ["M1"]);
  await data.slips.setMachineState(s.slip_number, s.machines[0].id, "CONDEMNED", "IR");
  check("condemned-only slip is offered", await offered(s.slip_number), true);
  await data.slips.setMachineDisposal(s.slip_number, s.machines[0].id, "COLLECTED", "JT");
  s = await data.slips.closeSlip(s.slip_number, "CS-1");
  check("  and closes once accounted for", s.status, "CLOSED");
  check("closed slips are not offered", await offered(s.slip_number), false);

  console.log(bad ? `\n${bad} FAILED\n` : "\nall passed\n");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("THREW:", e.message); process.exit(1); });
