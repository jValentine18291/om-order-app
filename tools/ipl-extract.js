// tools/ipl-extract.js
// ============================================================================
// Turns a Zenoah/Husqvarna IPL PDF into the data the in-app IPL viewer needs:
// one PNG per figure, plus a JSON file holding every parts row and the screen
// position of every callout number on the diagram.
//
// The callout numbers in these PDFs are real text, not part of the drawing, so
// their coordinates come straight out of pdftotext -bbox. Nothing is placed by
// hand, which is what makes adding another model cheap.
//
// USAGE
//   node tools/ipl-extract.js "<path to IPL.pdf>" <model-id> ["Model Name"]
// e.g.
//   node tools/ipl-extract.js "M:/.../IPL,ZENOAH,HBZ260EZ,2021-02.pdf" hbz260ez "Zenoah HBZ260EZ"
//
// Writes frontend/ipl/<model-id>.json and frontend/ipl/<model-id>-figN.png,
// and refreshes frontend/ipl/index.json.
//
// REQUIRES poppler (pdftotext, pdftoppm). Set POPPLER_BIN if they are not on
// PATH — on John's PC a copy ships with the Invoice Processor:
//   POPPLER_BIN="P:/1-SCAN/Invoice Processor Portable/_internal/poppler/Library/bin"
// ============================================================================

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const POPPLER = process.env.POPPLER_BIN || "";
const bin = (name) => (POPPLER ? path.join(POPPLER, name) : name);

const [, , PDF, MODEL_ID, MODEL_NAME] = process.argv;
if (!PDF || !MODEL_ID) {
  console.error('Usage: node tools/ipl-extract.js "<IPL.pdf>" <model-id> ["Model Name"]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, "..", "frontend", "ipl");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- helpers ---------------------------------------------------------------
const run = (cmd, args) => execFileSync(bin(cmd), args, { maxBuffer: 64 * 1024 * 1024 }).toString();

// pdftotext -bbox emits XHTML; pull out the page size and every word box.
function wordsForPage(page) {
  const xml = run("pdftotext", ["-f", String(page), "-l", String(page), "-bbox", PDF, "-"]);
  const pageTag = xml.match(/<page width="([\d.]+)" height="([\d.]+)"/);
  const width = pageTag ? parseFloat(pageTag[1]) : 595;
  const height = pageTag ? parseFloat(pageTag[2]) : 842;
  const words = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let m;
  while ((m = re.exec(xml))) {
    words.push({
      x1: parseFloat(m[1]), y1: parseFloat(m[2]),
      x2: parseFloat(m[3]), y2: parseFloat(m[4]),
      text: m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim(),
    });
  }
  return { width, height, words };
}

// Group words into rows by their vertical position, then into columns by x.
// The tables are laid out on a fixed grid, so column edges are constants.
const COLS = { key: 90, part: 195, desc: 415, qty: 448 };  // right edge of each
function columnOf(x) {
  if (x < COLS.key) return "key";
  if (x < COLS.part) return "part";
  if (x < COLS.desc) return "desc";
  if (x < COLS.qty) return "qty";
  return "remarks";
}

function parseTable(page) {
  const { words, height } = wordsForPage(page);

  // Cluster words into rows by proximity rather than by rounding to a fixed
  // grid: rows sit ~15pt apart but a "・" or a wrapped remark can sit a point
  // or two off its neighbours, and rounding put those in the wrong row —
  // which silently merged parts and crossed columns on the carburetor page.
  //
  // The footer band has to go as well. The page number and the print date sit
  // in the DESCRIPTION and REMARKS columns, and having no key of their own they
  // were folded into the last part of every table — so the closing row of all
  // 14 figures across the three Zenoah models read "JOINT 2" with a remark of
  // "2017.08", and on one of them that displaced a real remark.
  const body = words
    .filter((w) => w.y1 >= 80 && w.y1 < height - 55)
    .sort((a, b) => a.y1 - b.y1);
  const rows = [];
  for (const w of body) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(w.y1 - row.y) < 6) {
      row.cells[columnOf(w.x1)].push(w);
    } else {
      rows.push({
        y: w.y1,
        cells: { key: [], part: [], desc: [], qty: [], remarks: [] },
      });
      rows[rows.length - 1].cells[columnOf(w.x1)].push(w);
    }
  }

  const out = [];
  for (const r of rows) {
    // Keep each cell's words in reading order — clustering sorted by y, not x.
    const row = {};
    for (const c of ["key", "part", "desc", "qty", "remarks"]) {
      row[c] = r.cells[c].sort((a, b) => a.x1 - b.x1).map((w) => w.text);
    }
    const key = row.key.join("").trim();
    const part = row.part.join(" ").trim();
    const desc = row.desc.join(" ").trim();
    const qty = row.qty.join("").trim();
    const remarks = row.remarks.join(" ").trim();

    // A row with no key and no part number is a wrapped REMARKS line: fold it
    // into the row above rather than dropping it.
    if (!key && !part) {
      const prev = out[out.length - 1];
      if (prev && remarks) prev.remarks = (prev.remarks ? prev.remarks + " " : "") + remarks;
      else if (prev && desc) prev.description += " " + desc;
      continue;
    }
    if (!key) continue;

    out.push({
      key,
      part_number: part,
      // "・" marks a sub-component of the row above; keep it as a depth flag
      // rather than leaving the character in the description.
      sub: /^[・·]/.test(desc),
      description: desc.replace(/^[・·]\s*/, "").trim(),
      qty,
      remarks,
    });
  }
  return out;
}

