// WHERE DOES AUTOCOUNT KEEP ITS NEXT KEY?
//
//   cd /d C:\om-order-app
//   node tools\find-key-counter.js
//
// RUN THIS ON THE SERVER. READ ONLY: SELECTs on small tables, nothing written.
//
// 11 Nov 2026, from tools\show-so-keys.js on SO-2611-040/041/042: AutoCount
// does NOT take "highest key + 1" as the app assumed. At 16:21 on 10 Nov it
// gave SALES02's new lines on SO-2611-041 keys 2254775-777, hours after the
// app had already used keys up to 2254823; and the DO raised from SO-2611-042
// got DocKey 2254795 - the very number the app had given that Sales Order.
// So AutoCount hands out keys from a counter of its own (probably a block per
// workstation), and every order the app writes uses up numbers that counter
// will hand out later. A later save that draws one of them in the same table
// is refused: the "Primary Key Error" on SO-2611-041.
//
// A counter table was not found by name, so this finds it by VALUE: every
// small table, every number or short text column, holding something in the
// range the keys are in now.
const path = require("path");

try { require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load(); }
catch (e) { console.log("  (could not read the service settings: " + e.message + ")"); }

const { query } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));
const say = (s = "") => console.log("  " + s);
const LOW = 2250000, HIGH = 2300000;      // around today's keys (2254949 at 11 Nov)
const MAX_ROWS = 5000;                    // a counter table is small; documents are not

(async () => {
  console.log("");
  if ((process.env.ITEMS_SOURCE || "").toLowerCase() !== "autocount") {
    say("Run this on the server - AutoCount is not switched on here."); console.log(""); process.exit(1);
  }

  const cols = await query(`
    SELECT t.name AS T, c.name AS C, ty.name AS Ty, c.max_length AS Len,
           (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS Rows
      FROM sys.tables t
      JOIN sys.columns c ON c.object_id = t.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE ty.name IN ('int','bigint','numeric','decimal','float','real','money','varchar','nvarchar','char','nchar')
     ORDER BY t.name, c.column_id`);
  const small = cols.filter((c) => Number(c.Rows) > 0 && Number(c.Rows) <= MAX_ROWS);
  const isText = (c) => /char/.test(c.Ty);
  const usable = small.filter((c) => !isText(c) || (Number(c.Len) > 0 && Number(c.Len) <= 1000));
  say(`Looking through ${new Set(usable.map((c) => c.T)).size} small tables (${usable.length} columns) for a value ${LOW}-${HIGH} ...`);
  say("");

  let hits = 0;
  for (const c of usable) {
    const col = `[${c.C}]`;
    // Text is matched by pattern rather than cast: no TRY_CAST on older SQL Server.
    const where = isText(c)
      ? `LTRIM(RTRIM(${col})) LIKE '22[5-9][0-9][0-9][0-9][0-9]'`
      : `${col} BETWEEN ${LOW} AND ${HIGH}`;
    let rows;
    try { rows = await query(`SELECT TOP 10 * FROM [${c.T}] WHERE ${where}`); }
    catch (e) { continue; }
    if (!rows.length) continue;
    hits++;
    say(`${c.T}.${c.C}   (${c.Ty}, table has ${c.Rows} rows)`);
    for (const r of rows) {
      const shown = Object.entries(r).slice(0, 6)
        .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 19) : String(v == null ? "" : v).replace(/\s+/g, " ").slice(0, 40)}`);
      if (!Object.keys(r).slice(0, 6).includes(c.C)) shown.push(`${c.C}=${r[c.C]}`);
      say("   " + shown.join("  "));
    }
    say("");
  }
  say(hits ? `${hits} column(s) found.` : "Nothing found in that range in any small table.");
  console.log("");
})().catch((e) => { console.error("\n  Failed: " + e.message + "\n"); process.exit(1); });
