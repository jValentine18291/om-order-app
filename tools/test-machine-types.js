// What kind of machine a model number is.
//
//   node tools/test-machine-types.js
//
// WHY THIS MATTERS
// Sales type "EBZ5100" and the documents that leave the building have to say
// "EBZ5100 Backpack Blower". Get it wrong and a customer's quotation calls
// their blower a brushcutter.
//
// The trap in John's list is the 525s: FIVE machines begin with those three
// digits and no two are the same kind of machine. Matching on a prefix would
// label four of them wrongly, so everything here is matched as a whole word.
const path = require("path");
const T = require(path.resolve(__dirname, "..", "frontend", "machine-types.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

console.log("-- the plain case, which is the whole point --");
check("EBZ5100", T.expand("EBZ5100"), "EBZ5100 Backpack Blower");
check("BK4310", T.expand("BK4310"), "BK4310 Backpack Brushcutter");
check("PHT750", T.expand("PHT750"), "PHT750 Short Pole Trimmer");
check("LHT240TB26", T.expand("LHT240TB26"), "LHT240TB26 Long Pole Trimmer");

console.log("\n-- the five 525s, which are five different machines --");
check("525RX", T.expand("525RX"), "525RX Backpack Brushcutter");
check("525BX", T.expand("525BX"), "525BX Handheld Blower");
check("525iB", T.expand("525iB"), "525iB Battery Handheld Blower");
check("525HE4", T.expand("525HE4"), "525HE4 Long Pole Trimmer");
check("525HF3S", T.expand("525HF3S"), "525HF3S Short Pole Trimmer");

console.log("\n-- and the other families that shadow each other --");
// 536LiXP is a chainsaw, 536LiB is a blower. One letter.
check("536LiXP is a chainsaw", T.typeFor("536LiXP"), "Battery Chainsaw");
check("536LiB is a blower", T.typeFor("536LiB"), "Battery Backpack Blower");
check("T536LiXP too", T.typeFor("T536LiXP"), "Battery Chainsaw");
// 120i is a chainsaw, 120iB is a blower.
check("120i is a chainsaw", T.typeFor("120i"), "Battery Chainsaw");
check("120iB is a blower", T.typeFor("120iB"), "Battery Handheld Blower");
// 530iB is a handheld blower, 530BT a backpack one.
check("530iB", T.typeFor("530iB"), "Battery Handheld Blower");
check("530BT", T.typeFor("530BT"), "Backpack Blower");

console.log("\n-- a model is never matched inside a longer one --");
// The failure this guards: a prefix match on "525" or "120i" labelling the
// wrong machine. Nothing here is on the list, so nothing should be added.
["525", "120", "EBZ", "BK", "PHT", "5251", "EBZ51000", "XBK4310"].forEach((s) => {
  check(`"${s}" matches nothing`, T.typeFor(s), "");
});
check("and is printed exactly as typed", T.expand("525"), "525");

console.log("\n-- written among other words, it still reads --");
check("with the brand in front",
  T.expand("Zenoah EBZ5100"), "Zenoah EBZ5100 Backpack Blower");
check("with a serial after it",
  T.expand("EBZ5100 967284302"), "EBZ5100 967284302 Backpack Blower");
check("with the app's own 1/2 suffix",
  T.expand("EBZ5100 - 1/2"), "EBZ5100 - 1/2 Backpack Blower");
check("in brackets, as AutoCount writes it",
  T.expand("EBZ5100(AS)"), "EBZ5100(AS) Backpack Blower");
check("lower case", T.expand("ebz5100"), "ebz5100 Backpack Blower");
check("HBZ260EZ, the long spelling", T.expand("HBZ260EZ"), "HBZ260EZ Handheld Blower");
check("HBZ260, the short one", T.expand("HBZ260"), "HBZ260 Handheld Blower");

console.log("\n-- somebody who already said what it is, is left alone --");
// The failure this guards: "EBZ5100 Backpack Blower Backpack Blower".
check("the exact type", T.expand("EBZ5100 Backpack Blower"), "EBZ5100 Backpack Blower");
check("their own words for it",
  T.expand("ZENOAH EBZ5100(AS) Backpack Leaf Blower 50.2cc"),
  "ZENOAH EBZ5100(AS) Backpack Leaf Blower 50.2cc");
check("a different kind of blower still counts as said",
  T.expand("EBZ5100 Blower"), "EBZ5100 Blower");
check("a chainsaw that says so", T.expand("120i Chainsaw"), "120i Chainsaw");

console.log("\n-- a machine nobody listed is printed as typed --");
check("a chainsaw not on the list", T.expand("Husqvarna 572XP"), "Husqvarna 572XP");
check("a hand-written oddity", T.expand("Wright stander B"), "Wright stander B");
check("empty stays empty", T.expand(""), "");
check("and null does not become the word null", T.expand(null), "");

console.log("\n-- AutoCount's ItemCategory, for models not on the list --");
// Read off the live catalogue on 15 Sep 2026. The field already holds words,
// so nothing is decoded - only cased, because John's list is title case and
// one document should not read "EBZ5100 Backpack Blower" beside "572XP
// CHAINSAW".
check("CHAINSAW", T.fromCategory("CHAINSAW"), "Chainsaw");
check("HEDGE TRIMMER", T.fromCategory("HEDGE TRIMMER"), "Hedge Trimmer");
check("LEAF BLOWER", T.fromCategory("LEAF BLOWER"), "Leaf Blower");
check("BRUSH CUTTER", T.fromCategory("BRUSH CUTTER"), "Brush Cutter");
check("WATER PUMP", T.fromCategory("WATER PUMP"), "Water Pump");
check("POLE SAW", T.fromCategory("POLE SAW"), "Pole Saw");
check("RIDE-ON MOWER keeps its small o", T.fromCategory("RIDE-ON MOWER"), "Ride-on Mower");

console.log("\n-- categories that are not a kind of machine are ignored --");
// A slip is for equipment. "Husqvarna jacket APPAREL" is not a description of
// a repair, and these categories exist because the catalogue also sells them.
["APPAREL", "PPE", "MERCHANDISE", "TOOLS", "SP"].forEach((c) => {
  check(c, T.fromCategory(c), "");
});
check("and an empty category", T.fromCategory(""), "");
check("or a missing one", T.fromCategory(null), "");

console.log("\n-- the list beats AutoCount, because it knows more --");
// AutoCount files every blower as LEAF BLOWER. The list knows a backpack one
// from a handheld one, so it is asked first.
check("EBZ5100 is a backpack blower, not a leaf blower",
  T.expand("EBZ5100", "LEAF BLOWER"), "EBZ5100 Backpack Blower");
check("525BX is a handheld one", T.expand("525BX", "LEAF BLOWER"), "525BX Handheld Blower");
check("and an unlisted model takes what AutoCount says",
  T.expand("Husqvarna 572XP", "CHAINSAW"), "Husqvarna 572XP Chainsaw");
check("an unlisted model with no category is printed as typed",
  T.expand("Wright stander B", ""), "Wright stander B");
check("a category nobody should print is ignored",
  T.expand("Husqvarna jacket", "APPAREL"), "Husqvarna jacket");
check("and a machine that already says it is left alone",
  T.expand("Portable sprayer", "SPRAYER"), "Portable sprayer");

console.log("\n-- the list itself holds together --");
// A model in two types would make the answer depend on object key order,
// which is the kind of bug that shows up on one machine and not another.
const seen = {};
const dupes = [];
for (const type of Object.keys(T.BY_TYPE)) {
  for (const model of T.BY_TYPE[type]) {
    const k = model.toUpperCase();
    if (seen[k] && seen[k] !== type) dupes.push(`${model}: ${seen[k]} / ${type}`);
    seen[k] = type;
  }
}
check("no model appears under two types", dupes, []);
check("every model has digits in it",
  Object.keys(T.TYPE_OF).filter((m) => !/[0-9]/.test(m)), []);
check("the head nouns it checks for",
  [...T.TYPE_WORDS].sort(), ["BLOWER", "BRUSHCUTTER", "CHAINSAW", "TRIMMER"]);
// Nine types and forty model strings - John's thirty-nine entries, with
// HBZ260 and HBZ260EZ counted separately because both get typed.
check("nine types, forty models",
  [Object.keys(T.BY_TYPE).length, Object.keys(T.TYPE_OF).length], [9, 40]);

console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
process.exit(failures ? 1 : 0);