// AutoCount stores these codes with spaces AND dashes stripped, e.g. IPL
// "585 60 19-01" is item "SZEN 585601901". The search endpoint only strips
// spaces, so the dash has to go before we ask.
const searchCode = (partNumber) => String(partNumber || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

// Read a "Fig. 1 CARBURETOR" / "Fig. A STARTER HT220-75" heading off a page.
//
// Two layouts are in circulation. Most Zenoah books print the heading on the
// drawing and number the figures 1, 2, 3; the HT220-75 prints it on the parts
// page opposite and letters them A, B, C ... So the number is kept as text, and
// the caller looks on both pages.
function readHeading(words) {
  const anchor = words.find((w) => /^Fig/.test(w.text));
  if (!anchor) return null;
  const line = words
    .filter((w) => Math.abs(w.y1 - anchor.y1) < 6 && w.x1 >= anchor.x1)
    .sort((a, b) => a.x1 - b.x1)
    .map((w) => w.text)
    .join(" ");
  const m = line.match(/^Fig\.?\s*([A-Z0-9]+)\s*([\s\S]*)$/);
  if (!m) return null;
  return { number: m[1], title: m[2].trim() };
}

function parseFigure(page, keys) {
  const { width, height, words } = wordsForPage(page);

  // The heading must be kept out of the callouts, because books that number
  // their figures print "Fig. 1" up there and that 1 would land as a hotspot in
  // the corner of the drawing. Blanking the whole top band was the obvious way
  // and the wrong one: the HANDLE and GEARBOX drawings both put callout 1 high
  // on the right, and both went missing. So measure the heading instead — the
  // box around the words at the top of the page that are not callout-shaped —
  // and exclude only what falls inside it.
  const headWords = words.filter((w) => w.y1 < 70 && !/^\d+[A-Z]?$/.test(w.text));
  const head = headWords.length && {
    x1: Math.min(...headWords.map((w) => w.x1)) - 10,
    x2: Math.max(...headWords.map((w) => w.x2)) + 10,
    y2: Math.max(...headWords.map((w) => w.y2)) + 10,
  };
  const inHeading = (w) => head && w.y2 <= head.y2 && w.x1 >= head.x1 && w.x2 <= head.x2;

  const spots = [];
  for (const w of words) {
    if (!/^\d+[A-Z]?$/.test(w.text)) continue;
    if (inHeading(w) || w.y2 > height - 55) continue;   // heading / page number
    if (!keys.has(w.text)) continue;                    // only real callouts
    spots.push({
      key: w.text,
      // Percentages, so the viewer can scale the image freely.
      x: +(((w.x1 + w.x2) / 2 / width) * 100).toFixed(3),
      y: +(((w.y1 + w.y2) / 2 / height) * 100).toFixed(3),
    });
  }
  return spots;
}

// ---- walk the document -----------------------------------------------------
const pageCount = parseInt(run("pdfinfo", [PDF]).match(/Pages:\s+(\d+)/)[1], 10);
console.log(`${PDF}\n${pageCount} pages`);

const figures = [];
let pending = null;   // a figure page waiting for its table

for (let p = 1; p <= pageCount; p++) {
  const { words } = wordsForPage(p);
  const text = words.map((w) => w.text).join(" ");
  if (!text.trim()) continue;

  const isTable = /Key#/.test(text);
  const heading = readHeading(words);

  if (isTable && pending) {
    // Prefer the heading printed on the drawing; fall back to the one on the
    // parts page, which is where the HT220-75 puts it.
    const head = pending.head || heading || { number: String(figures.length + 1), title: "" };
    const rows = parseTable(p);
    const keys = new Set(rows.map((r) => r.key));
    const hotspots = parseFigure(pending.page, keys);

    const png = `${MODEL_ID}-fig${figures.length + 1}.png`;
    run("pdftoppm", ["-png", "-r", "150", "-f", String(pending.page), "-l", String(pending.page),
                     "-singlefile", PDF, path.join(OUT_DIR, png.replace(/\.png$/, ""))]);

    figures.push({
      // id is what the viewer selects on: a figure can run to more than one
      // sheet (the BK3410's Fig.1 DRIVE UNIT does), and keying on the printed
      // figure number alone would make every sheet after the first
      // unreachable.
      id: String(figures.length + 1),
      number: head.number,
      title: head.title || `Figure ${head.number}`,
      image: png,
      hotspots,
      parts: rows.map((r) => ({ ...r, search: searchCode(r.part_number) })),
    });
    console.log(`  Fig.${head.number} ${head.title}: ${rows.length} parts, ${hotspots.length} hotspots`);

    pending = null;
  } else if (!isTable) {
    // The drawing is simply the page facing the table, so hold on to whatever
    // page came last and let the table claim it. Counting callouts to decide
    // instead looks sensible and is not: the MUFFLER, CRANKSHAFT & CLUTCH and
    // ACCESSORIES figures have only two to four parts each, and any threshold
    // high enough to reject the cover page threw all three away. The cover
    // needs no rejecting — no table faces it.
    pending = { page: p, head: heading };
  }
}

// Where a figure runs to several sheets, number them for the tab label.
const sheetCounts = {};
for (const f of figures) sheetCounts[f.number] = (sheetCounts[f.number] || 0) + 1;
const seen = {};
for (const f of figures) {
  f.sheets = sheetCounts[f.number];
  seen[f.number] = (seen[f.number] || 0) + 1;
  f.sheet = seen[f.number];
  f.label = `Fig.${f.number} ${f.title}` + (f.sheets > 1 ? ` (${f.sheet}/${f.sheets})` : "");
}

const model = {
  id: MODEL_ID,
  name: MODEL_NAME || MODEL_ID.toUpperCase(),
  source: path.basename(PDF),
  figures,
};
fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}.json`), JSON.stringify(model, null, 1));

// Refresh the index the viewer reads to populate its model list.
const indexPath = path.join(OUT_DIR, "index.json");
let index = [];
try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch (_) {}
index = index.filter((m) => m.id !== MODEL_ID);
index.push({ id: model.id, name: model.name, figures: figures.length });
index.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));

console.log(`\nwrote frontend/ipl/${MODEL_ID}.json (${figures.length} figures) and refreshed index.json`);
