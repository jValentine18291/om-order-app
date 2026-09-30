// Matching a machine against an item's second description line.
//
//   node tools/test-fits.js
//
// The values here are real ones from the live catalogue survey. The risk being
// guarded against is a near-miss: "365" must not drag in parts for a "3650",
// and a machine listed second in a comma-separated line must still be found.
const path = require("path");
const { fitsModel } = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// The repo's own predicate, not a copy of it: a test that re-implements the
// logic it is checking will happily pass while the real code is broken.
const fits = fitsModel;

// ---- Real values from the catalogue ----------------------------------------
check("a single machine", fits("395XP", "395XP"), true);
check("second in a list", fits("GZ2800, T525", "T525"), true);
check("first in a list", fits("GZ2800, T525", "GZ2800"), true);
check("double space after the comma", fits("LC18,  LC118", "LC118"), true);
check("three machines", fits("365, 372XP", "372XP"), true);

// ---- The near-miss this exists to prevent ----------------------------------
check("365 does not match 3650", fits("3650", "365"), false);
check("nor 1365", fits("1365", "365"), false);
check("G621 does not match G6210", fits("G6210", "G621"), false);
check("but 365 in a list still matches", fits("365, 372XP", "365"), true);

// ---- Punctuation and case --------------------------------------------------
check("case is ignored", fits("540iXP", "540IXP"), true);
check("hyphens are ignored", fits("K-10-SP", "K10SP"), true);
check("spaces inside a name", fits("K970 Ring", "K970RING"), true);
check("a name with a space, as typed", fits("725DT Flail Mower", "725DT Flail Mower"), true);

// ---- Nothing to match ------------------------------------------------------
check("no second line", fits("", "365"), false);
check("no machine asked for", fits("395XP", ""), false);
check("both empty", fits("", ""), false);

// A part whose second line is a note rather than a machine - these exist, and
// must simply not match anything anyone searches for.
check("free text does not match a model", fits("No Guidebar and Chain", "365"), false);

// ---- one machine written two ways ------------------------------------------
// John, 30 Sep 2026: HBZ260 and HBZ260EZ are the same blower. The catalogue
// says "HBZ260" on 95 parts and "HBZ260EZ" on one, so a machine registered as
// HBZ260EZ found one part - the WS7F plug on slip 00083 was the first noticed.
// The groups live in machine-types.js, read by the app and the server alike.
console.log("\n-- one machine written two ways --");
check("the WS7F plug, as the catalogue lists it, fits an HBZ260EZ",
  fits("BK3410, 525BX, HBZ260", "HBZ260EZ"), true);
check("and the one part filed under HBZ260EZ fits an HBZ260",
  fits("HBZ260EZ", "HBZ260"), true);
check("a machine in no group is exactly what it was",
  fits("HBZ260", "HB2302"), false);
check("an alias is a spelling, never a prefix",
  fits("HBZ2600", "HBZ260EZ"), false);

const MT = require(path.resolve(__dirname, "..", "frontend", "machine-types.js"));
check("a group answers the same for every spelling in it",
  MT.aliasKeys("hbz-260 ez"), MT.aliasKeys("HBZ260"));
check("a model in no group is its own only spelling", MT.aliasKeys("EBZ5100"), ["EBZ5100"]);
check("every group names at least two spellings",
  MT.MODEL_ALIASES.filter((g) => g.length < 2), []);
const seen = new Map();
const twice = [];
for (const g of MT.MODEL_ALIASES) for (const s of g) {
  const k = MT.modelKey(s);
  if (seen.has(k) && seen.get(k) !== g) twice.push(s);
  seen.set(k, g);
}
check("and no spelling sits in two groups", twice, []);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
