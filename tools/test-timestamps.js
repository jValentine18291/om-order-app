// Every timestamp in local time, and the one-off that got them there.
//
//   node tools/test-timestamps.js C:/temp/scratch.db
//
// WHERE THIS CAME FROM
// Half the schema stored UTC and half stored local time. Nobody noticed until a
// Sales Order's created_at was held against its own slip's and came out eight
// hours apart. The display made it worse: formatDate() reads the date straight
// off the stored string with no conversion, so a UTC timestamp SHOWED its UTC
// date - anything recorded before 08:00 in Singapore would have printed the day
// before, on the slip and on the customer's quotation.
//
// THE RULE THIS GUARDS
// A migration that SHIFTS values cannot be written to be safely re-runnable the
// way the rest of them are: shifted data is indistinguishable from data that was
// always right, so a second run shifts it twice and nothing can tell afterwards.
// It is guarded by a marker row instead, and the marker is the thing worth
// testing - far more than the shift itself.
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

const fs = require("fs");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(target + suffix); } catch (_) {}
}

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const db = require(path.resolve(__dirname, "..", "backend", "db.js"));

// How far local time is from UTC on this machine, in minutes.
const { mins } = db.prepare(
  "SELECT ROUND((julianday(datetime('now','localtime')) - julianday(datetime('now'))) * 1440) AS mins"
).get();
const OFFSET = Number(mins);

console.log("-- a brand-new database has nothing to convert --");
// The first version of this migration got this wrong. A new database is created
// with the local-time defaults and then seeded; the migration then found those
// freshly-written LOCAL rows, could not tell them from old UTC ones, and shifted
// them eight hours into the future. It now asks whether the database already
// existed before deciding.
const marker = db.prepare("SELECT key, value FROM schema_meta WHERE key = 'timestamps-to-localtime'").get();
check("the migration recorded itself", !!marker, true);
check("and says it had nothing to convert",
  /nothing to convert/.test((marker || {}).value || ""), true);
const seeded = db.prepare(
  "SELECT ROUND((julianday(created_at) - julianday(datetime('now','localtime'))) * 1440) AS d FROM items LIMIT 1"
).get();
check("the seeded rows were NOT shifted into the future",
  seeded ? Math.abs(seeded.d) <= 1 : true, true);

console.log("\n-- a fresh database writes local time everywhere --");
// Written through the schema defaults, then compared with the clock. If a
// default were still datetime('now') this lands an offset away.
db.prepare("INSERT INTO items (item_code, description) VALUES ('T1', 'test')").run();
db.prepare("INSERT INTO orders (so_number) VALUES ('SO-TEST-1')").run();
db.prepare("INSERT INTO service_slips (slip_number, company) VALUES ('99001', 'TEST')").run();
const slipId = db.prepare("SELECT id FROM service_slips WHERE slip_number = '99001'").get().id;
db.prepare("INSERT INTO slip_signatures (slip_id, image) VALUES (?, 'x')").run(slipId);

const drift = (table, col, where) => db.prepare(
  `SELECT ROUND((julianday(${col}) - julianday(datetime('now','localtime'))) * 1440) AS d
     FROM ${table} WHERE ${where}`
).get().d;

for (const [table, col, where] of [
  ["items", "created_at", "item_code = 'T1'"],
  ["orders", "created_at", "so_number = 'SO-TEST-1'"],
  ["service_slips", "created_at", "slip_number = '99001'"],
  ["slip_signatures", "signed_at", `slip_id = ${slipId}`],
]) {
  // Within a minute of the local clock; an unconverted default would be OFFSET out.
  check(`${table}.${col} is local`, Math.abs(drift(table, col, where)) <= 1, true);
}

