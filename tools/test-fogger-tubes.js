// PulsFOG tubes: cut from a roll, so a repair uses a fraction of a stock unit.
//
//   node tools/test-fogger-tubes.js C:/temp/scratch.db
//
// The rule this guards: two tube types cut from the SAME roll must stay two
// lines. machine_parts merges on (machine, item_code, technician), and tubes
// 222 and 311 are both Z00126.03 at different prices - so before `variant`
// existed, a technician adding one of each got a single merged line at a
// figure that was neither of them, with nothing downstream to question it.
//
// It also guards the fractions themselves. The quantity column is declared
// INTEGER; SQLite keeps a fraction rather than truncating it, but that is the
// kind of thing that holds until someone "tidies" a cast somewhere, so it is
// worth a test that would notice.
const path = require("path");
const fs = require("fs");
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

// ---- the table -------------------------------------------------------------
// fogger-tubes.js is a browser file: an IIFE that hangs itself off window.
// Give it a window and read it back.
global.window = {};
new Function(fs.readFileSync(path.resolve(__dirname, "..", "frontend", "fogger-tubes.js"), "utf8"))();
const T = global.window.FOGGER_TUBES;

console.log("\n-- the sheet agrees with itself --");
check("every tube's qty x price lands on its printed each-price", T.check(), []);
check("ten tubes, in the order the sheet lists them",
  T.list.map((t) => t.type),
  ["222", "311", "178", "142", "S310", "122y", "140", "141", "170", "96y"]);
check("four tube types share Z00126.03",
  T.list.filter((t) => t.code === "SPUL KACC Z00126.03").map((t) => t.type),
  ["222", "311", "178", "142"]);
check("and they carry four different prices",
  [...new Set(T.list.filter((t) => t.code === "SPUL KACC Z00126.03").map((t) => t.unitPrice))],
  [25, 26.6, 23.5, 20]);

console.log("\n-- which machines get the buttons --");
for (const [desc, want] of [
  ["PulsFOG K-10-SP", true],
  ["K10SP", true],
  ["Pulsfog K 10 SP Thermal Fogger", true],
  ["PulseFog K10", true],           // misspelled the way people do
  ["thermal fogging machine", true],
  ["Husqvarna 525LK Brushcutter", false],
  ["Zenoah G3800 Chainsaw", false],
  ["", false],
]) check(`"${desc}"`, T.looksLikeFogger(desc), want);

// ---- the fraction survives the round trip ----------------------------------
const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const slip = data.slips.createSlip({
  company: "Fogger Co", contact_name: "A", contact_number: "1", signature: SIG,
  machines: [{ desc: "PulsFOG K-10-SP", serial: "F1" }],
});
const machineId = data.slips.getSlip(slip.slip_number).machines[0].id;

const add = (type, pieces, tech = "WJ") => {
  const t = T.byType(type);
  return data.slips.addPartToMachine(machineId, {
    item_code: t.code,
    description: `PULSFOG TUBE ${t.type}`,
    uom: "ROLL",
    unit_price: t.unitPrice,
    quantity: Number((pieces * t.unitQty).toFixed(4)),
    variant: t.type,
    technician: tech,
  });
};

console.log("\n-- a fraction of a roll, not a whole one --");
let parts = add("142", 2);
check("tube 142 x 2 is stored as the fraction", parts[0].quantity, 0.53);
check("at the roll price", parts[0].unit_price, 20);
check("so the line comes to", Number((parts[0].quantity * parts[0].unit_price).toFixed(2)), 10.6);
check("and the tube type is kept against the line", parts[0].variant, "142");

console.log("\n-- two tubes off the SAME roll stay two lines --");
parts = add("311", 1);
check("222/311/142 all being Z00126.03 does not merge them", parts.length, 2);
check("each keeps its own tube type", parts.map((p) => p.variant), ["142", "311"]);
check("each keeps its own price", parts.map((p) => p.unit_price), [20, 26.6]);
// 142 x 2 = 0.53 x $20.00 = $10.60, plus 311 x 1 = 0.075 x $26.60 = $1.995.
// Merged into one Z00126.03 line the old way it would have been 0.605 at
// whichever price landed first - $12.10 at $20.00, or $16.09 at $26.60.
// Neither is $12.60, and nothing downstream would have caught it.
check("total is the sum of both, not a merged guess",
  Number(parts.reduce((n, p) => n + p.unit_price * p.quantity, 0).toFixed(2)),
  12.6);

console.log("\n-- the same tube again tops the line up --");
parts = add("142", 1);
check("still two lines", parts.length, 2);
check("and 142 is now three pieces' worth", parts.find((p) => p.variant === "142").quantity, 0.795);

console.log("\n-- a different technician keeps their own line --");
parts = add("142", 1, "XL");
check("three lines now", parts.length, 3);
check("WJ's 142 is untouched",
  parts.filter((p) => p.variant === "142" && p.technician === "WJ").map((p) => p.quantity), [0.795]);

console.log("\n-- pieces can always be read back out of the fraction --");
// This is what the screen shows the technician, so a rounding slip here is a
// wrong number in front of someone holding the part.
let wrong = [];
for (const t of T.list) {
  for (let n = 1; n <= 5; n++) {
    const stored = Number((n * t.unitQty).toFixed(4));
    const back = Math.max(1, Math.round(stored / t.unitQty));
    if (back !== n) wrong.push(`${t.type} x ${n} read back as ${back}`);
  }
}
check("every tube, one to five pieces", wrong, []);

console.log("\n-- an ordinary part is unaffected --");
parts = data.slips.addPartToMachine(machineId, {
  item_code: "SZEN 848BE058B2", description: "GASKET", unit_price: 4.5, quantity: 1, technician: "WJ",
});
const gaskets = () => parts.filter((p) => p.item_code === "SZEN 848BE058B2");
check("added", gaskets().length, 1);
parts = data.slips.addPartToMachine(machineId, {
  item_code: "SZEN 848BE058B2", description: "GASKET", unit_price: 4.5, quantity: 1, technician: "WJ",
});
check("and the same part again still merges as it always did", gaskets().length, 1);
check("with the quantity added up", gaskets()[0].quantity, 2);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
