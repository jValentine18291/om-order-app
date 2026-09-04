// What a machine is called on a slip.
//
//   node tools/test-machine-names.js
//
// The rule this guards: a name that cannot be DERIVED safely is written down
// instead. "Drop whatever follows the digits" turns BK3410FL-S into BK3410 and
// would be lovely, except it also turns 525HF3S into 525 and 572XP into 572,
// where the suffix IS the model - and the result of getting that wrong is a
// customer's slip naming a machine they did not bring in.
const path = require("path");
const fs = require("fs");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

global.window = {};
new Function(fs.readFileSync(path.resolve(__dirname, "..", "frontend", "machine-names.js"), "utf8"))();
const M = global.window.MACHINE_NAMES;

console.log("\n-- the default: the code without its brand prefix --");
for (const [code, want] of [
  ["UZEN BK3410FL-S", "BK3410FL-S"],
  ["UHUQ 525HF3S", "525HF3S"],
  ["UHUQ 572XP", "572XP"],
  ["UPUL K10SP", "K10SP"],
  // Suffixes survive, because on these machines they are the model.
  ["UHUQ 525LST", "525LST"],
]) check(code, M.shortNameFor(code, "some long AutoCount description"), want);

console.log("\n-- an unfamiliar code shape is left alone, not guessed at --");
// Reading oddly is recoverable; reading wrongly is not.
check("no brand prefix", M.shortNameFor("BK3410FL-S", "x"), "BK3410FL-S");
check("a prefix that is not a U-brand", M.shortNameFor("SPUL KACC Z00126.03", "x"),
  "SPUL KACC Z00126.03");
check("spacing and case are normalised", M.shortNameFor("  uzen   bk3410fl-s ", "x"), "BK3410FL-S");

console.log("\n-- typed by hand: no code, so its own wording is all there is --");
check("falls back to the description", M.shortNameFor("", "Old Tanaka mist blower"),
  "Old Tanaka mist blower");
check("and to nothing at all, safely", M.shortNameFor("", ""), "");

console.log("\n-- an override wins, by code or by model --");
M.OVERRIDES["BK3410FL-S"] = "BK3410 (Thick)";
check("matched on the model", M.shortNameFor("UZEN BK3410FL-S", "x"), "BK3410 (Thick)");
M.OVERRIDES["UHUQ 572XP"] = "572XP Chainsaw";
check("matched on the full code", M.shortNameFor("UHUQ 572XP", "x"), "572XP Chainsaw");
check("and everything else keeps its default", M.shortNameFor("UHUQ 525HF3S", "x"), "525HF3S");

console.log("\n-- an override nobody can reach is worth knowing about --");
// The symptom otherwise is silence: the machine keeps its default name and
// there is nothing on screen to say why.
M.OVERRIDES["UZEN TYPO-3410"] = "never matches";
check("reports the one that matches no machine",
  M.unusedOverrides(["UZEN BK3410FL-S", "UHUQ 572XP", "UHUQ 525HF3S"]),
  ["UZEN TYPO-3410"]);
delete M.OVERRIDES["UZEN TYPO-3410"];
check("and none once it is gone",
  M.unusedOverrides(["UZEN BK3410FL-S", "UHUQ 572XP", "UHUQ 525HF3S"]), []);

console.log("\n-- the rule that was NOT used, and why --");
// Kept as a test rather than a comment so it stays true: this is the shortcut
// that looks reasonable on BK3410FL-S until you try it on the rest of the
// catalogue. The claim is not what it produces, but that it CHANGES models it
// has no business changing - which is what puts a wrong name on a slip.
const naive = (c) => M.modelFromCode(c).replace(/[A-Z-]+$/, "");
check("it does shorten the one it was invented for",
  naive("UZEN BK3410FL-S") !== M.modelFromCode("UZEN BK3410FL-S"), true);
check("but it mangles 525HF3S too",
  [naive("UHUQ 525HF3S"), naive("UHUQ 572XP"), naive("UHUQ 525LST")],
  ["525HF3", "572", "525"]);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
