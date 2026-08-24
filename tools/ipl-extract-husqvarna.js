// tools/ipl-extract-husqvarna.js
// ============================================================================
// Husqvarna IPLs come off the Husqvarna Portal as a browser print-out, and are
// a different animal from the Zenoah ones handled by ipl-extract.js:
//
//   Zenoah    - publisher's PDF. Callout numbers are TEXT, so hotspots are
//               lifted straight from the PDF and every number is tappable.
//   Husqvarna - the drawing is a flat raster image. The callout numbers and
//               even the section title are pixels, so there is nothing to lift.
//
// What that means here: parts tables and article numbers extract perfectly
// (they are real text), the diagram is shipped as a zoomable image, the section
// title is recovered by OCR (large bold text, which OCR reads reliably), and
// there are NO hotspots. OCR on the callout numbers themselves was tried and
// reached only ~28 of 34 on a test page - a number that silently is not
// tappable reads as broken, so the viewer offers none rather than some.
//
// USAGE
//   node tools/ipl-extract-husqvarna.js "<IPL.pdf>" <model-id> ["Model Name"]
//
// REQUIRES poppler and tesseract. On John's PC both ship with the Invoice
// Processor:
//   POPPLER_BIN="P:/1-SCAN/Invoice Processor Portable/_internal/poppler/Library/bin"
//   TESSERACT_BIN="P:/1-SCAN/Invoice Processor Portable/_internal/tesseract"
// ============================================================================

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const POPPLER = process.env.POPPLER_BIN || "";
const TESS_DIR = process.env.TESSERACT_BIN || "";
const bin = (n) => (POPPLER ? path.join(POPPLER, n) : n);
const tesseract = () => (TESS_DIR ? path.join(TESS_DIR, "tesseract") : "tesseract");

const [, , PDF, MODEL_ID, MODEL_NAME] = process.argv;
if (!PDF || !MODEL_ID) {
  console.error('Usage: node tools/ipl-extract-husqvarna.js "<IPL.pdf>" <model-id> ["Model Name"]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, "..", "frontend", "ipl");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ipl-"));
fs.mkdirSync(OUT_DIR, { recursive: true });

const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }).toString();

function wordsForPage(page) {
  const xml = run(bin("pdftotext"), ["-f", String(page), "-l", String(page), "-bbox", PDF, "-"]);
  const size = xml.match(/<page width="([\d.]+)" height="([\d.]+)"/);
  const words = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let m;
  while ((m = re.exec(xml))) {
    words.push({
      x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4],
      text: m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim(),
    });
  }
  return {
    width: size ? +size[1] : 595,
    height: size ? +size[2] : 842,
    words,
  };
}

// A diagram page carries a large embedded raster and no parts table.
function bigImageOn(page) {
  const list = run(bin("pdfimages"), ["-f", String(page), "-l", String(page), "-list", PDF]);
  return list.split("\n").some((l) => {
    const m = l.trim().match(/^\d+\s+\d+\s+image\s+(\d+)\s+(\d+)/);
    return m && +m[1] > 800 && +m[2] > 800;
  });
}

// Column edges, taken from the printed header on a table page.
const COLS = { ref: 90, article: 180, name: 340, qty: 395 };
const columnOf = (x) => (x < COLS.ref ? "ref" : x < COLS.article ? "article"
  : x < COLS.name ? "name" : x < COLS.qty ? "qty" : "comment");

// Rows here wrap over several printed lines, so they cannot be clustered by
// proximity like the Zenoah tables. Each Reference number anchors a row, and
// everything down to the next Reference belongs to it.
function tableAnchors(words, height) {
  return words
    .filter((w) => w.y1 > 45 && w.y1 < height - 40)
    .filter((w) => columnOf(w.x1) === "ref" && /^\d{1,3}$/.test(w.text))
    .sort((a, b) => a.y1 - b.y1);
}

function parseTable(page) {
  const { words, height } = wordsForPage(page);
  const body = words.filter((w) => w.y1 > 45 && w.y1 < height - 40);
  const anchors = tableAnchors(words, height);

  // On the first page of a section the column headers sit above the first row.
  // The first row reaches upwards to catch its wrapped name, so without a floor
  // it swallows "Article Number", "Quantity" and the rest.
  const headerWords = body.filter(
    (w) => w.y1 < 95 && /^(Refere|nce|Article|Number|Name|Quantit|y|Comment)$/i.test(w.text)
  );
  const contentTop = headerWords.length
    ? Math.max(...headerWords.map((w) => w.y2)) + 2
    : 45;

  const rows = [];
  anchors.forEach((a, i) => {
    const prev = anchors[i - 1];
    const next = anchors[i + 1];
    // The Article Name wraps over several lines and is centred on its row, so
    // part of it sits ABOVE the reference number. Banding from the reference
    // downwards clipped the first line off every wrapped name and handed it to
    // the row before. Split rows on the midpoint between reference numbers.
    const top = prev ? (prev.y1 + a.y1) / 2 : contentTop;
    const bottom = next ? (a.y1 + next.y1) / 2 : Infinity;
    const cells = { ref: [], article: [], name: [], qty: [], comment: [] };
    for (const w of body) {
      if (w.y1 < top || w.y1 >= bottom) continue;
      cells[columnOf(w.x1)].push(w);
    }
    const join = (c) =>
      cells[c].sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1).map((w) => w.text).join(" ").trim();

    const article = join("article").replace(/\s+/g, "");
    rows.push({
      key: a.text,
      part_number: article,
      sub: false,
      description: join("name"),
      qty: join("qty"),
      remarks: join("comment"),
      search: article.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    });
  });
  return rows;
}

