// backup-db.js
// ============================================================================
// Makes a safe copy of om_orders.db while the app keeps running.
//
// Why not just copy the file: the database runs in WAL mode, which means the
// most recent writes live in om_orders.db-wal and NOT in om_orders.db itself.
// Copying only the .db gives a backup that is silently missing the newest
// slips. Copying all three files while they are being written is worse - the
// result can be corrupt.
//
// So this uses SQLite's own VACUUM INTO, which produces one self-contained,
// consistent file with no -wal sidecar, safely while the service is running.
// The source is opened READ-ONLY, so a backup can never alter live data.
//
// Every backup is then re-opened and checked before it is trusted, and the
// price audit log is copied alongside it.
//
// USAGE
//   node backup-db.js                 -> backs up into .\backups
//   node backup-db.js "D:\OM Backups" -> backs up somewhere else (recommended:
//                                        a different disk or a network share)
//
// Keeps 30 days by default; override with OM_BACKUP_KEEP_DAYS.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = path.join(__dirname, "om_orders.db");
const LOG_PATH = path.join(__dirname, "price-updates.log");
const DEST = process.argv[2] || process.env.OM_BACKUP_DIR || path.join(__dirname, "backups");
const KEEP_DAYS = Math.max(1, Number(process.env.OM_BACKUP_KEEP_DAYS) || 30);
const KEEP_AT_LEAST = 7; // never prune below this many, however old they are

// om_orders-2026-08-24_1530.db — sorts chronologically as plain text
const PREFIX = "om_orders-";
const NAME_RE = /^om_orders-\d{4}-\d{2}-\d{2}_\d{4}(-\d{2})?\.db$/;

const fail = (msg) => { console.error("\nBACKUP FAILED: " + msg); process.exit(1); };
const mb = (b) => (b / 1024 / 1024).toFixed(2) + " MB";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// SQLite wants forward slashes inside the quoted path, on Windows too.
const forSql = (p) => p.split(path.sep).join("/");

function main() {
  if (!fs.existsSync(DB_PATH)) fail(`no database at ${DB_PATH}`);
  fs.mkdirSync(DEST, { recursive: true });

  // Names are per minute, so runs close together would collide. Keep counting
  // until a free name is found rather than refusing: a backup job that reports
  // failure for a benign reason teaches people to ignore its failures, which
  // is worse than the duplicate it was avoiding.
  const base = `${PREFIX}${stamp()}`;
  let outName = `${base}.db`;
  for (let n = 2; fs.existsSync(path.join(DEST, outName)) && n < 100; n++) {
    outName = `${base}-${String(n).padStart(2, "0")}.db`;
  }
  const outPath = path.join(DEST, outName);
  if (fs.existsSync(outPath)) fail(`could not find a free name for ${base} in ${DEST}`);

  console.log(`Backing up ${path.basename(DB_PATH)} (${mb(fs.statSync(DB_PATH).size)})`);
  console.log(`  to ${outPath}`);

  // ---- copy, without ever opening the live database for writing ----
  let src;
  try {
    src = new DatabaseSync(DB_PATH, { readOnly: true });
    src.exec(`VACUUM INTO '${forSql(outPath)}'`);
  } catch (e) {
    fail(`could not copy the database — ${e.message}`);
  } finally {
    try { if (src) src.close(); } catch (_) {}
  }

  // ---- prove the copy is actually usable ----
  // A backup nobody has opened is a guess. This one gets checked every time.
  let slips = 0, machines = 0, parts = 0, signatures = 0;
  try {
    const chk = new DatabaseSync(outPath, { readOnly: true });
    const integrity = chk.prepare("PRAGMA integrity_check").get();
    const verdict = integrity && (integrity.integrity_check || Object.values(integrity)[0]);
    if (String(verdict).toLowerCase() !== "ok") fail(`the copy did not pass SQLite's integrity check (${verdict})`);
    const count = (t) => {
      try { return chk.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (_) { return 0; }
    };
    slips = count("service_slips");
    machines = count("slip_machines");
    parts = count("machine_parts");
    signatures = count("slip_signatures");
    chk.close();
  } catch (e) {
    fail(`the copy could not be reopened — ${e.message}`);
  }

  console.log(`  ${mb(fs.statSync(outPath).size)} — integrity check passed`);
  console.log(`  holds ${slips} service slips, ${machines} machines, ${parts} parts, ${signatures} signatures`);
  if (slips === 0) {
    console.log("  NOTE: no service slips in this backup. Correct only if the app has never been used.");
  }

  // ---- the price audit log travels with it ----
  // AutoCount keeps no record of prices set from the app, so this file is the
  // only trail. It is excluded from GitHub, so backups are its only copy.
  if (fs.existsSync(LOG_PATH)) {
    const logOut = path.join(DEST, `price-updates-${stamp()}.log`);
    try {
      fs.copyFileSync(LOG_PATH, logOut);
      console.log(`  copied the price audit log (${mb(fs.statSync(logOut).size)})`);
    } catch (e) {
      console.log(`  WARNING: could not copy the price audit log — ${e.message}`);
    }
  }

  // ---- prune, carefully ----
  // Only files this script created, only in the backup folder, and never below
  // KEEP_AT_LEAST however old they are — a quiet month must not empty the folder.
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const backups = fs.readdirSync(DEST)
    .filter((f) => NAME_RE.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(DEST, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  const removable = backups.slice(KEEP_AT_LEAST).filter((b) => b.t < cutoff);
  for (const b of removable) {
    try {
      fs.unlinkSync(path.join(DEST, b.f));
      const log = path.join(DEST, b.f.replace(PREFIX, "price-updates-").replace(/\.db$/, ".log"));
      if (fs.existsSync(log)) fs.unlinkSync(log);
    } catch (e) {
      console.log(`  WARNING: could not remove ${b.f} — ${e.message}`);
    }
  }
  if (removable.length) console.log(`  removed ${removable.length} backup(s) older than ${KEEP_DAYS} days`);

  console.log(`\nDone. ${backups.length - removable.length} backup(s) in ${DEST}`);
}

main();
