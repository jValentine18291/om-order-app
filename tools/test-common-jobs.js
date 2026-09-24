// The buttons that go on any machine: a weld, an oil change, a carburettor
// service, a yellow fuel pipe.
//
//   node tools/test-common-jobs.js C:/temp/scratch.db
//
// THE RULE THIS GUARDS
// Welding and Service Carburetor are both "A7 SVR WAREHOUSE", at $30 and at
// nothing. machine_parts merges on (machine, item_code, technician, variant),
// so without a variant those two would collapse into one line at a figure that
// is neither - the same trap the fogger tubes fell into, where four tube types
// share Z00126.03. Each job carries its id as the variant, and this checks
// that the two survive as two.
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

// common-jobs.js is a browser file - an IIFE that hangs itself off window.
// Give it a window and read it back, the same way fogger-tubes.js is tested.
global.window = {};
new Function(fs.readFileSync(path.resolve(__dirname, "..", "frontend", "common-jobs.js"), "utf8"))();
const J = global.window.OM_JOBS;

console.log("\n-- the table itself --");
check("it checks out", J.check(), []);
check("the jobs, in the order they were asked for",
  J.list.map((j) => j.title),
  ["Welding", "Change Engine Oil", "Service Carburetor & Labour", "Yellow Fuel Pipe",
   "No Servicing", "HS-B6 Spark Plug", "Core Wire"]);

console.log("\n-- which machines each button is on --");
// Two of them are fogger parts and must not appear on a chainsaw job. The
// split is answered in this file rather than on the screen, so that "what does
// it cost" and "who sees it" cannot drift apart.
check("the everyday buttons, on every machine",
  J.everyday().map((j) => j.title),
  ["Welding", "Change Engine Oil", "Service Carburetor & Labour", "Yellow Fuel Pipe",
   "No Servicing"]);
check("and the two only a fogger gets",
  J.foggerOnly().map((j) => [j.title, j.code, j.price]),
  [["HS-B6 Spark Plug", "M0815SK ESB7", 4], ["Core Wire", "A8 SPARE PARTS", 3]]);
check("between them that is every job, counted once",
  J.everyday().length + J.foggerOnly().length, J.list.length);
// The plug is the first job on a REAL catalogue code rather than an A6-A8
// placeholder, which is what decides whose description goes on the line -
// see addJobToMachine(). A5-A8 and MISC are the placeholder codes.
const placeholder = (c) => /^A[5-8]\b/.test(c) || c.startsWith("MISC");
check("the plug is a real catalogue part, so the line takes AutoCount's wording",
  placeholder(J.byId("PLUG").code), false);
check("the core wire is a placeholder code, so the line takes the button's",
  placeholder(J.byId("CORE").code), true);
// A8 SPARE PARTS, plural - the spelling the catalogue actually holds, and the
// same one the Yellow Fuel Pipe uses. Singular does not resolve.
check("and it uses the same A8 code the fuel pipe does",
  J.byId("CORE").code, J.byId("PIPE").code);

// TWO KINDS, and the difference is the whole of what keeps one off a bill.
// A priced job adds a line; a comment job writes a note and adds nothing.
// Sorted here rather than asserted together, because a comment job has no
// price and no quantity and listing it among them as null reads as a job whose
// price somebody forgot to fill in.
const priced = J.list.filter((j) => !j.comment);
const notes = J.list.filter((j) => j.comment);
check("six of them add a priced line", priced.map((j) => j.title),
  ["Welding", "Change Engine Oil", "Service Carburetor & Labour", "Yellow Fuel Pipe",
   "HS-B6 Spark Plug", "Core Wire"]);
check("at the prices given", priced.map((j) => j.price), [30, 9, 0, 3, 4, 3]);
check("one of each", priced.map((j) => j.qty), [1, 1, 1, 1, 1, 1]);
check("and one writes a comment instead", notes.map((j) => [j.title, j.comment]),
  [["No Servicing", "No servicing"]]);
check("which carries no code, no price and no quantity to bill",
  notes.map((j) => [j.code, j.price, j.qty]), [[undefined, undefined, undefined]]);
check("two of them share the warehouse service code",
  J.list.filter((j) => j.code === "A7 SVR WAREHOUSE").map((j) => j.title),
  ["Welding", "Service Carburetor & Labour"]);
check("and every job has an id of its own",
  new Set(J.list.map((j) => j.id)).size, J.list.length);

// The ids are written to the same column the tube types use, so a collision
// would make a weld look like a tube to everything that reads a line back.
global.window.FOGGER_TUBES = undefined;
new Function(fs.readFileSync(path.resolve(__dirname, "..", "frontend", "fogger-tubes.js"), "utf8"))();
const tubeTypes = new Set(global.window.FOGGER_TUBES.list.map((t) => t.type));
check("no job id is also a tube type",
  J.list.map((j) => j.id).filter((id) => tubeTypes.has(id)), []);

console.log("\n-- a weld and a carburettor service stay two lines --");
const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const slip = data.slips.createSlip({
  company: "JOBS CO", contact_name: "A", contact_number: "1", signature: SIG,
  machines: [{ desc: "BK3410 Brushcutter", serial: "J1", remarks: "" }],
});
const mid = data.slips.getSlip(slip.slip_number).machines[0].id;

