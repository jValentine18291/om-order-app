// RECOGNISING THE MACHINES WE CARRY, AND THEIR PARTS. No database needed:
//
//   node tools/test-model-recognition.js
//
// John, 9 Oct 2026: a 532RBS on slip 00150 had none of its parts suggested.
// The app did know the model - it matched the 532RBS parts book - but
// AutoCount stocks 6 of that book's 194 parts; what is on the shelf for it is
// filed under the Zenoah BK3410. And the book says CARBURETTOR, so a
// technician typing "carburetor" floated nothing from it. Checked here:
//   - equivalent models (532RBS <-> BK3410, 525BX <-> HBZ260), both ways
//   - the parts books read in either spelling, and "air filter" finding the
//     ELEMENT and AIR CLEANER lines but not the antivibration elements
//   - the parts search ranking the equivalent's parts between the machine's
//     own (0) and its brand's (1), and matching either spelling
const path = require("path");
const MT = require(path.resolve(__dirname, "..", "frontend", "machine-types.js"));
const MI = require(path.resolve(__dirname, "..", "frontend", "machine-ipl.js"));
const { buildPartsSearchSql } = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));
const book = (id) => require(path.resolve(__dirname, "..", "frontend", "ipl", `${id}.json`));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const descsFor = (doc, term) => {
  const nums = MI.preferredNumbers(doc, term);
  const out = new Set();
  for (const f of doc.figures) for (const p of f.parts) {
    if (nums.includes(String(p.part_number).toUpperCase().replace(/[^A-Z0-9]/g, ""))) out.add(p.description);
  }
  return [...out].sort();
};

console.log("-- equivalent models --");
check("532RBS also gets BK3410", MT.equivalentsOf(["532RBS"]), ["BK3410"]);
check("and the other way", MT.equivalentsOf(["BK3410"]), ["532RBS"]);
check("525BX gets HBZ260 in both spellings", MT.equivalentsOf(["525BX"]), ["HBZ260", "HBZ260EZ"]);
check("HBZ260EZ gets 525BX", MT.equivalentsOf(["HBZ260EZ", "HBZ260"]), ["525BX"]);
check("a machine with none gets none", MT.equivalentsOf(["365"]), []);
check("the 532RBS on slip 00150 is matched to its book",
  MI.fitFor({ machine_desc: "532RBS - 1/3", machine_code: "" }, book("index")).iplId, "hus532rbs");

console.log("\n-- the parts books, in either spelling --");
check("532RBS: carburetor finds CARBURETTOR", descsFor(book("hus532rbs"), "carburetor"), ["CARBURETTOR"]);
check("532RBS: air filter finds ELEMENT", descsFor(book("hus532rbs"), "air filter"), ["ELEMENT"]);
check("BK3410: carburettor finds CARBURETOR ASSY", descsFor(book("bk3410fl"), "carburettor"), ["CARBURETOR ASSY"]);
check("365: air filter still finds its own", descsFor(book("hus365"), "air filter"), ["AIR FILTER", "AIR FILTER ASSY"]);
check("no antivibration element under air filter",
  ["hus532rbs", "bk3410fl", "hus365", "hus525bx", "hbz260ez"].some((b) => descsFor(book(b), "air filter").some((d) => /ANTIVIBRATION/.test(d))), false);
check("antivibration still found by its own name", descsFor(book("hus365"), "antivibration").length > 0, true);

console.log("\n-- the parts search --");
const b = buildPartsSearchSql("carburetor", 15, { brand: "SHUQ", models: ["532RBS"], also: ["BK3410"] });
check("either spelling is asked for", [b.params.w0s0, b.params.w0s1], ["CARBURETTOR", "CARBURATOR"]);
check("the equivalent's parts rank half a step below its own", /@eq0 \+ ',%' THEN 0\.5 WHEN .*@brand \+ '%' THEN 1/.test(b.sql.replace(/\s+/g, " ")), true);
check("its own still rank first", /@md0 \+ ',%' THEN 0 WHEN/.test(b.sql.replace(/\s+/g, " ")), true);
const none = buildPartsSearchSql("clutch", 15, { brand: "SHUQ", models: ["365"] });
check("no equivalents, no extra rank", /THEN 0\.5/.test(none.sql), false);
check("a word with one spelling adds nothing", Object.keys(none.params).some((k) => /^w0s/.test(k)), false);
const dup = buildPartsSearchSql("coil", 15, { models: ["BK3410"], also: ["BK3410"] });
check("a model is never its own equivalent", /@eq0/.test(dup.sql), false);

console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
process.exit(failures ? 1 : 0);
