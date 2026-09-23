// refresh-slip-statuses.js
// ============================================================================
// Works out every open slip's status again, from its machines.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node refresh-slip-statuses.js             <- shows what would change
//   node refresh-slip-statuses.js --confirm   <- changes it
//
// WHY IT IS NEEDED, ONCE
// A slip's status used to take on the state of whichever machine was furthest
// from done: one machine sent for quoting and the whole slip read "Need to
// Quote". It no longer does - quoting is a machine's business and the slip
// stays In Progress until a Sales Order is raised.
//
// But a status is only worked out again when something on that slip CHANGES.
// Every slip already sitting in NEED_QUOTE or QUOTED keeps saying so until a
// machine on it happens to move, which could be weeks - so the list reads as a
// mixture of the old labels and the new ones, and nothing explains why. This
// goes through them once.
//
// WHAT IT WILL NOT TOUCH
//   - CLOSED and INVOICED slips. Those two are set by a person, deliberately,
//     and are never derived. A slip that was invoiced stays invoiced.
//   - any machine, part, quotation or order. It writes one column on
//     service_slips and nothing else.
//
// It is safe to run twice: the second run finds nothing to do.
// ============================================================================

if (process.env.OM_DB_PATH) {
  console.log("");
  console.log("OM_DB_PATH is set. Refusing: this is meant for the live database");
  console.log("on the server. Run it from the backend folder with nothing set.");
  console.log("");
  process.exit(1);
}

const db = require("./db");
// .slips, not the module: deriveSlipStatus is exported inside it.
const { slips: repo } = require("./data/sqliteRepo");

// NOTE ON READING THE "BEFORE" STATE
// Requiring the repository can itself run a historical one-off pass that
// re-reads open slips - it is guarded on a database never having had a
// PART_SO slip, so on a server that has been running a while it does nothing.
// Either way it has finished by the time anything below reads a status, so
// what this reports as "before" is the true state on disk right now.

const CONFIRM = process.argv.includes("--confirm");

// The two a person sets. deriveSlipStatus already refuses them; naming them
// here as well is so the count printed below is honest about what was looked
// at rather than quietly including slips it was never going to touch.
const LEFT_ALONE = new Set(["CLOSED", "INVOICED"]);

const slips = db.prepare(
  "SELECT id, slip_number, status FROM service_slips ORDER BY slip_number"
).all();

const considered = slips.filter((s) => !LEFT_ALONE.has(s.status));
const changes = [];

for (const s of considered) {
  const before = s.status;
  // Derive into a transaction we roll back, so a dry run really is dry: this
  // function's job is to WRITE the answer, and there is no version of it that
  // only tells you.
  const probe = db.transaction(() => {
    repo.deriveSlipStatus(s.id);
    const after = db.prepare("SELECT status FROM service_slips WHERE id = ?").get(s.id).status;
    // Undo it, whatever it was. --confirm re-does it for real below.
    db.prepare("UPDATE service_slips SET status = ? WHERE id = ?").run(before, s.id);
    return after;
  });
  const after = probe();
  if (after !== before) changes.push({ ...s, after });
}

console.log("");
console.log(`  ${slips.length} slips, ${considered.length} of them still derived.`);
console.log(`  ${slips.length - considered.length} closed or invoiced, left alone.`);
console.log("");

if (!changes.length) {
  console.log("  Nothing to change. Every status already matches its machines.");
  console.log("");
  process.exit(0);
}

const LABEL = {
  OPEN: "Open", IN_PROGRESS: "In Progress", NEED_QUOTE: "Need to Quote",
  QUOTED: "Quoted", REPAIRED: "Repaired", ALL_REPAIRED: "All Repaired",
  PART_SO: "Partial SO", CONVERTED: "Converted",
};
const name = (s) => LABEL[s] || s;

console.log(`  ${changes.length} would change:`);
console.log("");
for (const c of changes) {
  console.log(`    ${c.slip_number}   ${name(c.status).padEnd(14)} -> ${name(c.after)}`);
}
console.log("");

if (!CONFIRM) {
  console.log("  Nothing has been changed. To do it:");
  console.log("");
  console.log("      node refresh-slip-statuses.js --confirm");
  console.log("");
  process.exit(0);
}

const apply = db.transaction(() => {
  for (const c of changes) repo.deriveSlipStatus(c.id);
});
apply();

// Read them back rather than trusting the loop above: this is the only thing
// that proves the change landed, and it costs one query.
let done = 0;
for (const c of changes) {
  const now = db.prepare("SELECT status FROM service_slips WHERE id = ?").get(c.id).status;
  if (now === c.after) done++;
  else console.log(`    ${c.slip_number} came out as ${name(now)}, not ${name(c.after)}`);
}
console.log(`  ${done} of ${changes.length} updated.`);
console.log("");
console.log("  Phones pick it up the next time they load a list - no restart,");
console.log("  no deploy.");
console.log("");
