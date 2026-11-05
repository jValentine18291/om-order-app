// THE FIRST FERRIS BOOK, AS SHIPPED.
//
//   node tools/test-ipl-ferris.js
//
// The IS600Z (Mfg. No. 5902112), read from Briggs & Stratton's Parts Manual by
// tools/ipl-extract-ferris.py, 5 Nov 2026. Checked on the shipped data - the
// file a technician's phone downloads - because that is what gets tapped.
//
// Each check is a way this layout could have gone wrong and did, or nearly did,
// while the reader was being written:
//   - two rows on one REF NO, split by serial number (the caster yoke, 0180)
//   - the notes under a row: serial ranges, torque figures - and the book's
//     own unbalanced bracket in "(88 Nm)"
//   - "-----", a part sold only in a kit
//   - the page footer ("31  04-Nov-2026") read as the last row's note
//   - the diagonal "Not For Reproduction" watermark read as a note
//   - the four electrical schematics, whose one row carries its part number
//     in the REF NO column
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const dir = path.resolve(__dirname, "..", "frontend", "ipl");
const book = JSON.parse(fs.readFileSync(path.join(dir, "ferrisis600z.json"), "utf8"));
const fig = (title) => book.figures.find((f) => f.title.startsWith(title));
const rows = (title, key) => fig(title).parts.filter((p) => p.key === key);
const all = book.figures.flatMap((f) => f.parts);

console.log("-- the book --");
check("32 sheets, every one with its drawing", book.figures.filter((f) =>
  fs.existsSync(path.join(dir, f.image))).length, 32);
check("the transaxle is one figure on two sheets",
  book.figures.filter((f) => f.title.startsWith("Transaxle SERVICE")).map((f) => `${f.number}:${f.sheet}/${f.sheets}`),
  ["30:1/2", "30:2/2"]);

console.log("\n-- rows the layout makes hard --");
check("the caster yoke: two parts on 0180, by serial",
  rows("Main Frame", "0180").map((p) => [p.part_number, p.remarks]),
  [["5402208BFS", "S/N: 4000771923 and below"], ["5419196BFS", "S/N: 4000771924 and above"]]);
check("a torque figure, with the book's own bracket kept",
  rows("Engine & PTO", "0120")[0].remarks, "Torque clutch mounting bolt to 65 ft-lbs (88 Nm)");
check("a kit-only part keeps its row and says why it has no number",
  [rows("Engine & PTO", "0200")[0].part_number, rows("Engine & PTO", "0200")[0].remarks.startsWith("Part of a kit")],
  ["", true]);
check("each schematic has its harness",
  book.figures.filter((f) => f.title.startsWith("Electrical Schematic")).map((f) => f.parts.map((p) => p.part_number).join()),
  ["5105536", "5105536", "5105536", "5105536"]);

console.log("\n-- nothing from around the table got in --");
check("no page footer in any note", all.filter((p) => /\d{2}-[A-Z][a-z]{2}-\d{4}/.test(p.remarks)).length, 0);
check("no watermark in any note or description",
  all.filter((p) => /Reproduction|^Not$|^For$/.test(p.remarks) || /Reproduction/.test(p.description)).length, 0);
check("every row has a description", all.filter((p) => !p.description).length, 0);

console.log("\n-- the search term AutoCount is asked with --");
// AutoCount holds SBNS 5025156 bare and SBNS 5050878X2YP with its finish, so
// the search drops the finish letters and its prefix match finds either.
check("finish letters off, length code kept",
  [all.find((p) => p.part_number === "5025013X14SM").search, all.find((p) => p.part_number === "5025156FS").search],
  ["5025013X14", "5025156"]);

console.log("\n-- the callouts --");
const spots = book.figures.flatMap((f) => f.hotspots.map((h) => ({ f, h })));
check("every hotspot names a part on its own sheet",
  spots.filter(({ f, h }) => !f.parts.some((p) => p.key === h.key)).length, 0);
check("and sits on the page", spots.filter(({ h }) => !(h.x > 0 && h.x < 100 && h.y > 0 && h.y < 100)).length, 0);
// The corrections from checking all 786 by eye (tools/ipl-ferrisis600z.hotspots.txt).
const engine = fig("Engine & PTO");
check("the Engine's top 0010 is 0010, not the 0070 it was read as",
  engine.hotspots.filter((h) => Math.abs(h.x - 35.35) < 1 && Math.abs(h.y - 9.92) < 1).map((h) => h.key), ["0010"]);
const tx = book.figures.find((f) => f.title.startsWith("Transaxle SERVICE") && f.sheet === 1);
check("no transaxle tap on the printed notes",
  tx.hotspots.filter((h) => h.x < 30 && h.y > 18 && h.y < 27 && h.key !== "200").length, 0);
// Left untapped, each because the book does not number it on a drawing: the
// schematics' harness is the whole drawing; 0030-80, 41 and kit 1000 are not
// printed; the seat's pieces are not drawn apart from the seat.
check("what has no tap point, and only that",
  book.figures.flatMap((f) => [...new Set(f.parts.map((p) => p.key))]
    .filter((k) => !f.hotspots.some((h) => h.key === k)).map((k) => f.id + ":" + k)),
  ["10:5105536", "11:5105536", "12:5105536", "13:5105536", "24:0030-80",
   "26:0100-10", "26:0100-20", "26:0100-30", "26:0100-40", "26:0100-50", "26:0100-60", "26:0100-70",
   "27:0100-10", "27:0100-20", "27:0100-30", "27:0100-40", "30:41", "31:1000"]);

console.log("\n-- the pieces of an assembly --");
// "0030-10" is piece 10 of the ROPS assembly 0030, printed that way on the
// drawing. The reader first dropped these rows - 36 of them - and the callout
// reader, which reads digits only, filed their labels under plain 0030.
const pieces = all.filter((p) => p.key.includes("-"));
check("every piece row kept, indented under its assembly",
  [pieces.length, pieces.every((p) => p.sub && p.depth === 1)], [36, true]);
const rops = fig("Rear Bumper and ROPS");
check("the ROPS pieces tapped as themselves, not as 0030",
  ["0030-10", "0030-20", "0030-30", "0030-40", "0030-50", "0030-60", "0030-70"]
    .filter((k) => !rops.hotspots.some((h) => h.key === k)), []);
check("and 0030 itself keeps its own callout", rops.hotspots.filter((h) => h.key === "0030").length, 1);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
