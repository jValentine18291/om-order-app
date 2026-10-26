// WHO WORKED ON EACH SLIP. Run against a throwaway database, never the real one:
//
//   node tools/test-slip-technicians.js C:/temp/scratch.db
//
// John, 26 Oct 2026: View Slips filters by technician, and every row shows
// the initials of who worked on it. "Worked on" is any part a technician
// added (on a machine or on the slip itself) or any step they saved. Checked:
// each kind counts, a slip two shared lists both, a non-technician's
// initials do not, and a slip nobody has touched has none.
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
const db = require(path.resolve(__dirname, "..", "backend", "db.js"));
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// Four slips with a machine each, made straight in the tables: what is under
// test is the reading, not the writing.
db.exec("DELETE FROM machine_parts; DELETE FROM machine_status_history; DELETE FROM slip_machines; DELETE FROM service_slips;");
const slip = (n) => db.prepare(
  "INSERT INTO service_slips (slip_number, company, status) VALUES (?, ?, 'IN_PROGRESS')"
).run(n, `Company ${n}`).lastInsertRowid;
const machine = (slipId) => db.prepare(
  "INSERT INTO slip_machines (slip_id, machine_desc, state) VALUES (?, 'BK3410', 'RECEIVED')"
).run(slipId).lastInsertRowid;
const part = (who, { machineId = null, slipId = null } = {}) => db.prepare(
  "INSERT INTO machine_parts (machine_id, slip_id, item_code, description, quantity, technician) VALUES (?, ?, 'SZEN 140051111', 'Shoe', 1, ?)"
).run(machineId, slipId, who);
const step = (machineId, who) => db.prepare(
  "UPDATE slip_machines SET state = 'REPAIRED', decided_by = ? WHERE id = ?"
).run(who, machineId);

const s1 = slip("90001"); const m1 = machine(s1); part("WJ", { machineId: m1 });
const s2 = slip("90002"); const m2 = machine(s2); part("KM", { machineId: m2 }); step(m2, "XL");
const s3 = slip("90003"); machine(s3); part("R", { slipId: s3 }); part("J", { slipId: s3 });
const s4 = slip("90004"); machine(s4);

const res = data.slips.searchSlips("900", "all", 20);
const by = Object.fromEntries(res.results.map((r) => [r.slip_number, r.techs]));
check("a part on a machine", by["90001"], ["WJ"]);
check("a part and a saved step, two technicians, both listed in order", by["90002"], ["KM", "XL"]);
check("a slip-level part counts; John's initials do not", by["90003"], ["R"]);
check("nobody has worked on it", by["90004"], []);

const cs = data.slips.searchSlips("", "active", 20);
check("every list carries it", cs.results.every((r) => Array.isArray(r.techs)), true);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
