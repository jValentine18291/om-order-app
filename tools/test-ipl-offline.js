// Carrying the whole parts catalogue on the phone.
//
//   node tools/test-ipl-offline.js
//
// WHAT THIS IS FOR
// A technician on a customer's site has no office Wi-Fi and usually no useful
// signal. The IPL is what they need there most, and it needs nothing from the
// office - it is static drawings and small book files. So the app can fetch
// the lot in one go while they are still in the workshop.
//
// The strip on the IPL screen says "Available offline" when what is on the
// phone matches what the library is made of. Both sides of that comparison are
// worked out separately - one by counting cache entries, the other by adding
// up index.json - and if they ever disagree the strip either never turns green
// (so nobody trusts it) or turns green too early (so a technician finds out
// on site). Neither shows up in ordinary use, because ordinary use is in the
// office where everything loads anyway.
//
// WHAT IS CHECKED
//  1. The arithmetic matches the folder. index.json + one book each + one
//     drawing per figure + the brand logos = the files actually there.
//  2. Every drawing a book names exists, and nothing on disk is unreferenced.
//     A book naming a missing drawing would report a failed download for ever.
//  3. The service worker serves BOTH the drawings and the book files from the
//     cache that survives deploys. The books used to be on the versioned one,
//     which every deploy wipes - that would have left 80MB of drawings on a
//     phone with nothing left to describe them.
const path = require("path");
const fs = require("fs");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const root = path.resolve(__dirname, "..");
const iplDir = path.join(root, "frontend", "ipl");
const read = (p) => fs.readFileSync(p, "utf8");

const index = JSON.parse(read(path.join(iplDir, "index.json")));
const files = fs.readdirSync(iplDir);
const pngs = files.filter((f) => f.endsWith(".png"));
const jsons = files.filter((f) => f.endsWith(".json"));
const logos = fs.existsSync(path.join(iplDir, "brands"))
  ? fs.readdirSync(path.join(iplDir, "brands")).filter((f) => f.endsWith(".png"))
  : [];

console.log("\n-- what the library is made of --");
check("books in the index", index.length > 0, true);
check("one book file each, plus the index", jsons.length, index.length + 1);

const figures = index.reduce((n, m) => n + (Number(m.figures) || 0), 0);
// The app adds this up exactly this way - see iplOfflineExpected() in app.js.
// If the two ever part company the strip stops being able to say "all of it".
const expected = 1 + index.length + figures + logos.length;
const actual = pngs.length + jsons.length + logos.length;
check("the app's total matches the folder", expected, actual);
check("and that is what it is", actual, 708);

console.log("\n-- every drawing a book names is there --");
const named = new Set();
let missing = [];
for (const m of index) {
  const p = path.join(iplDir, `${m.id}.json`);
  if (!fs.existsSync(p)) { missing.push(`${m.id}.json`); continue; }
  const doc = JSON.parse(read(p));
  for (const f of doc.figures || []) {
    if (!f.image) { missing.push(`${m.id} fig ${f.number} has no image`); continue; }
    named.add(f.image);
    if (!fs.existsSync(path.join(iplDir, f.image))) missing.push(f.image);
  }
}
check("nothing a book asks for is absent", missing, []);
// One drawing per figure, which is what lets the count above be worked out
// from index.json alone rather than by opening all 72 books.
check("one drawing per figure", named.size, figures);
const orphans = pngs.filter((f) => !named.has(f));
check("and nothing spare on disk", orphans, []);

console.log("\n-- the worker serves both kinds from the lasting cache --");
const sw = read(path.join(root, "frontend", "sw.js"));
// The rule is lifted out of sw.js and run, rather than eyeballed: a regex that
// LOOKS right and matches nothing is the whole failure mode here.
const ruleLine = sw.split("\n").find(
  // "ipl" plain: in the source the slashes are escaped, so the line reads
  // \/ipl\/ and never contains the literal "/ipl/".
  (l) => l.includes("ipl") && l.includes(".test(url.pathname)"));
check("the IPL rule is still where it was", !!ruleLine, true);
if (ruleLine) {
  // The literal between the first slash and the last one before ".test", turned
  // back into a real RegExp so it can be asked questions. Read off the line
  // rather than matched with another regex - a regex that only LOOKS right and
  // matches nothing is exactly the failure this file exists to catch, and it
  // should not be the thing doing the catching.
  const body = ruleLine.slice(ruleLine.indexOf("/") + 1,
                              ruleLine.lastIndexOf("/", ruleLine.indexOf(".test(")));
  const rule = new RegExp(body);
  check("a drawing matches", rule.test("/ipl/hus120ib-fig1.png"), true);
  check("a brand logo matches", rule.test("/ipl/brands/husqvarna.png"), true);
  check("a book file matches", rule.test("/ipl/hus120ib.json"), true);
  check("the index matches", rule.test("/ipl/index.json"), true);
  // It must not swallow the app itself, or a deploy would never reach phones.
  check("the app's own files do not", rule.test("/app.js"), false);
  check("nor anything under /api/", rule.test("/api/slips"), false);
}
// The cache it puts them in is the one the activate step spares.
check("that cache survives a version bump",
  /keys\s*\r?\n?\s*\.filter\(\(k\) => k !== CACHE && k !== IPL_CACHE\)/.test(sw.replace(/\s+/g, " "))
    || sw.replace(/\s+/g, " ").includes("k !== CACHE && k !== IPL_CACHE"), true);

console.log("\n-- and the app counts it the same way --");
const app = read(path.join(root, "frontend", "app.js"));
check("the app reads the same cache name",
  app.includes('const IPL_CACHE_NAME = "om-ipl-diagrams"'), true);
check("which is the one the worker writes",
  sw.includes('const IPL_CACHE = "om-ipl-diagrams"'), true);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
