// Put back slips that the counter marked "awaiting quote" before that stopped
// being something the counter could do.
//
//   node tools/fix-legacy-quote-state.js --scan          list every slip affected
//   node tools/fix-legacy-quote-state.js 00007           show what would change
//   node tools/fix-legacy-quote-state.js 00007 --apply   change it
//
// Registering a slip used to write AWAITING_QUOTE onto every machine the
// customer wanted quoted, which put the slip straight onto Sales' Need to
// Quote list - before a technician had opened anything. Slips registered
// before that change are still sitting there.
//
// WHAT IT WILL AND WILL NOT TOUCH
// Only a machine that is AWAITING_QUOTE, that no person decided (decided_by
// is blank - setMachineState always records who, the old registration did
// not), and that nobody has worked on: no parts, no repair comment, no
// labour. A machine a technician genuinely sent for quoting fails all three
// tests and is left exactly where it is.
//
// The customer's "wants a quote first" request on the slip is NOT touched.
// That is still true, and is what the badge now shows.
//
// Nothing is written without --apply, and the slip has to be named. Read the
// dry run before you type it.
const path = require("path");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const scan = args.includes("--scan");
const slipNumbers = args.filter((a) => !a.startsWith("--"));

if (!scan && slipNumbers.length === 0) {
  console.error(
    "Name the slip, e.g.\n" +
    "  node tools/fix-legacy-quote-state.js 00007\n" +
    "or list every affected slip with\n" +
    "  node tools/fix-legacy-quote-state.js --scan"
  );
  process.exit(2);
}

const db = require(path.resolve(__dirname, "..", "backend", "db.js"));
const repo = require(path.resolve(__dirname, "..", "backend", "data", "sqliteRepo.js"));

// A machine the counter marked, that nobody has since decided or worked on.
const LEGACY = `
  m.state = 'AWAITING_QUOTE'
  AND COALESCE(TRIM(m.decided_by), '') = ''
  AND COALESCE(TRIM(m.repair_comment), '') = ''
  AND COALESCE(m.labour_charge, 0) = 0
  AND NOT EXISTS (SELECT 1 FROM machine_parts p WHERE p.machine_id = m.id)
`;

if (scan) {
  const rows = db.prepare(`
    SELECT s.slip_number, s.company, s.status, COUNT(m.id) AS n
    FROM service_slips s JOIN slip_machines m ON m.slip_id = s.id
    WHERE s.status <> 'CLOSED' AND ${LEGACY}
    GROUP BY s.id ORDER BY s.slip_number
  `).all();
  if (!rows.length) {
    console.log("\nNo slips are affected. Nothing to do.\n");
    process.exit(0);
  }
  console.log(`\n${rows.length} slip(s) still carry a quote the counter asked for:\n`);
  for (const r of rows) {
    console.log(`  ${r.slip_number}  ${String(r.status).padEnd(12)} ${r.n} machine(s)   ${r.company}`);
  }
  console.log("\nRun one of them to see the detail:");
  console.log(`  node tools/fix-legacy-quote-state.js ${rows[0].slip_number}\n`);
  process.exit(0);
}

let changed = 0;
for (const no of slipNumbers) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(no);
  if (!slip) { console.log(`\n${no}: no such slip.`); continue; }
  if (slip.status === "CLOSED") { console.log(`\n${no}: closed - left alone.`); continue; }

  const machines = db.prepare("SELECT * FROM slip_machines WHERE slip_id = ? ORDER BY id").all(slip.id);
  const target = db.prepare(
    `SELECT m.id FROM slip_machines m WHERE m.slip_id = ? AND ${LEGACY}`
  ).all(slip.id).map((r) => r.id);
  const targetSet = new Set(target);

  console.log(`\n${no}  ${slip.company}   status: ${slip.status}`);
  console.log(`  customer asked for a quote first: ${slip.quote_first ? "yes (kept)" : "no"}`);
  for (const m of machines) {
    const parts = db.prepare("SELECT COUNT(*) AS n FROM machine_parts WHERE machine_id = ?").get(m.id).n;
    const worked = parts > 0 || String(m.repair_comment || "").trim() || Number(m.labour_charge) > 0;
    const mark = targetSet.has(m.id) ? "  ->  RECEIVED"
               : worked ? "   (worked on - left alone)"
               : m.state === "AWAITING_QUOTE" ? `   (sent by ${m.decided_by || "?"} - left alone)`
               : "   (left alone)";
    console.log(`    ${String(m.machine_desc).slice(0, 34).padEnd(36)} ${String(m.state).padEnd(15)}${mark}`);
  }

  if (!target.length) { console.log("  Nothing to change on this slip."); continue; }

  if (!apply) {
    console.log(`\n  Would reset ${target.length} machine(s) and re-derive the status.`);
    console.log(`  Nothing written. To do it:  node tools/fix-legacy-quote-state.js ${no} --apply`);
    continue;
  }

  const reset = db.prepare("UPDATE slip_machines SET state = 'RECEIVED' WHERE id = ?");
  const tx = db.transaction(() => { for (const id of target) reset.run(id); });
  tx();
  repo.slips.deriveSlipStatus(slip.id);
  const after = db.prepare("SELECT status FROM service_slips WHERE id = ?").get(slip.id);
  console.log(`\n  Reset ${target.length} machine(s).  status: ${slip.status} -> ${after.status}`);
  changed += target.length;
}

if (apply) console.log(`\nDone. ${changed} machine(s) changed.\n`);
else console.log("");
