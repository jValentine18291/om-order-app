// WHY WILL AUTOCOUNT NOT SAVE THIS SALES ORDER? ("Primary Key Error")
//
//   cd /d C:\om-order-app
//   node tools\show-so-keys.js SO-2611-041
//   node tools\show-so-keys.js SO-2611-041 SO-2611-040 SO-2611-042
//
// RUN THIS ON THE SERVER. READ ONLY: SELECTs, nothing written, nothing locked.
//
// 11 Nov 2026: editing SO-2611-041 in AutoCount (written by the app on 10 Nov,
// slip 00148) was refused with "Primary Key Error". The app numbers a new
// order's keys itself - DocKey = highest key in the document tables + 1, and
// its lines DocKey+1, +2 ... - on the understanding that AutoCount does the
// same. This prints what is actually there so that understanding can be
// checked rather than assumed:
//   1. each order's DocKey and every line's DtlKey, Seq and Guid;
//   2. any OTHER row anywhere in the document tables using one of those keys;
//   3. two lines of one order sharing a Seq or a Guid;
//   4. the highest key in use now, and the orders just before and after;
//   5. any table or SQL sequence whose name suggests AutoCount keeps its own
//      key counter - if one exists, the app is not moving it.
const path = require("path");

try { require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load(); }
catch (e) { console.log("  (could not read the service settings: " + e.message + ")"); }

const docs = process.argv.slice(2).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
if (!docs.length) { console.log("\n  Usage: node tools\\show-so-keys.js SO-2611-041 [more SOs]\n"); process.exit(2); }

const { query } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));
const { KEY_TABLES } = require(path.resolve(__dirname, "..", "backend", "data", "autocountSalesOrder.js"));
const say = (s = "") => console.log("  " + s);
const cut = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const when = (v) => (v instanceof Date ? v.toISOString().replace("T", " ").slice(0, 19) + "Z" : String(v || ""));

(async () => {
  console.log("");
  if ((process.env.ITEMS_SOURCE || "").toLowerCase() !== "autocount") {
    say("Run this on the server - AutoCount is not switched on here."); console.log(""); process.exit(1);
  }

  for (const docNo of docs) {
    const head = await query("SELECT DocKey, DocNo, DocDate, Cancelled, CreatedUserID, LastModifiedUserID, CreatedTimeStamp, LastModified FROM SO WHERE DocNo = @d", { d: docNo });
    if (!head.length) { say(`${docNo}: not in AutoCount.`); say(""); continue; }
    const h = head[0];
    say(`${docNo}   DocKey ${h.DocKey}   created ${when(h.CreatedTimeStamp)} by ${cut(h.CreatedUserID, 12)}, last saved ${when(h.LastModified)} by ${cut(h.LastModifiedUserID, 12)}${String(h.Cancelled).trim() === "T" ? "   CANCELLED" : ""}`);
    const lines = await query("SELECT DtlKey, DocKey, Seq, ItemCode, Description, Guid FROM SODTL WHERE DocKey = @k ORDER BY Seq, DtlKey", { k: h.DocKey });
    for (const l of lines) say(`   DtlKey ${l.DtlKey}  Seq ${String(l.Seq).padStart(4)}  ${cut(l.ItemCode, 18).padEnd(18)} ${cut(l.Description, 40).padEnd(40)} ${cut(l.Guid, 36)}`);
    if (!lines.length) say("   (no lines)");

    // Same Seq or same Guid twice within the order.
    const twice = (key) => {
      const seen = new Map();
      for (const l of lines) { const v = String(l[key] == null ? "" : l[key]).trim(); if (!v) continue; seen.set(v, (seen.get(v) || 0) + 1); }
      return [...seen].filter(([, n]) => n > 1).map(([v, n]) => `${v} x${n}`);
    };
    for (const key of ["Seq", "Guid"]) { const d = twice(key); if (d.length) say(`   ** ${key} used more than once: ${d.join(", ")}`); }

    // Every key this order holds, looked for everywhere else.
    const keys = [h.DocKey, ...lines.map((l) => l.DtlKey)].map(Number).filter(Number.isFinite);
    const params = {}; keys.forEach((k, i) => { params[`k${i}`] = k; });
    const inList = keys.map((_, i) => `@k${i}`).join(",");
    const elsewhere = await query(KEY_TABLES.map(([t, c]) => `SELECT '${t}' AS T, [${c}] AS K FROM [${t}] WHERE [${c}] IN (${inList})`).join(" UNION ALL "), params);
    const mine = new Set([`SO:${h.DocKey}`, ...lines.map((l) => `SODTL:${l.DtlKey}`)]);
    const clashes = elsewhere.filter((r) => !mine.has(`${r.T}:${r.K}`));
    say(clashes.length ? `   ** ${clashes.length} key(s) ALSO used elsewhere: ${clashes.map((r) => `${r.T} ${r.K}`).join(", ")}` : "   No other document uses any of these keys.");
    say("");
  }

  // The highest keys in use, table by table.
  const tops = await query(KEY_TABLES.map(([t, c]) => `SELECT '${t}' AS T, MAX([${c}]) AS K FROM [${t}]`).join(" UNION ALL "));
  const ranked = tops.filter((r) => r.K !== null).sort((a, b) => Number(b.K) - Number(a.K)).slice(0, 6);
  say("Highest keys now: " + ranked.map((r) => `${r.T} ${r.K}`).join(", "));

  // Does AutoCount keep a counter of its own somewhere?
  const named = await query(`SELECT name FROM sys.tables
     WHERE name LIKE '%Key%' OR name LIKE '%Counter%' OR name LIKE '%Sequence%'
        OR name LIKE '%Generat%' OR name LIKE '%LastNo%' OR name LIKE '%NextNo%' OR name LIKE '%Identity%'
     ORDER BY name`);
  say("Tables that might hold a key counter: " + (named.length ? named.map((r) => r.name).join(", ") : "none"));
  try {
    const seqs = await query("SELECT name, CAST(current_value AS varchar(40)) AS v FROM sys.sequences ORDER BY name");
    say("SQL sequences: " + (seqs.length ? seqs.map((r) => `${r.name}=${r.v}`).join(", ") : "none"));
  } catch (e) { say("SQL sequences: could not read (" + e.message + ")"); }
  const ident = await query(`SELECT t.name AS T, c.name AS C FROM sys.identity_columns c JOIN sys.tables t ON t.object_id = c.object_id
     WHERE t.name IN ('SO','SODTL','DO','DODTL')`);
  say("Auto-numbered (IDENTITY) key columns on SO/DO: " + (ident.length ? ident.map((r) => `${r.T}.${r.C}`).join(", ") : "none"));
  console.log("");
})().catch((e) => { console.error("\n  Failed: " + e.message + "\n"); process.exit(1); });
