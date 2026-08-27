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

const { writeIndex } = require("./ipl-index");

// CATEGORY is optional: without it the category comes from the folder the PDF
// was filed in on M:, which is right most of the time. Pass one when it is not
// — a pole hedge trimmer is filed under "Hedge Trimmer" like the rest.
const [, , PDF, MODEL_ID, MODEL_NAME, CATEGORY] = process.argv;
if (!PDF || !MODEL_ID) {
  console.error('Usage: node tools/ipl-extract.js "<IPL.pdf>" <model-id> ["Model Name"] ["Category"]');
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
      // &apos; matters as much as the rest: without it the Q'TY heading arrives
      // as the literal "Q&apos;TY", never matches, and every quantity in the
      // G3800 was filed under NOTE.
      text: m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim(),
    });
  }
  return { width, height, words };
}

// Group words into rows by their vertical position, then into columns by x.
//
// Where the column edges come from: the table prints its own header —
// "Key# PART NUMBER DESCRIPTION Q'TY REMARKS" — so read the edges off that
// rather than hard-coding them. Books that look identical are not: the G3800
// puts its NOTE column at x=275 where the HT220-75 has REMARKS at 466, and a
// fixed grid tuned for one silently folds two columns together in the other.
//
// These are the edges that grid used, kept only for a page whose header cannot
// be found at all.
const FALLBACK_COLS = { key: 90, part: 195, desc: 415, qty: 448 };

