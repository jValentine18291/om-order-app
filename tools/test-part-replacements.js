// What we fit when the part the book names cannot be had.
//
//   node tools/test-part-replacements.js C:/temp/scratch.db
//
// WHY THIS EXISTS
// The whole value of a replacement over a free-text note is that it names a
// REAL part - so the rules that keep it real are the rules worth testing, and
// most of them are ones a person clicking around would not think to try:
// recording the same substitute twice, a part offered as its own replacement,
// and the day a part the catalogue did not hold gets added to it.
//
// The AutoCount check itself lives in server.js, not here: this file runs
// against SQLite alone and there is no catalogue to ask. What is tested here is
// everything that happens once a code has been accepted.
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
function throws(what, fn, wantStatus) {
  try {
    fn();
    failures++;
    console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = e.status === wantStatus;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${e.message}`);
  }
}

const R = data.replacements;
const IPL = "IPL:HUSQVARNA:537199202";     // the book's key for a bevel gear assy
const AC = "SHUS 537199202";               // the same part, once AutoCount holds it

(async () => {
  console.log("-- a technician records one from the diagram, before AutoCount has the original --");
  let rows = await R.add({
    part_key: IPL, ipl_key: IPL, item_code: "SHUS 537199203",
    description: "BEVEL GEAR ASSY (NEW TYPE)", who: "RY",
  });
  check("one replacement recorded", rows.length, 1);
  check("it names the AutoCount code", rows[0].item_code, "SHUS 537199203");
  check("and who recorded it", rows[0].created_by, "RY");

  console.log("\n-- a second alternative is allowed; the same one twice is not --");
  rows = await R.add({
    part_key: IPL, ipl_key: IPL, item_code: "SHUS 537199204", description: "BEVEL GEAR ASSY (LATE)", who: "RY",
  });
  check("two alternatives sit together", rows.length, 2);
  // A double tap on a slow phone must not read as a second opinion.
  throws("the same replacement twice is refused",
    () => R.add({ part_key: IPL, ipl_key: IPL, item_code: "SHUS 537199204", description: "x", who: "RY" }), 409);

  console.log("\n-- the guards --");
  throws("a part cannot replace itself",
    () => R.add({ part_key: AC, ipl_key: IPL, item_code: AC, description: "x", who: "RY" }), 400);
  throws("nothing to replace is refused",
    () => R.add({ part_key: "", ipl_key: "", item_code: "SHUS 1", description: "x", who: "RY" }), 400);
  throws("no replacement named is refused",
    () => R.add({ part_key: IPL, ipl_key: IPL, item_code: "", description: "x", who: "RY" }), 400);

  console.log("\n-- the day AutoCount gains the original, the rows must not vanish --");
  // Recorded against the book's key while the part was unknown; the sheet now
  // resolves and asks by item code instead. This is the case the ipl_key column
  // exists for, and getting it wrong loses work silently.
  const byItemCode = await R.get(AC, IPL);
  check("found when asked by the AutoCount code", byItemCode.length, 2);
  const byBookKey = await R.get(IPL, "");
  check("and still found by the book's key", byBookKey.length, 2);

  console.log("\n-- marking a whole figure costs one question --");
  // The list asks with the book's keys only, because that is all it can compute
  // without resolving every row against AutoCount.
  const counts = await R.counts([IPL, "IPL:HUSQVARNA:503856301", "IPL:HUSQVARNA:999999999"]);
  check("the part with two is counted", counts[IPL], 2);
  check("a part with none is absent", counts["IPL:HUSQVARNA:503856301"], undefined);
  check("an unknown key is absent", counts["IPL:HUSQVARNA:999999999"], undefined);
  check("nothing asked, nothing returned", await R.counts([]), {});

  console.log("\n-- a replacement recorded against the AutoCount code is found from the diagram too --");
  await R.add({
    part_key: AC, ipl_key: IPL, item_code: "SHUS 537199205", description: "BEVEL GEAR ASSY (LATEST)", who: "KS",
  });
  const after = await R.counts([IPL]);
  check("the figure's marker sees it without an AutoCount lookup", after[IPL], 3);

  console.log("\n-- taking one back out --");
  const all = await R.get(AC, IPL);
  const removed = await R.remove(all[0].id);
  check("it reports what it removed", removed.removed.item_code, "SHUS 537199203");
  check("and it is gone", (await R.get(AC, IPL)).length, 2);
  throws("removing it twice says so", () => R.remove(all[0].id), 404);
  throws("a nonsense id is refused", () => R.remove("banana"), 400);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})();
