// Which parts book belongs to the machine in front of the technician.
//
//   node tools/test-machine-ipl.js
//
// Run against the REAL catalogue in frontend/ipl/index.json, with machine
// descriptions and codes copied out of AutoCount. A wrong match here is worse
// than no match: it would float another model's parts to the top of the search
// and a technician would fit them.
const path = require("path");
const fs = require("fs");
const M = require(path.resolve(__dirname, "..", "frontend", "machine-ipl.js"));
const INDEX = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "..", "frontend", "ipl", "index.json"), "utf8"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const machine = (code, desc) => ({ machine_code: code, machine_desc: desc });
const match = (m) => M.matchIplModel(m, INDEX);

console.log("\n-- the brand's parts prefix --");
// Read off the catalogue: a machine is UHUQ/UZEN, its parts are SHUQ/SZEN.
check("Husqvarna", M.brandPrefixFor(machine("UHUQ 525BX 967284201", "")), "SHUQ");
check("Zenoah", M.brandPrefixFor(machine("UZEN BK3410F51 BK3404Z", "")), "SZEN");
check("PulsFOG", M.brandPrefixFor(machine("UPUL K10SP", "")), "SPUL");
check("a machine typed in by hand has no code and no prefix",
  M.brandPrefixFor(machine("", "Some old mower")), "");
check("and a part code is not a machine code",
  M.brandPrefixFor(machine("SHUQ 522664401", "")), "");

console.log("\n-- machines straight out of AutoCount --");
check("525BX blower",
  match(machine("UHUQ 525BX 967284201", "525BX Blower c/w Tools & Acc")), "hus525bx");
check("BK3410FL-S backpack brushcutter",
  match(machine("UZEN BK3410F51 BK3404Z", "ZENOAH BK3410FL-S B.Pack Brushcutter 33.6cc /w Tools")), "bk3410fl");
check("the same machine on its other code",
  match(machine("UZEN BK3410FL51 TKHOSE", "ZENOAH BK3410FL-S Backpack Brushcutter 33.6cc /w Tools & Acc. (Thick Flexible Hose)")), "bk3410fl");
check("a PulsFOG fogger",
  match(machine("UPUL K10SP", "pulsFOG K-10-SP Thermal Fogger c/w Tools & Acc")), "k10sp");

console.log("\n-- models that look alike --");
// 525HE4, 525HF3S and 525PT5S all start the same way. The longest match wins,
// so none of them can be taken for another.
check("525HF3S", match(machine("UHUQ 525HF3S", "Husqvarna 525HF3S Pole Hedge Trimmer")), "hus525hf3s");
check("525HE4", match(machine("UHUQ 525HE4", "Husqvarna 525HE4 Pole Hedge Trimmer")), "hus525he4");
check("525PT5S", match(machine("UHUQ 525PT5S", "Husqvarna 525PT5S Pole Saw")), "hus525pt5s");
check("531RB and 532RBS are not each other",
  [match(machine("UHUQ 531RB", "Husqvarna 531RB")), match(machine("UHUQ 532RBS", "Husqvarna 532RBS"))],
  ["hus531rb", "hus532rbs"]);

console.log("\n-- the brand has to agree --");
// The one that makes this safe to run on every machine. "365" turns up inside
// plenty of text; without the brand check a Zenoah with 36.5cc on its label
// would be handed a Husqvarna chainsaw's parts list.
check("a 33.6cc Zenoah is not a Husqvarna 365",
  match(machine("UZEN G3800", "ZENOAH G3800 Chainsaw 36.5cc")), "g3800");
check("nor is a Zenoah with no model we hold",
  match(machine("UZEN SOMETHING", "ZENOAH Something 365 series")), "");
check("a Husqvarna 365 is",
  match(machine("UHUQ 365", "Husqvarna 365 Chainsaw 65.1cc")), "hus365");
// A short model name is only ever matched as a WHOLE word, so a number that
// merely starts the same way is not it.
check("but 3650 is not 365",
  match(machine("UHUQ 3650", "Husqvarna 3650 something")), "");
check("nor is a length in millimetres",
  match(machine("UHUQ OTHER", "Husqvarna hose 365mm")), "");

console.log("\n-- machines with no book, and no code --");
check("a Ferris has no book loaded yet",
  match(machine("UFER IS700Z", "FERRIS IS700Z Zero-Turn Mower")), "");
check("a machine typed in free-hand still matches on its brand and model",
  match(machine("", "Husqvarna 395XP chainsaw, customer's own")), "hus395xp");
check("and one that names nothing matches nothing",
  match(machine("", "Old red mower")), "");
check("an empty machine is not an error", match(machine("", "")), "");

console.log("\n-- half a model name is not a model --");
// "BK3410FL / FL-S" is one book covering two names. Split naively it yields
// "FL-S", which would match anything with those letters in it.
check("FL-S alone is dropped", M.modelKeys({ short: "BK3410FL / FL-S", name: "Zenoah BK3410FL / FL-S" })[0], "BK3410FL");
check("a machine that merely says FL-S matches nothing",
  match(machine("UZEN OTHER", "ZENOAH FL-S something else")), "");

console.log("\n-- the numbers a search actually needs --");
const doc = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "..", "frontend", "ipl", "hus395xp.json"), "utf8"));
const clutch = M.preferredNumbers(doc, "clutch");
check("a term with matches returns some", clutch.length > 0, true);
// The whole point, checked against both real sources: this number is in the
// 395XP's book as "CLUTCH ASSY", and AutoCount holds it as "SHUQ 503701502".
// Searching "clutch" on a 395XP has to float that one.
check("the 395XP's own clutch is among them", clutch.includes("503701502"), true);
check("they are squashed to letters and digits, the way codes are compared",
  clutch.every((n) => /^[A-Z0-9]+$/.test(n)), true);
check("a term nothing matches returns nothing",
  M.preferredNumbers(doc, "zzzznothing"), []);
check("an empty term returns nothing", M.preferredNumbers(doc, "   "), []);
// Searching by number finds the number.
const one = (doc.figures[0].parts || []).map((p) => p.part_number).find(Boolean);
check("searching a part number finds that part",
  M.preferredNumbers(doc, one).includes(one.toUpperCase().replace(/[^A-Z0-9]/g, "")), true);
// The list is capped: it travels in a URL, and a whole book does not.
check("and it never runs away with itself", M.preferredNumbers(doc, "a", 25).length <= 25, true);

// A number written with spaces in the book is squashed the same way the
// catalogue's own code is, or the two would never meet.
const spaced = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "..", "frontend", "ipl", "cht220_60.json"), "utf8"));
check("a part number written '590 53 64-02' comes back as 5905364 02 squashed",
  M.preferredNumbers(spaced, "clutch drum").includes("5905364" + "02"), true);

console.log("\n-- every book in the catalogue is reachable --");
// Each model matched from its own name, so a book nobody can reach is caught
// here rather than by a technician wondering why nothing floats.
const unreachable = INDEX.filter((e) => {
  const pfx = Object.keys(M.BRAND_BY_PREFIX).find((k) => M.BRAND_BY_PREFIX[k] === e.brand) || "";
  return match(machine(pfx ? `${pfx} X` : "", `${e.brand} ${e.short}`)) !== e.id;
}).map((e) => e.id);
check("none unreachable", unreachable, []);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
