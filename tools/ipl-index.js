// tools/ipl-index.js
// ============================================================================
// One place that decides what an entry in frontend/ipl/index.json looks like,
// so the PDF extractor and the CSV extractor cannot drift apart.
//
// The picker on the IPL screen searches and groups on these fields, so every
// model needs them — a model missing a brand would sit in its own heading of
// one, and a model missing a category would never appear under a filter chip.
// ============================================================================

const fs = require("fs");
const path = require("path");

// The parts department already classifies these machines: it is the folder the
// IPL is filed in on M:. Take the category from there, mapping the few folder
// names that read oddly as a label on a phone.
const FOLDER_CATEGORY = {
  "leaf blower": "Blower",
  "hedge trimmer": "Hedge Trimmer",
  "brushcutter": "Brushcutter",
  "brush cutter": "Brushcutter",
  "chainsaw": "Chainsaw",
  "chain saw": "Chainsaw",
  "lawn mower": "Lawn Mower",
  "robotic mower": "Robotic Mower",
};

function categoryFromPath(sourcePath) {
  const folder = path.basename(path.dirname(String(sourcePath || ""))).trim();
  if (!folder) return "";
  return FOLDER_CATEGORY[folder.toLowerCase()] || folder;
}

// The brand is the first word of the model name. Every IPL we hold is named
// that way, and it is what anyone would look under.
function brandOf(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return parts[0] || "";
}

// Categories worth stripping off the end of a name even when they are not this
// model's own — a pole hedge trimmer is still filed under "Hedge Trimmer", and
// the name carries that word. Longest first, so the pole variant wins.
const NAME_SUFFIXES = [
  "Pole Hedge Trimmer", "Robotic Mower", "Hedge Trimmer", "Brushcutter",
  "Power Cutter", "Lawn Mower", "Chainsaw", "Outboard", "Blower", "Engine",
];

// A row in the picker sits under a brand heading and carries its category as a
// tag, so repeating either inside the name is noise: "Husqvarna 365 Chainsaw"
// reads as "365". Plain string work rather than a built regular expression —
// model names carry slashes and dashes that would need escaping.
function shortName(name, brand, category) {
  let s = String(name || "").trim();
  const low = () => s.toLowerCase();

  if (brand && low().startsWith(brand.toLowerCase())) {
    s = s.slice(brand.length).trim();
  }
  for (const suffix of [category].concat(NAME_SUFFIXES)) {
    if (suffix && low().endsWith(suffix.toLowerCase())) {
      s = s.slice(0, s.length - suffix.length).trim();
      break;
    }
  }
  return s || String(name || "").trim();
}

// Replace this model's entry and rewrite the index, leaving every other model
// exactly as it was.
function writeIndex(outDir, model, sourcePath, categoryOverride, figureCount) {
  const brand = brandOf(model.name);
  const category = (categoryOverride || categoryFromPath(sourcePath) || "").trim();
  const entry = {
    id: model.id,
    name: model.name,
    short: shortName(model.name, brand, category),
    brand,
    category,
    figures: figureCount,
    parts: (model.figures || []).reduce((n, f) => n + (f.parts ? f.parts.length : 0), 0),
  };

  const indexPath = path.join(outDir, "index.json");
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch (_) {}
  index = index.filter((m) => m.id !== model.id);
  index.push(entry);
  index.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
  return entry;
}

module.exports = { brandOf, categoryFromPath, shortName, writeIndex, NAME_SUFFIXES };
