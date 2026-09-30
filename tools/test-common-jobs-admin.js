// THE COMMON JOBS, AS JOHN KEEPS THEM.
// Run against a throwaway database, never the real one:
//
//   node tools/test-common-jobs-admin.js C:/temp/scratch.db
//
// John, 30 Sep 2026: he adds and edits the strip of buttons himself, from a
// screen of his own, choosing which machine families each job is for - no
// deploy. The rows live in common_jobs, seeded from common-jobs.js. What is
// checked here is what reaches a customer's invoice: what a job may be, which
// machines it lands on, and that nothing a slip already points at can vanish.
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
const J = require(path.resolve(__dirname, "..", "frontend", "common-jobs.js"));
const FN = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const refuse = (what, fn, re) => {
  let err = "";
  try { fn(); } catch (e) { err = e.message; }
  const ok = re.test(err);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(err)}`);
};
const titles = (list) => list.map((j) => j.title);

console.log("-- the table starts as the strip the technicians already have --");
const seeded = data.jobs.list(true);
check("every job in common-jobs.js, in the file's order", titles(seeded), titles(J.seed()));
check("the two fogger jobs are for the Fogger family",
  seeded.filter((j) => j.families.length).map((j) => [j.id, j.families]),
  [["PLUG", ["Fogger"]], ["CORE", ["Fogger"]]]);
check("prices come across as written", seeded.find((j) => j.id === "RETHREAD").price, 8);

console.log("\n-- adding a job --");
let j = data.jobs.save({ title: "Replace Recoil Rope", code: "A7 SVR WAREHOUSE", price: 12, qty: 1,
  families: ["Backpack Brushcutter"] }, "J");
check("gets an id from its title", j.id, "REPLACERECOILROPE");
check("lands at the end of the strip", data.jobs.list(true).slice(-1)[0].id, j.id);
check("and is for the family asked", j.families, ["Backpack Brushcutter"]);

refuse("no title", () => data.jobs.save({ title: "", code: "A7", price: 1, qty: 1 }), /title/);
refuse("no code on a line job", () => data.jobs.save({ title: "X", price: 1, qty: 1 }), /item code/);
refuse("a negative price", () => data.jobs.save({ title: "X", code: "A7", price: -1, qty: 1 }), /price/);
refuse("a quantity of nothing", () => data.jobs.save({ title: "X", code: "A7", price: 1, qty: 0 }), /quantity/);
refuse("a family that does not exist",
  () => data.jobs.save({ title: "X", code: "A7", price: 1, qty: 1, families: ["Hovercraft"] }), /Not a machine family/);
// Two buttons reading the same are two buttons nobody can tell apart.
refuse("a second job with the same title", () => data.jobs.save({ title: "rethread", code: "A7", price: 1, qty: 1 }),
  /already a job called/);

j = data.jobs.save({ title: "Checked, fine", comment: "Checked, no fault found" }, "J");
check("a comment job carries no code, price or quantity",
  [j.comment, j.code, j.price, j.qty], ["Checked, no fault found", undefined, undefined, undefined]);

console.log("\n-- editing one --");
const r = data.jobs.save({ id: "RETHREAD", title: "Rethread", code: "A7 SVR WAREHOUSE", price: 9.5, qty: 1 }, "J");
check("the price changes and the id does not", [r.id, r.price], ["RETHREAD", 9.5]);
check("and who changed it is kept", r.updated_by, "J");
refuse("a job that is not there", () => data.jobs.save({ id: "NOPE", title: "Y", code: "A7", price: 1, qty: 1 }), /no longer exists/);

console.log("\n-- hiding, never deleting --");
// A line already on a slip carries the job's id, and zeroIsDeliberate() reads
// it back - so a job is taken off the strip, never out of the table.
data.jobs.setHidden("CARBSVC", true, "J");
check("a hidden job is off the strip", data.jobs.list(false).some((x) => x.id === "CARBSVC"), false);
check("but still in the table", data.jobs.list(true).find((x) => x.id === "CARBSVC").hidden, true);
data.jobs.setHidden("CARBSVC", false, "J");
check("and comes back", data.jobs.list(false).some((x) => x.id === "CARBSVC"), true);

console.log("\n-- reordering --");
const ids = data.jobs.list(true).map((x) => x.id);
const moved = data.jobs.reorder(["PIPE"].concat(ids.filter((x) => x !== "PIPE")));
check("the strip follows the order given", moved[0].id, "PIPE");
// A stale screen sending an old list must not lose a job it did not know of.
check("a job left out of the list keeps its place, not lost",
  data.jobs.reorder(["WELD"]).length, ids.length);

console.log("\n-- which machines each job lands on --");
J.setList(data.jobs.list(false));
const on = (family, fogger) => J.forMachine(family, fogger).map((x) => x.id);
check("a brushcutter gets the everyday jobs and its own",
  on("Backpack Brushcutter", false).includes("REPLACERECOILROPE"), true);
check("a blower does not get the brushcutter's",
  on("Handheld Blower", false).includes("REPLACERECOILROPE"), false);
check("a fogger gets the fogger jobs", ["PLUG", "CORE"].every((x) => on("", true).includes(x)), true);
check("a chainsaw does not", on("Battery Chainsaw", false).some((x) => x === "PLUG" || x === "CORE"), false);
check("a machine nobody could name still gets every all-machines job",
  on("", false).includes("WELD"), true);
check("and the strip's own check passes on the live list", J.check(), []);

console.log("\n-- John alone --");
check("John may edit the jobs", FN.canEditCommonJobs({ id: "john" }), true);
check("another admin may not", FN.canEditCommonJobs({ id: "keeseng", role: "admin" }), false);
check("nor a technician", FN.canEditCommonJobs({ id: "ray", role: "tech" }), false);

console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
process.exit(failures ? 1 : 0);
