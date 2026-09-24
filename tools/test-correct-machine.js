// Putting a machine's status right when it is wrong.
//
//   node tools/test-correct-machine.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// Slip 00091, 24 Sep 2026: a K10-SP fogger still marked Received, with no
// parts and no labour, carrying the comment "No servicing". A comment counts
// as work, so the slip read In Progress - and nothing in the app could say
// otherwise. setMachineState() only moves a machine along; undoMachineDecision
// refuses twice over, once because the machine is already Received and once
// because a comment is work recorded against it.
//
// WHAT IS CHECKED, worst consequence first
//  1. Nothing it undoes disappears silently. A cleared comment is one person
//     deleting another's words, and the amendment log is the only thing that
//     stops that being invisible.
//  2. The slip's status follows. The whole point is the status on the screen,
//     not the column in the table.
//  3. It refuses on a closed slip, which is a finished record.
//  4. It is John's. The list lives in app-functions.js, which the browser and
//     the server both read, so the button and the rule cannot drift apart.
//  5. Parts are never touched. They are lines on a customer's bill and belong
//     to the screen that can price them.
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
const FN = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
async function throws(what, fn, wantStatus) {
  try {
    await fn();
    failures++;
    console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = !wantStatus || e.status === wantStatus;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${e.message}`);
  }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  console.log("-- rule 4: whose button this is --");
  check("John's", FN.canCorrect({ id: "john" }), true);
  check("not another admin's", FN.canCorrect({ id: "shirley" }), false);
  check("not a technician's", FN.canCorrect({ id: "kangmin" }), false);
  check("and not nobody's", FN.canCorrect(null), false);

  // Slip 00091, rebuilt exactly: one fogger, nothing on it, one comment.
  const slip = await data.slips.createSlip({
    company: "CASH SALES - ICFM", contact_name: "Mr Ng", contact_number: "91112222",
    machines: [{ desc: "K10-SP Thermal Fogger", serial: "", remarks: "" }],
    signature: sig,
  });
  const no = slip.slip_number;
  const m = slip.machines[0];
  await data.slips.setMachineComment(m.id, "No servicing");

  console.log("\n-- the state slip 00091 was stuck in --");
  let now = await data.slips.getSlip(no);
  check("the machine has never been touched", now.machines[0].state, "RECEIVED");
  check("no parts, no labour",
    [(now.machines[0].parts || []).length, Number(now.machines[0].labour_charge) || 0], [0, 0]);
  check("but the slip reads In Progress, because a comment counts as work",
    now.status, "IN_PROGRESS");
  // Neither existing route could help, which is why this one exists.
  await throws("putting the status back is refused - nothing was decided",
    () => data.slips.undoMachineDecision(no, m.id, "J"), 409);

  console.log("\n-- rule 2: correcting it moves the slip --");
  await data.slips.correctMachine(no, m.id, { state: "REPAIRED", who: "J" });
  now = await data.slips.getSlip(no);
  check("the machine is finished", now.machines[0].state, "REPAIRED");
  check("and the slip says so", now.status, "REPAIRED");
  check("the comment is still there, because nobody asked to clear it",
    now.machines[0].repair_comment, "No servicing");

  console.log("\n-- and clearing the comment takes it back to Open --");
  await data.slips.correctMachine(no, m.id, { state: "RECEIVED", clear_comment: true, who: "J" });
  now = await data.slips.getSlip(no);
  check("nothing recorded against the machine any more",
    [now.machines[0].state, now.machines[0].repair_comment], ["RECEIVED", ""]);
  check("so the slip is Open again, as it was before anybody touched it",
    now.status, "OPEN");

  console.log("\n-- rule 1: nothing disappears silently --");
  const log = (now.amendments || []).map((a) => [a.field, a.before, a.after]);
  check("the status change is written down",
    log.filter((r) => /status$/.test(r[0])),
    [["K10-SP Thermal Fogger — status", "RECEIVED", "REPAIRED"],
     ["K10-SP Thermal Fogger — status", "REPAIRED", "RECEIVED"]]);
  // The one that matters: the technician's words survive being deleted.
  check("and the deleted comment is kept, word for word",
    log.filter((r) => /repair comment$/.test(r[0])),
    [["K10-SP Thermal Fogger — repair comment", "No servicing", ""]]);
  check("with who did it against every line",
    (now.amendments || []).every((a) => a.changed_by === "J"), true);

  console.log("\n-- a labour charge can go the same way --");
  await data.slips.setMachineLabour(m.id, 45);
  check("which puts the slip back to In Progress",
    (await data.slips.getSlip(no)).status, "IN_PROGRESS");
  await data.slips.correctMachine(no, m.id, { state: "RECEIVED", clear_labour: true, who: "J" });
  now = await data.slips.getSlip(no);
  check("cleared", Number(now.machines[0].labour_charge) || 0, 0);
  check("slip back to Open", now.status, "OPEN");
  check("and the figure is in the log",
    (now.amendments || []).filter((a) => /labour charge$/.test(a.field)).map((a) => [a.before, a.after]),
    [["45.00", "0.00"]]);

  console.log("\n-- rule 5: parts are never touched --");
  await data.slips.addPartToMachine(m.id, {
    item_code: "A8 SPARE PARTS", description: "Air Filter", uom: "PC",
    unit_price: 12, quantity: 1, technician: "KS" });
  await data.slips.correctMachine(no, m.id, { state: "REPAIRED", clear_comment: true, clear_labour: true, who: "J" });
  now = await data.slips.getSlip(no);
  check("the part is still on the machine", (now.machines[0].parts || []).length, 1);
  check("at its price", now.machines[0].parts[0].unit_price, 12);

  console.log("\n-- it refuses the things it should --");
  await throws("a state that is not a state",
    () => data.slips.correctMachine(no, m.id, { state: "MENDED", who: "J" }), 400);
  await throws("a machine on somebody else's slip",
    () => data.slips.correctMachine(no, 99999, { state: "REPAIRED", who: "J" }), 404);
  await throws("and a correction that changes nothing",
    () => data.slips.correctMachine(no, m.id, { state: "REPAIRED", who: "J" }), 400);

  console.log("\n-- rule 3: a closed slip is a finished record --");
  const closable = await data.slips.getSlip(no);
  check("the slip is not closed yet", closable.status !== "CLOSED", true);
  // Closing needs its own paperwork, so set the status directly - the point
  // here is only that correctMachine refuses once it is CLOSED.
  const db = require(path.resolve(__dirname, "..", "backend", "db"));
  db.prepare("UPDATE service_slips SET status = 'CLOSED' WHERE slip_number = ?").run(no);
  // Refused by machineOnSlip(), the same guard every other edit to a machine
  // goes through - which is why correctMachine does not check it twice.
  await throws("correcting a machine on it is refused",
    () => data.slips.correctMachine(no, m.id, { state: "RECEIVED", who: "J" }), 400);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