const add = (id, tech = "WJ") => {
  const j = J.byId(id);
  return data.slips.addPartToMachine(mid, {
    item_code: j.code, description: j.title, uom: "NOS",
    unit_price: j.price, quantity: j.qty, variant: j.id, technician: tech,
    free_text: true,
  });
};

let parts = add("WELD");
parts = add("CARB");
check("two lines, not one", parts.length, 2);
check("each with its own wording",
  parts.map((p) => p.description).sort(), ["Service Carburetor & Labour", "Welding"]);
check("and its own price", parts.map((p) => p.unit_price).sort((a, b) => a - b), [0, 30]);
check("both under the one service code",
  [...new Set(parts.map((p) => p.item_code))], ["A7 SVR WAREHOUSE"]);

console.log("\n-- the same job twice is two jobs --");
// A7 is a free-text code, and these lines never stack: two welds on one
// machine are two pieces of work, each with its own wording and its own price
// if somebody changes one. Quantity on a line like this means "two of THIS
// one", which only the person who named it can say.
parts = add("WELD");
check("three lines now", parts.length, 3);
check("two of them welds", parts.filter((p) => p.variant === "WELD").length, 2);
check("each still one of itself",
  parts.filter((p) => p.variant === "WELD").map((p) => p.quantity), [1, 1]);
check("and the money is the same either way",
  parts.filter((p) => p.variant === "WELD")
       .reduce((n, p) => n + p.unit_price * p.quantity, 0), 60);

console.log("\n-- the oil change is its own line --");
parts = add("OIL");
check("four lines", parts.length, 4);
check("on the engine oil code",
  parts.find((p) => p.variant === "OIL").item_code, "A6 SVR ENGINE OIL");
check("at nine dollars", parts.find((p) => p.variant === "OIL").unit_price, 9);

console.log("\n-- the fuel pipe goes on A8, and two of them are two lines --");
// A8 is the spare-parts code rather than a service one, and the catalogue
// carries no part number for a pipe cut off a roll - which is the whole reason
// it is a button rather than something to find in Find Part. Two pipes are two
// lines for the same reason two welds are: A8 is free text, so the wording on
// one can be edited without silently relabelling the other.
parts = add("PIPE");
parts = add("PIPE");
const pipes = parts.filter((p) => p.variant === "PIPE");
check("two pipe lines", pipes.length, 2);
check("on the spare parts code",
  [...new Set(pipes.map((p) => p.item_code))], ["A8 SPARE PARTS"]);
check("at three dollars each", pipes.map((p) => p.unit_price), [3, 3]);
check("and they do not stack", pipes.map((p) => p.quantity), [1, 1]);
// A8 at nothing is NOT one of these jobs priced at nothing on purpose - the
// pipe costs $3 - so an A8 line with no price must still be flagged for
// somebody to fill in.
check("an A8 line at no price is still a gap",
  J.zeroIsDeliberate({ item_code: "A8 SPARE PARTS", unit_price: 0, variant: "PIPE" }), false);

console.log("\n-- a price of nothing is an answer, not a gap --");
// The screen flags a part with no price so somebody fills it in. The
// carburettor service costs nothing on purpose - the money is in the machine's
// Labour Charge - so it must not be flagged, or every carburettor job carries
// a warning nobody can clear.
const carb = parts.find((p) => p.variant === "CARB");
check("the carburettor service is deliberately free", J.zeroIsDeliberate(carb), true);
check("the weld is not", J.zeroIsDeliberate(parts.find((p) => p.variant === "WELD")), false);
// Asked of the LINE, so it survives a save and reload rather than depending on
// anything the screen still happens to be holding.
const reloaded = data.slips.getSlip(slip.slip_number).machines[0].parts
  .find((p) => p.variant === "CARB");
check("and it still reads that way off the database", J.zeroIsDeliberate(reloaded), true);
// A genuinely unpriced catalogue part must STILL be flagged.
check("an ordinary part at zero is a gap",
  J.zeroIsDeliberate({ item_code: "SZEN 848CE037A0", unit_price: 0, variant: "" }), false);
// And an A7 line at zero that is not one of these jobs is a gap too: the guard
// is the job, not the code.
check("so is an A7 line nobody added from a button",
  J.zeroIsDeliberate({ item_code: "A7 SVR WAREHOUSE", unit_price: 0, variant: "" }), false);

console.log("\n-- what reaches the Sales Order --");
data.slips.setMachineLabour(mid, 40);
data.slips.finishRepair(mid, "WJ");
data.slips.createSlipOrder(slip.slip_number, [mid], "KS");
const lines = data.slips.getSlipOrder(slip.slip_number).lines;
const a7 = lines.filter((l) => l.item_code === "A7 SVR WAREHOUSE");
check("every A7 line is on the order", a7.length, 3);
check("saying which job each one is",
  a7.map((l) => l.description).sort(),
  ["Service Carburetor & Labour", "Welding", "Welding"]);
check("at their own prices", a7.map((l) => l.unit_price).sort((a, b) => a - b), [0, 30, 30]);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