// The section letter and title are printed inside the drawing, so they exist
// only as pixels. pdftoppm can render just that corner, and the heading is
// large bold text which OCR reads reliably (unlike the small callout numbers).
function renderTitleCrop(page, dest) {
  // At 300dpi an A4 page is 2479x3508; the heading sits in the top-left of the
  // drawing frame.
  run(bin("pdftoppm"), ["-png", "-r", "300", "-f", String(page), "-l", String(page),
                        "-x", "230", "-y", "185", "-W", "1150", "-H", "175",
                        "-singlefile", PDF, dest.replace(/\.png$/, "")]);
}

function ocrTitleFromImage(pngPath) {
  const out = path.join(TMP, "title");
  try {
    execFileSync(tesseract(), [pngPath, out, "--psm", "6"], {
      stdio: "ignore",
      env: { ...process.env, TESSDATA_PREFIX: TESS_DIR ? path.join(TESS_DIR, "tessdata") : undefined },
    });
    const text = fs.readFileSync(out + ".txt", "utf8");
    const lines = text.split("\n").map((l) => l.replace(/[|_]/g, " ").trim()).filter(Boolean);
    if (!lines.length) return null;
    // First line is like "D AUTOMOWER 550 EPOS", second the section name.
    const letter = (lines[0].match(/^([A-Z])\b/) || [])[1] || "";
    // OCR picks up marks from the drawing frame beside the heading, which come
    // through as stray punctuation or a lone trailing character.
    const clean = (t) => {
      let out = t.replace(/[^A-Za-z0-9&\s]/g, " ").replace(/\s+/g, " ").trim();
      // Strip trailing debris repeatedly — a stray digit can sit behind a
      // stray letter ("CHASSIS UPPER 2 y"), so one pass of each is not enough.
      let prev;
      do {
        prev = out;
        out = out.replace(/\s+(?:[0-9]{1,2}|[A-Za-z])$/, "").trim();
      } while (out !== prev);
      return out.toUpperCase();
    };
    const title = clean(lines[1] || lines[0]) || clean(lines[0]);
    return { letter, title };
  } catch (_) {
    return null;
  }
}

// ---- walk ------------------------------------------------------------------
const pageCount = parseInt(run(bin("pdfinfo"), [PDF]).match(/Pages:\s+(\d+)/)[1], 10);
console.log(`${PDF}\n${pageCount} pages`);

const figures = [];
let current = null;

for (let p = 1; p <= pageCount; p++) {
  const { words, height } = wordsForPage(p);
  const text = words.map((w) => w.text).join(" ");
  // Only the first page of a section repeats the "Article Number" header, so a
  // page counts as a table if it simply has Reference numbers down the left.
  // Testing for the header alone silently dropped every continuation page —
  // and with them roughly half the parts.
  const isTable = /Article\s*Number/i.test(text) || tableAnchors(words, height).length >= 3;

  if (!isTable && bigImageOn(p)) {
    // The first page is the product hero shot, not a parts diagram.
    if (p === 1) continue;
    const stem = `${MODEL_ID}-fig${figures.length + 1}`;
    run(bin("pdftoppm"), ["-png", "-r", "150", "-f", String(p), "-l", String(p),
                          "-singlefile", PDF, path.join(OUT_DIR, stem)]);
    const cropped = path.join(TMP, `crop${p}.png`);
    renderTitleCrop(p, cropped);
    const t = ocrTitleFromImage(cropped);

    current = {
      id: String(figures.length + 1),
      number: figures.length + 1,
      letter: t ? t.letter : "",
      title: t ? t.title : `Section ${figures.length + 1}`,
      image: `${stem}.png`,
      hotspots: [],          // see the note at the top of this file
      parts: [],
    };
    figures.push(current);
  } else if (isTable && current) {
    current.parts.push(...parseTable(p));
  }
}

for (const f of figures) {
  f.sheets = 1;
  f.sheet = 1;
  f.label = (f.letter ? f.letter + " " : "") + f.title;
  console.log(`  ${f.label}: ${f.parts.length} parts, ${f.hotspots.length} hotspots`);
}

const model = {
  id: MODEL_ID,
  name: MODEL_NAME || MODEL_ID.toUpperCase(),
  source: path.basename(PDF),
  diagramOnly: true,     // no tappable callouts; the viewer adapts its hint
  figures,
};
fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}.json`), JSON.stringify(model, null, 1));

const indexPath = path.join(OUT_DIR, "index.json");
let index = [];
try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch (_) {}
index = index.filter((m) => m.id !== MODEL_ID);
index.push({ id: model.id, name: model.name, figures: figures.length });
index.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));

console.log(`\nwrote frontend/ipl/${MODEL_ID}.json (${figures.length} figures)`);
