// restore-slips.js
// ============================================================================
// Puts service slips back from a backup, WITHOUT rolling anything else back.
//
// Written after purge-test-slips.js was run a second time and removed two real
// slips that had been opened in between. Restoring the whole backup file would
// have undone everything else that happened since; this copies only the slips
// that are missing, and leaves the rest of the live database alone.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node restore-slips.js backups\om_orders-2026-08-31_1334.db
//        ^ shows what it WOULD restore. Changes nothing.
//
//   node restore-slips.js backups\om_orders-2026-08-31_1334.db --confirm
//        ^ takes a fresh backup of the CURRENT database, then restores.
//
// It restores a slip only if its number is missing from the live database, so
// running it twice cannot duplicate anything. If a number exists in both, it
// stops and says so rather than guessing which one is wanted.
//
// The slip counter is moved up past whatever is restored, so the next new slip
// cannot take a number that is now in use again.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC = process.argv[2];
const CONFIRM = process.argv.includes("--confirm");

if (!SRC) {
  console.error("");
  console.error("Which backup? For example:");
  console.error("  node restore-slips.js backups\\om_orders-2026-08-31_1334.db");
  console.error("");
  process.exit(1);
}
const SRC_PATH = path.resolve(__dirname, SRC);
if (!fs.existsSync(SRC_PATH)) {
  console.error(`\nThere is no file at ${SRC_PATH}\n`);
  process.exit(1);
}

const db = require("./db");

// The tables that make up a slip, parent first so foreign keys are satisfied.
const CHAIN = [
  { table: "service_slips", key: "id" },
  { table: "slip_machines", key: "id", parent: "slip_id", parentTable: "service_slips" },
  { table: "machine_parts", key: "id", parent: "machine_id", parentTable: "slip_machines" },
  { table: "slip_signatures", key: "id", parent: "slip_id", parentTable: "service_slips" },
];

// Only columns present in BOTH databases, so a backup taken before a migration
// still restores cleanly instead of failing on a column that did not exist.
function sharedColumns(table) {
  const live = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const back = db.prepare(`PRAGMA bk.table_info(${table})`).all().map((c) => c.name);
  const set = new Set(back);
  return live.filter((c) => set.has(c));
}

function main() {
  db.exec(`ATTACH DATABASE '${SRC_PATH.replace(/'/g, "''")}' AS bk`);

  const inBackup = db.prepare(
    "SELECT id, slip_number, company, status, created_at FROM bk.service_slips ORDER BY slip_number"
  ).all();
  const liveNumbers = new Set(
    db.prepare("SELECT slip_number FROM main.service_slips").all().map((r) => r.slip_number)
  );
  const liveIds = new Set(db.prepare("SELECT id FROM main.service_slips").all().map((r) => r.id));

  const missing = inBackup.filter((s) => !liveNumbers.has(s.slip_number));
  const already = inBackup.filter((s) => liveNumbers.has(s.slip_number));

  console.log("");
  console.log(`Backup : ${path.basename(SRC_PATH)}`);
  console.log(`         holds ${inBackup.length} slip(s)`);
  console.log(`Live   : has ${liveNumbers.size} slip(s)`);
  console.log("");

  if (already.length) {
    console.log("Already in the live database, so they will NOT be touched:");
    for (const s of already) console.log(`  ${s.slip_number}  ${s.company}`);
    console.log("");
  }
  if (!missing.length) {
    console.log("Nothing to restore — every slip in that backup is already live.");
    return;
  }

  // An id clash would mean re-pointing machines and parts; refuse rather than
  // silently renumber somebody's records.
  const idClash = missing.filter((s) => liveIds.has(s.id));
  if (idClash.length) {
    console.error("STOPPING: these slips share an internal id with a live slip:");
    for (const s of idClash) console.error(`  ${s.slip_number}  ${s.company}  (id ${s.id})`);
    console.error("\nTell Claude — this needs handling by hand.\n");
    process.exit(1);
  }

  console.log("Would restore:");
  for (const s of missing) {
    const m = db.prepare("SELECT COUNT(*) AS n FROM bk.slip_machines WHERE slip_id = ?").get(s.id).n;
    const p = db.prepare(
      "SELECT COUNT(*) AS n FROM bk.machine_parts WHERE machine_id IN (SELECT id FROM bk.slip_machines WHERE slip_id = ?)"
    ).get(s.id).n;
    const g = db.prepare("SELECT COUNT(*) AS n FROM bk.slip_signatures WHERE slip_id = ?").get(s.id).n;
    console.log(`  ${s.slip_number}  ${String(s.company).slice(0, 34).padEnd(34)} ${String(s.status).padEnd(12)} ${m} machine(s), ${p} part line(s), ${g} signature(s)`);
  }
  console.log("");

  if (!CONFIRM) {
    console.log("Nothing has been changed. To go ahead:");
    console.log(`\n    node restore-slips.js ${SRC} --confirm\n`);
    return;
  }

  console.log("Backing up the CURRENT database first…");
  try {
    execFileSync(process.execPath, [path.join(__dirname, "backup-db.js")], { stdio: "inherit" });
  } catch (e) {
    console.error("\nThe backup failed, so nothing has been restored.\n");
    process.exit(1);
  }

  const ids = missing.map((s) => s.id);
  const list = ids.join(",");

  const tx = db.transaction(() => {
    for (const step of CHAIN) {
      const cols = sharedColumns(step.table).map((c) => `[${c}]`).join(", ");
      let where;
      if (step.table === "service_slips") where = `id IN (${list})`;
      else if (step.parentTable === "service_slips") where = `slip_id IN (${list})`;
      else where = `machine_id IN (SELECT id FROM bk.slip_machines WHERE slip_id IN (${list}))`;
      db.exec(`INSERT INTO main.${step.table} (${cols}) SELECT ${cols} FROM bk.${step.table} WHERE ${where}`);
    }

    // The counter must sit past every slip number now in use, or the next new
    // slip would collide with one we just put back.
    const top = db.prepare(
      "SELECT MAX(CAST(slip_number AS INTEGER)) AS n FROM main.service_slips"
    ).get().n || 0;
    const cur = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get();
    if (!cur || cur.value < top) {
      db.prepare("UPDATE counters SET value = ? WHERE name = 'slip_number'").run(top);
    }
    return top;
  });
  const top = tx();

  console.log("");
  console.log("Restored:");
  for (const s of missing) console.log(`  ${s.slip_number}  ${s.company}`);
  console.log("");
  console.log(`  slip counter set to ${top} — the next new slip will be ${String(top + 1).padStart(5, "0")}`);
  console.log("");

  // Prove it, rather than assume it.
  for (const s of missing) {
    const back = db.prepare("SELECT slip_number, company FROM main.service_slips WHERE slip_number = ?").get(s.slip_number);
    const m = db.prepare("SELECT COUNT(*) AS n FROM main.slip_machines WHERE slip_id = ?").get(s.id).n;
    const g = db.prepare("SELECT COUNT(*) AS n FROM main.slip_signatures WHERE slip_id = ?").get(s.id).n;
    console.log(`  check ${s.slip_number}: ${back ? "present" : "MISSING"}, ${m} machine(s), ${g} signature(s)`);
  }
  console.log("");
}

try {
  main();
} finally {
  try { db.exec("DETACH DATABASE bk"); } catch (_) {}
}
