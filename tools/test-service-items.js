// Which AutoCount service item opens a machine's block.
//
//   node tools/test-service-items.js
//
// WHY THIS MATTERS
// A1 landscape, A2 pest management, A3 ride-on, A12 Automower are accounted for
// separately. Bill a rider under A1 and the sale is filed as landscaping
// equipment, and somebody has to find it and correct it afterwards - which is
// what these rules exist to stop.
//
// The codes and wording below were read out of the live AutoCount catalogue,
// not typed from memory. The machine names are real: every one is a machine
// AutoCount actually holds, or a description copied off a live service slip.
const path = require("path");
const S = require(path.resolve(__dirname, "..", "frontend", "service-items.js"));
const FOGGER = require(path.resolve(__dirname, "..", "frontend", "fogger-tubes.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
// How a machine reaches these rules: a code from AutoCount, a description, or
// on a hand-written slip only the description.
const M = (code, desc) => ({ machine_code: code, machine_desc: desc });
const key = (m) => S.keyFor(m, FOGGER.isFogger);

console.log("-- the four items, as AutoCount spells them --");
check("A1", S.ITEMS.A1.item_code, "A1 SVR LANDSCAPE");
check("A2", S.ITEMS.A2.item_code, "A2 SVR PEST MGT EQUIPT");
check("A3", S.ITEMS.A3.item_code, "A3 SVR RIDE-ON EQUIPT");
check("A12", S.ITEMS.A12.item_code, "A12 SVR AUTOMOWER");
check("and they are offered in that order", S.KEYS, ["A1", "A2", "A3", "A12"]);

console.log("\n-- A3: every Ferris --");
check("a zero-turn from the catalogue",
  key(M("UBNS IS2600ZY24D61 5901722", 'FERRIS IS2600Z Zero-Turn Mower (61" iCD Deck)')), "A3");
check("the same machine written lower case",
  key(M("UBNS IS600ZB2548 5902112", 'Ferris IS600Z - Zero-Turn Mower (48" Deck)')), "A3");
check("and hand-written on a slip with no code", key(M("", "Ferris IS700Z")), "A3");

console.log("\n-- A3: every Grasshopper --");
check("by name",
  key(M("UGRH 226V-G4 534091", "GRASSHOPPER 226V-G4 Zero Turn Lawn Mower")), "A3");
check("and by its code alone", key(M("UGRH 400D 534192", "")), "A3");

console.log("\n-- A3: the Husqvarna riders on John's list --");
[["UHUQ P525DX 967985301", "Husqvarna P525DX Commercial Front Mower (Body w/o Deck)"],
 ["UHUQ R213C 967846601", "Husqvarna R213C Rider  (Body w Deck)"],
 ["UHUQ R420TsX 967648401", "Husqvarna R420TsX All-Wheel-Drive (AWD) Rider"],
 ["UHUQ TS242D 960410442", 'Husqvarna TS242D Tractor Mower 42"'],
 ["UHUQ Z242F 967665703", "HUSQVARNA Z242F Zero Turn Mower BNS Engine"],
 ["UHUQ TS342 960410386", 'TS342 Tractor Mower 42" B&S 21HP']].forEach(([c, d]) => {
  check(d.slice(0, 44), key(M(c, d)), "A3");
});
// R214C is on the list although AutoCount does not stock it. The rule is here
// for the day it does.
check("R214C, which nothing stocks yet", key(M("", "Husqvarna R214C Rider")), "A3");

console.log("\n-- and a model that is NOT on the list stays A1 --");
// TS242D is listed; TS242 is not. Close is not the same, and a machine nobody
// named should fall to A1 rather than be guessed into A3.
check("TS242 without the D", key(M("", "Husqvarna TS242 Tractor Mower")), "A1");
check("a walk-behind Husqvarna", key(M("UHUQ 525LK 967157402", "Husqvarna 525LK Combi")), "A1");
check("a Husqvarna chainsaw", key(M("UHUQ 572XP 967690801", "Husqvarna 572XP Chainsaw")), "A1");

console.log("\n-- A12: every Husqvarna Automower --");
[["UHUQ AM535AWD 970745521", "HUSQVARNA 535AWD EPOS Robotic Automower"],
 ["UHUQ AM550 970800903", "HUSQVARNA AM550 EPOS Robotic Automower"],
 ["UHUQ AM315MKII 970526803", "HUSQVARNA Robotic Automower 315 Mark II"],
 ["UHUQ AM105 967645421", "Robotic Automower 105"]].forEach(([c, d]) => {
  check(d.slice(0, 44), key(M(c, d)), "A12");
});
check("and AM450X, the way the workshop writes it", key(M("", "AM450X")), "A12");

console.log("\n-- an Automower is not a ride-on, though it mows --");
check("it takes A12, not A3", key(M("UHUQ AM550 970800903", "HUSQVARNA AM550 EPOS Robotic Automower")), "A12");

console.log("\n-- \"AM\" inside a word is not an Automower --");
// Without a word boundary "TEAM 500" reads as AM500. This is the check that
// stops a stray match putting a sprayer under the Automower item.
check("TEAM 500", key(M("", "TEAM 500 Sprayer")), "A1");
check("PROGRAM 250", key(M("", "PROGRAM 250")), "A1");

console.log("\n-- A2 still wins for a fogger, before anything else --");
check("a PulsFOG", key(M("UPUL K10SP", "pulsFOG K-10-SP Thermal Fogger")), "A2");
check("and one written by hand", key(M("", "pulsFOG Thermal Fogger c/w Tools & Acc")), "A2");

console.log("\n-- what an override is allowed to replace --");
check("a service code is recognised", S.isServiceCode("A3 SVR RIDE-ON EQUIPT"), true);
check("whatever its case", S.isServiceCode("a12 svr automower"), true);
check("a spare part is not", S.isServiceCode("SZEN 848KD35820"), false);
check("nor is a blank", S.isServiceCode(""), false);

console.log("\n-- every item has wording to print --");
S.KEYS.forEach((k) => {
  const it = S.ITEMS[k];
  check(`${k} has a description and a label`,
    !!(it.description && it.description.trim() && it.label && it.label.trim()), true);
});

console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
process.exit(failures ? 1 : 0);