const HEADERS = [
  { col: "key",     match: /^Key#?$/i },
  { col: "part",    match: /^PART$/i },
  { col: "desc",    match: /^DESCRIPTION$/i },
  { col: "qty",     match: /^Q[’'`]?TY$/i },
  { col: "remarks", match: /^(REMARKS?|NOTES?)$/i },
];

// Every table block on the page, left to right. Usually one; the G3800 runs two
// side by side, each with its own header and its own key numbering.
function tableBlocks(words) {
  // "Key#" is what marks a column, but the word KEY is also a part description
  // — the G621AVS lists one as part 125 — and the pattern matches either.
  //
  // A false anchor does not merely add a block of its own; that much the
  // header test below would throw out. It sits BETWEEN the two real headers
  // and cuts the left one's band short, so the real header lost DESCRIPTION,
  // Q'TY and NOTE, failed the same test, and took its whole column with it.
  // Fifty parts of the G621AVS's Fig.2 vanished — every callout on the right
  // of that drawing was dead, and the totals said 39 of 40 because it had
  // forgotten it ever wanted them.
  //
  // So candidates are vetted on their own first, against a band nothing else
  // is allowed to truncate, and only the survivors go on to bound each other.
  const bandFor = (anchor, rightLimit) => words
    .filter((w) =>
      Math.abs(w.y1 - anchor.y1) < 14 &&
      w.x1 >= anchor.x1 - 2 &&
      (rightLimit === undefined || w.x1 < rightLimit - 2)
    )
    .sort((a, b) => a.x1 - b.x1);

  const headersIn = (band) => {
    const found = [];
    for (const { col, match } of HEADERS) {
      const hit = band.find((w) => match.test(w.text));
      if (hit) found.push({ col, x1: hit.x1, x2: hit.x2 });
    }
    return found;
  };

  const anchors = words
    .filter((w) => /^Key#?$/i.test(w.text))
    .sort((a, b) => a.x1 - b.x1)
    // Vetted against everything to its right, so a neighbouring column cannot
    // hide this one's own headings. Bands are sorted by x, so the nearest
    // heading of each kind wins and the column to the right is not borrowed.
    .filter((w) => headersIn(bandFor(w)).length >= 3);
  if (!anchors.length) return [];

  return anchors.map((anchor, i) => {
    const next = anchors[i + 1];
    // The header can wrap — "Q'TY" above "/UNIT" — so take a band rather than
    // one baseline, and stop at the next block's first column.
    const band = bandFor(anchor, next ? next.x1 : undefined);

    const found = headersIn(band);
    if (found.length < 3) return null;   // not a real header

    // A boundary sits in the gap between two headers, but nearer the left one:
    // REMARKS is left-aligned while the value under it can start a little
    // before its heading — "HT220-75" begins 15pt left of the word REMARKS.
    const edges = [];
    for (let j = 0; j < found.length - 1; j++) {
      const gap = found[j + 1].x1 - found[j].x2;
      edges.push({ col: found[j].col, upTo: found[j].x2 + gap * 0.1 });
    }
    edges.push({ col: found[found.length - 1].col, upTo: Infinity });

    return {
      x1: anchor.x1 - 6,
      x2: next ? next.x1 - 6 : Infinity,
      yHeader: anchor.y1,
      columnOf(x) {
        for (const e of edges) if (x < e.upTo) return e.col;
        return "remarks";
      },
    };
  }).filter(Boolean);
}

function fallbackBlock() {
  return {
    x1: -Infinity, x2: Infinity, yHeader: 65,
    columnOf(x) {
      if (x < FALLBACK_COLS.key) return "key";
      if (x < FALLBACK_COLS.part) return "part";
      if (x < FALLBACK_COLS.desc) return "desc";
      if (x < FALLBACK_COLS.qty) return "qty";
      return "remarks";
    },
  };
}

function parseTable(page) {
  const { words, height } = wordsForPage(page);
  const blocks = tableBlocks(words);
  return (blocks.length ? blocks : [fallbackBlock()])
    .map((b) => parseTableBlock(words, height, b))
    .flat();
}

function parseTableBlock(allWords, height, block) {
  const columnOf = (x) => block.columnOf(x);
  const words = allWords.filter((w) => w.x1 >= block.x1 && w.x1 < block.x2);

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
  // Start below this block's own header rather than at a fixed 80pt: the G3800
  // prints its header at y=90 where the HT220-75 has it at y=66, and a fixed
  // cut read one book's headings in as a part.
  const top = block.yHeader + 12;
  const body = words
    .filter((w) => w.y1 >= top && w.y1 < height - 55)
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

    // "・" marks a sub-component of the row above, and the books nest two deep:
    // "・・SCREEN" is a part of the "・PUMP COVER" that belongs to the CARBURETOR
    // ASSY. Stripping a single mark left the second one sitting in the
    // description, so 41 rows across the Zenoah models read "・HOLDER ASSY"
    // under a bullet the viewer had already drawn. Count them instead.
    const marks = desc.match(/^[・·•]+/);
    const depth = marks ? marks[0].length : 0;

    out.push({
      key,
      part_number: part,
      depth,
      sub: depth > 0,
      description: desc.replace(/^[・·•\s]+/, "").trim(),
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
  // Where the drawing shares its page with the table — the G3800's last two
  // figures do — the table's own Key# column is a column of small integers that
  // all match a key, so every one of them became a hotspot: 48 of them on a
  // figure with 27 parts, scattered down the parts list. Cut the page off above
  // the topmost table.
  const blocks = tableBlocks(words);
  const tableTop = blocks.length ? Math.min(...blocks.map((b) => b.yHeader)) - 8 : Infinity;

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
    if (w.y1 >= tableTop) continue;                     // the parts table below
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

// Is this the same drawing as that one? Compared through the callout numbers
// printed on each — where they are and what they say — rather than the picture,
// which cannot be compared without an image library and would differ anyway:
// the two copies carry different page numbers in the footer.
//
// Needs a decent crop of callouts to be sure. A scanned drawing has none at
// all, and two blank signatures would otherwise "match" and merge two figures
// that have nothing to do with each other.
function sameDrawing(a, b) {
  if (!a || !b || a === b) return false;
  const signature = (page) => {
    const { width, height, words } = wordsForPage(page);
    return words
      .filter((w) => /^\d+[A-Z]?$/.test(w.text) && w.y2 < height - 55)
      .map((w) => `${w.text}@${Math.round((w.x1 / width) * 200)},${Math.round((w.y1 / height) * 200)}`)
      .sort()
      .join(" ");
  };
  const sa = signature(a);
  if (sa.split(" ").length < 8) return false;
  return sa === signature(b);
}

// Where the drawing stops on a page it shares with its parts table, as a
// percentage of page height. 100 when the drawing has the page to itself.
function drawingLimit(page) {
  const { height, words } = wordsForPage(page);
  const blocks = tableBlocks(words);
  if (!blocks.length) return 100;
  const top = Math.min(...blocks.map((b) => b.yHeader)) - 8;
  return Math.max(5, Math.min(100, (top / height) * 100));
}

// Reading the callouts off a scanned drawing is a different job — image work,
// not text work — so it lives in tools/ipl-ocr-callouts.py and is shelled out
// to. It takes roughly a minute a page, which is why it only runs when the
// page has no callout text at all.
function ocrCallouts(page, keys, maxY) {
  const script = path.join(__dirname, "ipl-ocr-callouts.py");
  try {
    const out = execFileSync(
      process.env.PYTHON || "python",
      [script, PDF, String(page), keys.join(","), String(maxY)],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, POPPLER_BIN: POPPLER } }
    ).toString();
    return JSON.parse(out);
  } catch (e) {
    console.log(`\n    (could not read the scan: ${String(e.message).split("\n")[0]})`);
    return [];
  }
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

  if (isTable) {
    // Usually the drawing is the page before. The G3800 prints its last two
    // figures with the drawing and the table on one sheet, so when nothing is
    // pending the page is its own drawing.
    const drawingPage = pending ? pending.page : p;
    // Prefer the heading printed on the drawing; fall back to the one on the
    // parts page, which is where the HT220-75 puts it.
    const head = (pending && pending.head) || heading || { number: String(figures.length + 1), title: "" };
    const rows = parseTable(p);

    // Some books reprint one drawing across two parts tables, because the list
    // is too long for a page: the G2200T's ENGINE PARTS appears twice, once for
    // parts 1-41 and again for 42-49, and the BK3410's DRIVE UNIT does the
    // same. Treated as two figures, half the numbers on each copy are visible
    // but dead - tap 45 on the first and nothing happens, because 45 lives in
    // the other one's table. Fold them back into the single figure the book
    // means, so every number on the drawing works.
    const prev = figures[figures.length - 1];
    if (prev && prev.number === head.number && sameDrawing(prev.drawingPage, drawingPage)) {
      prev.parts = prev.parts.concat(rows.map((r) => ({ ...r, search: searchCode(r.part_number) })));
      const allKeys = new Set(prev.parts.map((r) => r.key));
      prev.hotspots = prev.ocr
        ? ocrCallouts(prev.drawingPage, [...allKeys], drawingLimit(prev.drawingPage))
        : parseFigure(prev.drawingPage, allKeys);
      console.log(`  Fig.${head.number} ${head.title}: +${rows.length} parts from a second table` +
                  ` (same drawing) — now ${prev.parts.length} parts, ${prev.hotspots.length} hotspots`);
      pending = null;
      continue;
    }

    const keys = new Set(rows.map((r) => r.key));
    let hotspots = parseFigure(drawingPage, keys);
    let ocr = false;

    // The older books - roughly one in four, everything before about 2015 - are
    // scans, so the callout numbers are part of the picture and there is no
    // text to read coordinates from. Fall back to reading them off the image.
    //
    // Judged on every key, not only the top-level ones. Sub-components usually
    // carry no callout, but on a carburetor figure they are the whole drawing:
    // the G3800's has 27 parts of which 26 are sub-components, so counting only
    // top-level rows saw one key, decided the figure was too small to judge,
    // and left that drawing with nothing to tap.
    const covered = new Set(hotspots.map((h) => h.key));
    const coverage = keys.size ? [...keys].filter((k) => covered.has(k)).length / keys.size : 1;
    if (coverage < 0.25 && keys.size >= 5) {
      process.stdout.write(`  Fig.${head.number} ${head.title}: scanned drawing, reading the numbers off it… `);
      const found = ocrCallouts(drawingPage, [...keys], drawingLimit(drawingPage));
      if (found.length) { hotspots = found; ocr = true; }
      console.log(`${found.length} placed`);
    }

    const png = `${MODEL_ID}-fig${figures.length + 1}.png`;
    run("pdftoppm", ["-png", "-r", "150", "-f", String(drawingPage), "-l", String(drawingPage),
                     "-singlefile", PDF, path.join(OUT_DIR, png.replace(/\.png$/, ""))]);

    const hit = new Set(hotspots.map((h) => h.key));
    figures.push({
      // id is what the viewer selects on: a figure can run to more than one
      // sheet (the BK3410's Fig.1 DRIVE UNIT does), and keying on the printed
      // figure number alone would make every sheet after the first
      // unreachable.
      id: String(figures.length + 1),
      number: head.number,
      title: head.title || `Figure ${head.number}`,
      image: png,
      // Kept only while the document is being walked, so a following table can
      // ask whether it belongs to this same drawing. Stripped before writing.
      drawingPage,
      // Recorded so the viewer can say so: on a scanned book the numbers were
      // read off the picture, and a few will be missing.
      ocr: ocr || undefined,
      hotspots,
      parts: rows.map((r) => ({ ...r, search: searchCode(r.part_number) })),
    });
    // Counted by key, NOT by printed callout — a number the book prints twice
    // counts as covered once either instance is found. So this is an upper
    // bound, and it read 98% on a figure where one of the two 38s had no
    // hotspot at all. The only way to know is to look at the drawing; the
    // number below is a smoke alarm, not a survey.
    const topKeys = new Set(rows.filter((r) => !r.depth).map((r) => r.key));
    const reached = [...topKeys].filter((k) => hit.has(k)).length;
    console.log(`  Fig.${head.number} ${head.title}: ${rows.length} parts, ${hotspots.length} hotspots` +
                `, ${reached}/${topKeys.size} numbered parts reachable${ocr ? " (read off the scan)" : ""}`);

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
  // Only needed while walking the document, to spot a reprinted drawing.
  delete f.drawingPage;
}

const model = {
  id: MODEL_ID,
  name: MODEL_NAME || MODEL_ID.toUpperCase(),
  source: path.basename(PDF),
  figures,
};
fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}.json`), JSON.stringify(model, null, 1));

// Refresh the index the picker reads to populate its model list.
const entry = writeIndex(OUT_DIR, model, PDF, CATEGORY, figures.length);

console.log(`\nwrote frontend/ipl/${MODEL_ID}.json (${figures.length} figures) and refreshed index.json`);
console.log(`  picker entry: ${entry.brand} / ${entry.short} / ${entry.category || "(no category)"}`);
