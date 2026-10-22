// ALTERNATIVE PARTS. Run against a throwaway database:
//
//   node tools/test-part-alternatives.js C:/temp/scratch.db
//
// John, 22 Oct 2026: SZEN 140051111 (Shoe Clutch) had a note reading only
// "140051111R", so every technician adding it was asked "Add this part
// anyway?" as if it were superseded. It is not: M1618GC 140051111R is what to
// use when the original is out of stock. Checked here: that note is moved
// across once on start-up, and alternatives are stored, listed per part and
// for many parts at once, one way only, and removed.
const path = require("path");
const fs = require("fs");
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// A database as the live one was: the note in place, no alternatives table.
const { DatabaseSync } = require("node:sqlite");
for (const f of [target, target + "-wal", target + "-shm"]) { try { fs.unlinkSync(f); } catch (_) {} }
const seed = new DatabaseSync(target);
seed.exec(`CREATE TABLE part_notes (item_code TEXT PRIMARY KEY, note TEXT NOT NULL,
  updated_by TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now','localtime')));
  INSERT INTO part_notes (item_code, note, updated_by) VALUES ('SZEN 140051111', '140051111R', 'J');
  INSERT INTO part_notes (item_code, note, updated_by) VALUES ('SZEN 848BE058B2', 'Replaced by 848BE058B2R', 'J');`);
seed.close();

process.env.OM_DB_PATH = target;
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));

console.log("-- the old note, moved across on start-up --");
check("the note is gone", data.notes.getPartNote("SZEN 140051111"), null);
check("and is an alternative now", data.alternatives.list("SZEN 140051111").map((a) => a.alt_code), ["M1618GC 140051111R"]);
check("a real supersession note is left alone",
  (data.notes.getPartNote("SZEN 848BE058B2") || {}).note, "Replaced by 848BE058B2R");

console.log("\n-- adding, listing, removing --");
data.alternatives.add("SHUQ 503235109", "M1618SK WS7F", "CY");
data.alternatives.add("SHUQ 503235109", "M1618SK WS7F", "CY");
check("added once, however many times asked", data.alternatives.list("SHUQ 503235109").length, 1);
check("one way only", data.alternatives.list("M1618SK WS7F").length, 0);
check("many parts at once",
  data.alternatives.forCodes(["SZEN 140051111", "SHUQ 503235109", "NOTHING"]),
  { "SZEN 140051111": ["M1618GC 140051111R"], "SHUQ 503235109": ["M1618SK WS7F"] });
let refused = "";
try { data.alternatives.add("X 1", "X 1", "CY"); } catch (e) { refused = e.message; }
check("a part is not its own alternative", /own alternative/.test(refused), true);
data.alternatives.remove(data.alternatives.list("SHUQ 503235109")[0].id);
check("removed", data.alternatives.list("SHUQ 503235109").length, 0);

console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
process.exit(failures ? 1 : 0);
