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
  // Partial SO, not In Progress: one of the two IS on an order, and saying so
  // is what lets sales find it to record that order's document.
  check("  and its status is honest", s.status, "PART_SO");

  // C: one billed, one still being repaired. This has ALWAYS been offered for
  // closing - ALL_REPAIRED has meant "partly converted" since long before this
  // change - so it is recorded here as existing behaviour, not endorsed.
  s = await make("C UNFINISHED", ["M1", "M2"]);
  await data.slips.setMachineLabour(s.machines[0].id, 50);
  await data.slips.createSlipOrder(s.slip_number, [s.machines[0].id]);
  check("part-billed slip still offered (unchanged)", await offered(s.slip_number), true);
  check("  and a machine on it is untouched", (await data.slips.getSlip(s.slip_number)).machines[1].state, "RECEIVED");

  // D: a slip whose only machine was condemned, nothing billed at all.
  //
  // This is the one slip that reaches the end with NO order on it - there was
  // nothing to charge for. Closing must not ask it for an invoice number it
  // can never have, or the slip stays open for good with no way out.
  s = await make("D CONDEMNED ONLY", ["M1"]);
  await data.slips.setMachineState(s.slip_number, s.machines[0].id, "CONDEMNED", "IR");
  check("condemned-only slip is offered", await offered(s.slip_number), true);
  await data.slips.setMachineDisposal(s.slip_number, s.machines[0].id, "COLLECTED", "JT");
  s = await data.slips.closeSlip(s.slip_number, "CS-1");
  check("  and closes once accounted for", s.status, "CLOSED");
  check("closed slips are not offered", await offered(s.slip_number), false);

  // Same again with no reference typed at all, which is the honest version of
  // it: there is no document, so there is no number to record.
  s = await make("E CONDEMNED ONLY, NO REF", ["M1"]);
  await data.slips.setMachineState(s.slip_number, s.machines[0].id, "CONDEMNED", "IR");
  await data.slips.setMachineDisposal(s.slip_number, s.machines[0].id, "DISPOSED", "JT");
  s = await data.slips.closeSlip(s.slip_number, "");
  check("an unbilled slip closes with no document number", s.status, "CLOSED");

  // But the moment something IS billed, both steps come back.
  s = await make("F BILLED, NOT INVOICED", ["M1"]);
  await data.slips.setMachineLabour(s.machines[0].id, 50);
  await data.slips.createSlipOrder(s.slip_number, [s.machines[0].id]);
  let refused = "";
  try { await data.slips.closeSlip(s.slip_number, ""); }
  catch (e) { refused = e.message; }
  check("a billed slip still has to be invoiced first",
    /invoiced/i.test(refused), true);

  console.log(bad ? `\n${bad} FAILED\n` : "\nall passed\n");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("THREW:", e.message); process.exit(1); });
