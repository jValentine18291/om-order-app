// reuse-slip-number.js
// ============================================================================
// Winds the slip counter back so that the NEXT slip registered takes a
// particular free number - the gap a deleted slip left behind.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node reuse-slip-number.js 00068             <- shows what would happen
//   node reuse-slip-number.js 00068 --confirm   <- sets the counter
//
// Then register the slip in the app as normal. It will come out as 00068.
//
// WHY THIS IS SAFE NOW, AND WAS NOT BEFORE
// Slip numbers come from a counter that only counts up, and nothing used to
// check the number was free. Winding the counter back therefore worked once -
// the gap got filled - and then the NEXT registration tried a number that
// already existed, hit the UNIQUE constraint on slip_number, and threw. At the
// counter. With a customer standing there.
//
// allocateSlipNumber() in data/sqliteRepo.js now walks past anything already
// used, so the slip after the gap simply takes the first free number instead.
// That is what makes this script reasonable rather than a trap, and it is
// covered by tools/test-slip-numbering.js.
//
// Because the fix and this script deploy together, being able to RUN this on
// the server is itself proof the fix is there.
//
// WHAT IT WILL NOT DO
//   - reuse a number that is still in use. The gap has to be a real gap.
//   - wind the counter FORWARD. Skipping numbers deliberately is a different
//     thing and not one anybody has asked for.
//   - touch any slip. It moves one integer in the counters table.
//
// AND THE ONE THING TO THINK ABOUT BEFORE USING IT
// Only reuse a number nobody outside the office has seen. 00068 qualifies: it
// was a WhatsApp test whose message never reached anyone. A number that was
// read out to a customer, written on a job sheet, or printed on a PDF that
// left the building does NOT - two slips sharing one number is worse than a
// gap, and the gap at least explains itself.
// ============================================================================

const path = require("path");

if (process.env.OM_DB_PATH) {
  console.log("");
  console.log("OM_DB_PATH is set. Refusing: this is meant for the live database");
  console.log("on the server, and pointing it elsewhere silently does nothing");
  console.log("useful. Run it from the backend folder with no override set.");
  console.log("");
  process.exit(1);
}

const db = require("./db");

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const WANTED = (args.find((a) => !a.startsWith("--")) || "").trim();

function main() {
  if (!WANTED) {
    console.log("");
    console.log("Which number? It is required:");
    console.log("");
    console.log("    node reuse-slip-number.js 00068             <- shows what would happen");
    console.log("    node reuse-slip-number.js 00068 --confirm   <- sets the counter");
    console.log("");
    process.exit(1);
  }

  if (!/^\d{1,5}$/.test(WANTED)) {
    console.log("");
    console.log(`"${WANTED}" is not a slip number. They are up to 5 digits, e.g. 00068.`);
    console.log("");
    process.exit(1);
  }

  const wanted = String(Number(WANTED)).padStart(5, "0");
  const n = Number(WANTED);

  const taken = db.prepare("SELECT company, created_at FROM service_slips WHERE slip_number = ?").get(wanted);
  if (taken) {
    console.log("");
    console.log(`Slip ${wanted} is IN USE - ${taken.company} (${String(taken.created_at || "").slice(0, 10)}).`);
    console.log("Nothing to reuse. Nothing has been changed.");
    console.log("");
    process.exit(1);
  }

  const counter = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get();
  const now = counter ? counter.value : 0;

  if (n > now) {
    console.log("");
    console.log(`The counter is at ${now}, so ${wanted} has not been reached yet -`);
    console.log("it is not a gap, it is the future. This script only goes back.");
    console.log("Nothing has been changed.");
    console.log("");
    process.exit(1);
  }

  // What the app would give out if nobody interfered, and what it will give
  // out after this. Both shown, because "the next slip" is the thing being
  // changed and it should be readable without doing arithmetic.
  const firstFreeFrom = (start) => {
    const used = db.prepare("SELECT 1 AS n FROM service_slips WHERE slip_number = ?");
    for (let i = start; i < 100000; i++) {
      const s = String(i).padStart(5, "0");
      if (!used.get(s)) return s;
    }
    return "(none free)";
  };

  const row = (label, value) => console.log("  " + String(label).padEnd(22) + value);
  console.log("");
  row("slips in the book", db.prepare("SELECT COUNT(*) AS n FROM service_slips").get().n);
  row("counter is at", now);
  row("next slip would be", firstFreeFrom(now + 1));
  row(`${wanted} is`, "free");
  console.log("");

  if (!CONFIRM) {
    console.log(`Would set the counter to ${n - 1}, so the next slip registered is ${wanted}.`);
    console.log(`The slip after that takes ${firstFreeFrom(n + 1)} - the first free number above it.`);
    console.log("");
    console.log("Nothing has been changed. To do it:");
    console.log("");
    console.log(`    node reuse-slip-number.js ${wanted} --confirm`);
    console.log("");
    console.log("Register the slip soon afterwards. Until you do, the counter is");
    console.log("sitting low, and any slip written in between takes this number");
    console.log("instead - which is fine, but it will not be the one you meant.");
    console.log("");
    return;
  }

  db.prepare("UPDATE counters SET value = ? WHERE name = 'slip_number'").run(n - 1);

  const after = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get().value;
  console.log(`Counter set to ${after}.`);
  console.log("");
  console.log(`  The NEXT slip registered will be ${wanted}.`);
  console.log(`  The one after that will be ${firstFreeFrom(n + 1)}.`);
  console.log("");
  console.log("Go and register it now, before somebody else writes a slip.");
  console.log("");
}

main();
