// A DELETED SLIP'S NUMBER, OFFERED BACK AT REGISTRATION.
// Run against a throwaway database, never the real one:
//
//   node tools/test-slip-number-reuse.js C:/temp/scratch.db
//
// John, 30 Sep 2026: he deleted 00108 and remade it, and it came out 00114 -
// 00109 to 00113 already existed, and a number is only handed back by itself
// when the deleted slip was the last one. His answer: a dropdown at the top of
// Register, defaulted to the next number, listing any unused ones behind it.
// This walks his exact case, and the two ways it could go wrong: two people
// picking the same gap, and a number that is not a gap at all.
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
const refuse = async (what, fn, re, status) => {
  let err = "", st = 0;
  try { await fn(); } catch (e) { err = e.message; st = e.status; }
  const ok = re.test(err) && (!status || st === status);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(err)} (${st})`);
};
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const make = (company, slip_number = "") => data.slips.createSlip({
  company, contact_name: "A", contact_number: "1", signature: sig, slip_number,
  machines: [{ desc: "HBZ260EZ Handheld Blower", serial: "X", remarks: "" }],
});

(async () => {
  console.log("-- a clean book has nothing unused --");
  const first = [];
  for (const c of ["AARDWOLF", "ATL MAINTENANCE", "TROPIC PLANNERS", "SWIA", "HORNE TRADING"]) {
    first.push((await make(c)).slip_number);
  }
  let r = await data.slips.freeSlipNumbers();
  check("nothing to offer", r.free, []);
  const nextBefore = r.next;
  check("and the next number follows the last", Number(nextBefore), Number(first[4]) + 1);

  console.log("\n-- John's case: a slip in the MIDDLE is deleted --");
  const gap = first[1];   // ATL MAINTENANCE, with slips after it
  await data.slips.deleteSlip(gap, "J");
  r = await data.slips.freeSlipNumbers();
  check("its number is offered", r.free.map((f) => f.slip_number), [gap]);
  check("with who it belonged to", r.free[0].was, "ATL MAINTENANCE");
  check("and the next number has not moved", r.next, nextBefore);

  console.log("\n-- registered again, on its old number --");
  const again = await make("ATL MAINTENANCE", gap);
  check("the slip takes the number picked", again.slip_number, gap);
  r = await data.slips.freeSlipNumbers();
  check("which is no longer offered", r.free, []);
  check("and the next number is still what it was", r.next, nextBefore);
  const plain = await make("NATURE LANDSCAPES");
  check("so the next ordinary slip is not thrown off", plain.slip_number, nextBefore);

  console.log("\n-- two people picking the same gap --");
  await data.slips.deleteSlip(first[2], "J");
  await make("SPOTLESS", first[2]);
  await refuse("the second is told it was just taken",
    () => make("SOMEONE ELSE", first[2]), /just taken/, 409);

  console.log("\n-- a number that is not a gap --");
  await refuse("an existing slip's number", () => make("X", first[0]), /just taken/, 409);
  await refuse("a number ahead of the next one",
    () => make("X", String(Number(nextBefore) + 50)), /not an unused slip number/, 400);
  await refuse("something that is not a number", () => make("X", "12a"), /not a slip number/, 400);

  console.log("\n-- the ordinary path is untouched --");
  const n1 = (await make("PLAIN 1")).slip_number;
  const n2 = (await make("PLAIN 2")).slip_number;
  check("consecutive slips get consecutive numbers", Number(n2) - Number(n1), 1);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
