// THE EBZ4800 BOOK, AS SHIPPED.
//
//   node tools/test-ipl-ebz4800.js
//
// Zenoah's EBZ4800 backpack blower (5 Nov 2026): text parts tables, scanned
// drawings. Checked on the shipped data, because that is what gets tapped.
//   - the carburettor page's "[NOTE]" box was read as five parts ("[NOTE]",
//     "as", "as" ...); it is the note now, on the starred rows it is about
//   - five callouts were a two-digit number read as its last digit - 71 as 1,
//     17 as 1, 15 and 25 as 5, 28 as 8 - corrected in ipl-ebz4800.hotspots.txt
//   - and every part on every sheet has something to tap
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const book = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "frontend", "ipl", "ebz4800.json"), "utf8"));
const carb = book.figures.find((f) => f.title.startsWith("CARBURETOR"));
const engine = book.figures.find((f) => f.title.startsWith("ENGINE"));
const at = (f, x, y) => f.hotspots.filter((h) => Math.abs(h.x - x) < 0.5 && Math.abs(h.y - y) < 0.5).map((h) => h.key);

console.log("-- the carburettor's note --");
check("no part made of the note's words",
  carb.parts.filter((p) => !/^\d+\*?$/.test(p.key)).map((p) => p.key), []);
check("26* and 27* say they come only as the whole carburettor",
  ["26*", "27*"].map((k) => /848L388100/.test(carb.parts.find((p) => p.key === k).remarks)), [true, true]);

console.log("\n-- the misreads, put right --");
check("Engine 71 is 71, not 1", at(engine, 15.77, 82.15), ["71"]);
check("Carburettor 17, 15, 25, 28",
  [at(carb, 66.49, 40.37), at(carb, 32.92, 41.99), at(carb, 45.54, 34.95), at(carb, 28.65, 37.29)],
  [["17"], ["15"], ["25"], ["28"]]);

console.log("\n-- everything can be tapped --");
check("every part on every sheet has a hotspot",
  book.figures.flatMap((f) => [...new Set(f.parts.map((p) => p.key))]
    .filter((k) => !f.hotspots.some((h) => h.key === k)).map((k) => f.id + ":" + k)), []);
check("and every hotspot names a part on its sheet",
  book.figures.flatMap((f) => f.hotspots.filter((h) => !f.parts.some((p) => p.key === h.key))).length, 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
