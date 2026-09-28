// merge-ipl-figures.js
// ============================================================================
// Copy whole figures from one parts book into another, and keep both books.
//
//   node tools/merge-ipl-figures.js            # do it
//   node tools/merge-ipl-figures.js --check    # say what would change, change nothing
//
// WHY THIS EXISTS. The technicians asked on 26 Sep 2026 for the LHTZ-A and
// SHTZ-A trimmer heads to appear inside the PHT750/1200/1500 book: the head is
// what they are actually holding when they work on one of those poles, and
// having to back out and open a second book to find a $4 bolt is the kind of
// thing that gets skipped. The two heads ALSO stay as books of their own,
// because they are fitted to other machines too.
//
// WHY A TOOL RATHER THAN AN EDIT. These books are generated - extracted from
// Husqvarna's portal CSVs or scanned - so a book hand-edited today is a book
// whose edit vanishes the next time it is rebuilt. This is re-runnable and
// says so in the file: every figure it copies carries `merged_from`, which is
// both the record of where it came from and how this finds its own work to
// replace. Running it twice does not double anything.
//
// TO ADD ANOTHER PAIRING, add a line to MERGES below and run it.
const fs = require("fs");
const path = require("path");

const IPL = path.resolve(__dirname, "..", "frontend", "ipl");
const CHECK = process.argv.includes("--check");

// into            <- take every figure from these, in this order
const MERGES = [
  { into: "pht750_1200_1500", from: ["lhtza", "shtza"] },
];

// What to call a borrowed figure once it is in its new book. The source book's
// own title is usually just "MAINFRAME", which says nothing once it is sitting
// among a pole hedge trimmer's four figures.
const TITLES = {
  lhtza: "LHTZ-A TRIMMER HEAD",
  shtza: "SHTZ-A TRIMMER HEAD",
};

function read(id) {
  return JSON.parse(fs.readFileSync(path.join(IPL, id + ".json"), "utf8"));
}

let changed = 0;
let problems = 0;

for (const merge of MERGES) {
  const target = read(merge.into);
  // Its own figures are the ones without a merged_from. Dropping the borrowed
  // ones first is what makes a second run a no-op rather than a duplication.
  const own = (target.figures || []).filter((f) => !f.merged_from);
  const borrowed = [];

  for (const sourceId of merge.from) {
    const source = read(sourceId);
    for (const fig of source.figures || []) {
      // The image is referenced by filename out of the same folder, so the
      // borrowed figure points at the source book's picture and nothing is
      // copied onto disk.
      if (!fs.existsSync(path.join(IPL, fig.image))) {
        console.error(`  ! ${sourceId}: image ${fig.image} is missing`);
        problems++;
        continue;
      }
      borrowed.push({
        ...fig,
        // A NEW ID. The app picks figures by id, not by printed number, and
        // both of these books call their only figure "1" - the same id as the
        // target's first figure. Left alone, tapping one would open the other.
        id: String(own.length + borrowed.length + 1),
        number: String(own.length + borrowed.length + 1),
        title: TITLES[sourceId] || fig.title,
        label: `Fig.${own.length + borrowed.length + 1} ${TITLES[sourceId] || fig.title}`,
        merged_from: sourceId,
      });
    }
  }

  const figures = own.concat(borrowed);
  const before = JSON.stringify(target.figures);
  target.figures = figures;
  const after = JSON.stringify(figures);

  console.log(`${merge.into}: ${own.length} of its own + ${borrowed.length} borrowed = ${figures.length}`);
  for (const f of borrowed) console.log(`   ${f.label}  (from ${f.merged_from}, ${f.parts.length} parts)`);

  if (before === after) { console.log("   already up to date"); continue; }
  changed++;
  if (CHECK) { console.log("   --check: not written"); continue; }
  fs.writeFileSync(path.join(IPL, merge.into + ".json"),
                   JSON.stringify(target, null, 1) + "\n", "utf8");

  // The index carries the counts the picker shows, and there are TWO of them.
  // A book that says "4 figures" and opens with six is a small lie that costs
  // trust in the rest - and so is one that says 149 parts and holds 282, which
  // is what this did on its first run because only the figures were updated.
  const idxPath = path.join(IPL, "index.json");
  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  const rows = Array.isArray(idx) ? idx : idx.models;
  const row = rows.find((r) => r.id === merge.into);
  if (row) {
    row.figures = figures.length;
    row.parts = figures.reduce((n, f) => n + (f.parts || []).length, 0);
    // DRAWINGS THIS BOOK BRINGS OF ITS OWN. A borrowed figure's picture already
    // belongs to the book it came from, so counting it here would make the
    // offline check expect a file that does not exist and report a fully
    // downloaded phone as incomplete for ever. See iplOfflineExpected().
    row.images = own.length;
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1) + "\n", "utf8");
    console.log(`   index.json: figures = ${row.figures}, parts = ${row.parts}, own drawings = ${row.images}`);
  } else {
    console.error(`  ! ${merge.into} is not in index.json`);
    problems++;
  }
}

console.log(problems ? `\n${problems} problem(s)` : (changed ? "\ndone" : "\nnothing to do"));
process.exit(problems ? 1 : 0);
