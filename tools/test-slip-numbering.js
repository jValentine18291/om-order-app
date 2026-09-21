// Which number the next service slip gets.
//
//   node tools/test-slip-numbering.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// Slip numbers come from a counter that only ever goes up, and for ordinary
// running that is the whole story. The interesting cases are the two where the
// counter ends up BEHIND the slips that already exist:
//
//   - deliberately, to fill a gap. Slip 00068 was a WhatsApp test, deleted
//     once it had served its purpose, and no customer ever saw the number -
//     so it can be used again rather than left as a hole in the book.
//   - accidentally, after restoring from a backup, where the database goes
//     back in time and the counter goes with it.
//
// Before this, both ended the same way: INSERT hit the UNIQUE constraint on
// slip_number and the registration threw. That is a failure at the counter,
// with a customer standing there, caused by something that happened days
// earlier - the worst kind.
//
// THE RULES IT GUARDS
//  1. Normally the numbers just run on, 1, 2, 3.
//  2. A counter wound back lands on the gap, and fills it.
//  3. The slip AFTER that skips every number already used, rather than
//     colliding with one.
//  4. No slip number is ever issued twice. That is the one that matters: two
//     slips sharing a number means two customers' machines under one
//     reference, and no way to tell the paperwork apart afterwards.
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
const db = require(path.resolve(__dirname, "..", "backend", "db"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const register = (company) =>
  data.slips.createSlip({
    company,
    contact_name: "Mr Tan",
    contact_number: "91234567",
    machines: [{ desc: "Husqvarna 125B Blower", serial: "X1", remarks: "service" }],
    signature: sig,
  });

const setCounter = (n) =>
  db.prepare("UPDATE counters SET value = ? WHERE name = 'slip_number'").run(n);

(async () => {
  console.log("\n-- ordinary running: the numbers just run on --");
  const a = await register("FIRST PTE LTD");
  const b = await register("SECOND PTE LTD");
  const c = await register("THIRD PTE LTD");
  check("three slips, three numbers in order",
    [a.slip_number, b.slip_number, c.slip_number], ["00001", "00002", "00003"]);

  console.log("\n-- a gap, and the counter wound back to fill it --");
  // Exactly what deleting a test slip leaves behind: the number is free, the
  // counter has moved past it, and the book has a hole where it was.
  db.prepare("DELETE FROM service_slips WHERE slip_number = '00002'").run();
  check("00002 is gone and the counter is still past it",
    db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get().value, 3);

  setCounter(1);
  const filled = await register("FILLS THE GAP PTE LTD");
  check("the next slip lands on the free number", filled.slip_number, "00002");

  console.log("\n-- and the one after it does NOT collide --");
  // The whole point. The counter is now at 2; 00003 exists. Without the skip
  // this throws UNIQUE constraint failed and the registration fails.
  const after = await register("AFTER THE GAP PTE LTD");
  check("it skips what is taken and takes the first free number",
    after.slip_number, "00004");

  console.log("\n-- a counter far behind, after a restore from backup --");
  setCounter(0);
  const recovered = await register("RESTORED PTE LTD");
  check("it walks up past every used number rather than failing",
    recovered.slip_number, "00005");

  console.log("\n-- the rule that matters: no number is ever issued twice --");
  const rows = db.prepare("SELECT slip_number FROM service_slips ORDER BY slip_number").all();
  const numbers = rows.map((r) => r.slip_number);
  check("every slip in the book", numbers, ["00001", "00002", "00003", "00004", "00005"]);
  check("and all of them distinct", numbers.length, new Set(numbers).size);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
