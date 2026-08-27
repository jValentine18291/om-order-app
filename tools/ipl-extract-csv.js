// tools/ipl-extract-csv.js
// ============================================================================
// Builds an IPL from the CSV the Husqvarna Portal exports — which is by far the
// best source of the three we have:
//
//   Zenoah PDF        callout positions come from the PDF's text layer
//   Husqvarna PDF     a flat picture; callouts unreadable (OCR managed 76%)
//   Husqvarna CSV     ships the callout coordinates outright, plus a URL for
//                     each diagram image   <-- this file
//
// The CSV has one row per part with:
//   IPL Name    section, e.g. "CHASSIS LOWER"
//   Ref         the callout number printed on the drawing
//   Coordinates one or more "x1;y1;x2;y2" boxes, comma-separated when a part
//               is called out in more than one place, in image pixel space
//   IPL Image   URL of the diagram PNG
//
// So nothing is inferred and nothing is OCR'd: every hotspot is exactly where
// the manufacturer says it is.
//
// USAGE
//   node tools/ipl-extract-csv.js "<export.csv>" <model-id> ["Model Name"]
//
// Downloads each diagram image, so it needs internet access.
// ============================================================================

const fs = require("fs");
const path = require("path");
const https = require("https");

const { writeIndex } = require("./ipl-index");

// A Husqvarna CSV export carries no folder to read a category from, so pass one
// - it is what the picker's filter chips group on.
const [, , CSV, MODEL_ID, MODEL_NAME, CATEGORY] = process.argv;
if (!CSV || !MODEL_ID) {
  console.error('Usage: node tools/ipl-extract-csv.js "<export.csv>" <model-id> ["Model Name"] ["Category"]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, "..", "frontend", "ipl");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- CSV ------------------------------------------------------------------
// Fields are quoted and contain commas ("Cover Top Grey, 550 EPOS"), so this
// walks the text rather than splitting on commas.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") { /* ignore */ }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// "948;160;962;196"  or  "948;160;962;196,1020;300;1034;336"
function parseBoxes(s) {
  const out = [];
  for (const chunk of String(s || "").split(",")) {
    const n = chunk.trim().split(";").map((v) => parseFloat(v)).filter((v) => Number.isFinite(v));
    if (n.length === 4) out.push(n);
  }
  return out;
}

const download = (url, dest) =>
  new Promise((resolve, reject) => {
    const go = (u, depth = 0) => {
      if (depth > 4) return reject(new Error("too many redirects"));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return go(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      }).on("error", reject);
    };
    go(url);
  });

// Read the PNG header for its pixel size, so boxes convert to percentages.
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// AutoCount holds these with separators stripped and a brand prefix, so search
// on the bare alphanumerics — the same rule the other extractors use.
const searchCode = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV, "utf8").replace(/^﻿/, ""));
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const iName = col("IPL Name"), iRef = col("Ref"), iArt = col("Article Number");
  const iDesc = col("Article Name"), iQty = col("Qty"), iCom = col("Comment");
  const iImg = col("IPL Image"), iCoord = col("Coordinates");
  if (iName < 0 || iRef < 0 || iCoord < 0 || iImg < 0) {
    throw new Error("CSV is missing the expected columns (IPL Name / Ref / Coordinates / IPL Image)");
  }

  const data = rows.slice(1).filter((r) => r.length > iCoord && r[iName]);
  console.log(`${path.basename(CSV)}: ${data.length} rows`);

  // Group by section, preserving the order the export lists them in.
  const sections = [];
  const byName = new Map();
  for (const r of data) {
    const name = r[iName].trim();
    if (!byName.has(name)) {
      const s = { name, image: "", rows: [] };
      byName.set(name, s); sections.push(s);
    }
    const sec = byName.get(name);
    // Superseded parts ("up to serial number ...") come through with Link,
    // Image and Coordinates all blank. Take the section's image from the first
    // row that actually has one, rather than assuming the first row does.
    if (!sec.image && r[iImg] && r[iImg].trim()) sec.image = r[iImg].trim();
    sec.rows.push(r);
  }

  const figures = [];
  for (const [i, s] of sections.entries()) {
    if (!s.image) { console.log(`  ${s.name}: no diagram image in the export — skipping`); continue; }
    const file = `${MODEL_ID}-fig${i + 1}.png`;
    const dest = path.join(OUT_DIR, file);
    try {
      await download(s.image, dest);
    } catch (e) {
      console.log(`  ${s.name}: image download FAILED (${e.message}) — skipping section`);
      continue;
    }
    const size = pngSize(dest);
    if (!size) { console.log(`  ${s.name}: not a readable PNG — skipping`); continue; }

    const parts = [];
    const hotspots = [];
    for (const r of s.rows) {
      const key = String(r[iRef] || "").trim();
      const article = String(r[iArt] || "").trim();
      parts.push({
        key,
        part_number: article,
        sub: false,
        description: String(r[iDesc] || "").trim(),
        qty: String(r[iQty] || "").trim(),
        remarks: String(r[iCom] || "").trim(),
        search: searchCode(article),
      });
      // A part called out twice gets a hotspot per box, both selecting the row.
      //
      // But several PARTS routinely share one callout: the 450X lists three
      // BODY KITs at Ref 1 — grey, white and orange — each carrying the same
      // box, and the Chassis Lower's Ref 1 is four parts across two positions,
      // which came out as eight hotspots stacked in pairs. They select the same
      // key and so behave identically; the viewer just built eight buttons on
      // top of each other where two would do. One per printed callout.
      for (const [x1, y1, x2, y2] of parseBoxes(r[iCoord])) {
        const spot = {
          key,
          x: +(((x1 + x2) / 2 / size.width) * 100).toFixed(3),
          y: +(((y1 + y2) / 2 / size.height) * 100).toFixed(3),
        };
        const already = hotspots.some(
          (h) => h.key === spot.key && h.x === spot.x && h.y === spot.y
        );
        if (!already) hotspots.push(spot);
      }
    }

    figures.push({
      id: String(figures.length + 1),
      number: figures.length + 1,
      title: s.name,
      label: s.name,
      sheet: 1,
      sheets: 1,
      image: file,
      hotspots,
      parts,
    });
    console.log(`  ${s.name}: ${parts.length} parts, ${hotspots.length} hotspots  (${size.width}x${size.height})`);
  }

  const model = {
    id: MODEL_ID,
    name: MODEL_NAME || MODEL_ID.toUpperCase(),
    source: path.basename(CSV),
    figures,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}.json`), JSON.stringify(model, null, 1));

  const entry = writeIndex(OUT_DIR, model, CSV, CATEGORY, figures.length);
  console.log(`  picker entry: ${entry.brand} / ${entry.short} / ${entry.category || "(no category)"}`);

  const totalSpots = figures.reduce((a, f) => a + f.hotspots.length, 0);
  console.log(`\nwrote frontend/ipl/${MODEL_ID}.json — ${figures.length} figures, ${totalSpots} hotspots`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