console.log("\n-- and so do the two that are written by hand --");
db.prepare("INSERT INTO slip_machines (slip_id, machine_desc) VALUES (?, 'TEST MACHINE')").run(slipId);
const mId = db.prepare("SELECT id FROM slip_machines WHERE slip_id = ?").get(slipId).id;
db.prepare("UPDATE slip_machines SET converted_at = datetime('now','localtime') WHERE id = ?").run(mId);
db.prepare("UPDATE service_slips SET closed_at = datetime('now','localtime') WHERE id = ?").run(slipId);
check("slip_machines.converted_at is local",
  Math.abs(drift("slip_machines", "converted_at", `id = ${mId}`)) <= 1, true);
check("service_slips.closed_at is local",
  Math.abs(drift("service_slips", "closed_at", `id = ${slipId}`)) <= 1, true);

console.log("\n-- a Sales Order and its slip now agree --");
// The comparison that started this: they used to come out OFFSET apart.
const gap = db.prepare(
  `SELECT ROUND((julianday(o.created_at) - julianday(s.created_at)) * 1440) AS d
     FROM orders o, service_slips s WHERE o.so_number = 'SO-TEST-1' AND s.slip_number = '99001'`
).get().d;
check("within a minute of each other, not " + (OFFSET / 60) + " hours", Math.abs(gap) <= 1, true);

console.log("\n-- the migration will not run a second time --");
// The real risk. Re-running the module must not shift anything again, because
// shifted data cannot be told from data that was always right.
const before = db.prepare("SELECT created_at FROM service_slips WHERE slip_number = '99001'").get().created_at;
delete require.cache[require.resolve(path.resolve(__dirname, "..", "backend", "db.js"))];
require(path.resolve(__dirname, "..", "backend", "db.js"));
const after = db.prepare("SELECT created_at FROM service_slips WHERE slip_number = '99001'").get().created_at;
check("the timestamp is untouched by a second load", after, before);
check("and there is still exactly one marker",
  db.prepare("SELECT COUNT(*) AS n FROM schema_meta WHERE key = 'timestamps-to-localtime'").get().n, 1);

console.log("\n-- what it does to a database that still holds UTC --");
// Stand in for a real server: put a UTC value in, clear the marker, re-run.
const utc = db.prepare("SELECT datetime('now') AS t").get().t;
db.prepare("UPDATE service_slips SET created_at = ? WHERE slip_number = '99001'").run(utc);
db.prepare("DELETE FROM schema_meta WHERE key = 'timestamps-to-localtime'").run();
delete require.cache[require.resolve(path.resolve(__dirname, "..", "backend", "db.js"))];
require(path.resolve(__dirname, "..", "backend", "db.js"));
const fixed = db.prepare("SELECT created_at FROM service_slips WHERE slip_number = '99001'").get().created_at;
const fixedDrift = db.prepare(
  "SELECT ROUND((julianday(?) - julianday(datetime('now','localtime'))) * 1440) AS d"
).get(fixed).d;
check("the UTC row was brought forward to local time", Math.abs(fixedDrift) <= 1, true);

console.log("\n-- a blank or unreadable value is left alone, not blanked --");
// datetime() returns NULL for anything it cannot read, and an UPDATE without
// this guard would quietly turn those rows into NULL.
db.prepare("UPDATE service_slips SET closed_at = '' WHERE slip_number = '99001'").run();
db.prepare("INSERT INTO service_slips (slip_number, company, created_at) VALUES ('99002', 'ODD', 'not a date')").run();
db.prepare("DELETE FROM schema_meta WHERE key = 'timestamps-to-localtime'").run();
delete require.cache[require.resolve(path.resolve(__dirname, "..", "backend", "db.js"))];
require(path.resolve(__dirname, "..", "backend", "db.js"));
check("the empty string is still an empty string",
  db.prepare("SELECT closed_at FROM service_slips WHERE slip_number = '99001'").get().closed_at, "");
check("and the unreadable value is still there, not NULL",
  db.prepare("SELECT created_at FROM service_slips WHERE slip_number = '99002'").get().created_at, "not a date");

console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
process.exit(failures ? 1 : 0);
