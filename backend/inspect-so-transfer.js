// inspect-so-transfer.js
// ============================================================================
// READ-ONLY AutoCount inspector: what happens to a SALES ORDER after it is
// converted to a Delivery Order, an Invoice or a Cash Sale.
//
// WHY THIS EXISTS
// John asked (24 Sep 2026) whether the app can notice by itself that an SO has
// become DO-2609-123, and record that against the slip - instead of somebody
// typing the number into Close Service by hand.
//
// Knowing an SO was transferred is the easy half: SODtl carries a transferred
// quantity. Knowing WHICH document it became needs a link from the target
// document back to the order, which in AutoCount is normally a FromDocType /
// FromDocKey pair on the target's detail rows. That is standard, but standard
// is not the same as present, and the whole feature stands on it. This script
// finds out rather than assuming - the same way purchaseOrderShape() works out
// the PO columns at runtime instead of trusting a guess.
//
// HOW TO RUN (on the server, from the backend folder):
//   inspect-so-transfer.bat
//
// To trace one order in particular:
//   inspect-so-transfer.bat "SO-2609-001"
//
// SAFETY: every statement is a SELECT, against either a system catalog or a
// TOP-few sample. There is no INSERT, UPDATE or DELETE anywhere in this file,
// so it cannot change anything in AutoCount. It is safe to run in the middle
// of a working day.
// ============================================================================

require("./serviceEnv").load();
const { query } = require("./data/autocountConnection");

const WANTED_SO = String(process.argv[2] || "").trim();

// The four documents this question is about. AutoCount spells the detail table
// "SODtl" in some versions and "SODTL" in others, so nothing here is spelled
// out - the real names come from the catalog below.
const DOCS = [
  ["SO", "Sales Order"],
  ["DO", "Delivery Order"],
  ["IV", "Invoice"],
  ["CS", "Cash Sale"],
];

const line = (s) => console.log(s);
const rule = () => line("-".repeat(70));

// Real table names, whatever case they are stored in.
let TABLES = new Map();          // upper-case name -> actual name
const real = (name) => TABLES.get(String(name).toUpperCase()) || null;

// Columns per table, so a query is only ever built from names that exist.
const COLS = new Map();          // actual table name -> [actual column names]
function col(table, want) {
  const list = COLS.get(table) || [];
  return list.find((c) => c.toLowerCase() === String(want).toLowerCase()) || null;
}
function colsLike(table, re) {
  return (COLS.get(table) || []).filter((c) => re.test(c));
}

async function main() {
  line("");
  line("Connecting to AutoCount SQL Server (read-only)…");
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  line(`Database: ${who[0].db}   (login: ${who[0].login})`);
  line("");

  // -------------------------------------------------------------------------
  // 1. Which of these tables actually exist, and what are they called?
  // -------------------------------------------------------------------------
  rule();
  line("1. THE TABLES");
  rule();
  const all = await query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
  );
  TABLES = new Map(all.map((t) => [String(t.TABLE_NAME).toUpperCase(), String(t.TABLE_NAME)]));

  const found = [];
  for (const [code, label] of DOCS) {
    const master = real(code);
    const detail = real(code + "DTL") || real(code + "Dtl");
    line(`  ${label.padEnd(15)} master: ${master || "(not found)"}   detail: ${detail || "(not found)"}`);
    if (master && detail) found.push({ code, label, master, detail });
  }
  if (!found.length) {
    line("");
    line("  None of the four document tables were found. Nothing else can be checked.");
    return;
  }

  // Their columns, once, so every query below is built from real names.
  for (const f of found) {
    for (const t of [f.master, f.detail]) {
      const cs = await query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t`,
        { t }
      );
      COLS.set(t, cs.map((c) => String(c.COLUMN_NAME)));
    }
  }

  // -------------------------------------------------------------------------
  // 2. THE QUESTION THAT DECIDES IT: does a target document say where it came
  //    from? Anything named From…, Source… or Transfer… is a candidate.
  // -------------------------------------------------------------------------
  line("");
  rule();
  line("2. DOES A DO / INVOICE / CASH SALE SAY WHICH ORDER IT CAME FROM?");
  rule();
  line("  (this is the one that decides whether the feature is possible)");
  line("");
  const LINKISH = /^(from|source|src|transfer|ref)/i;
  for (const f of found) {
    const onDetail = colsLike(f.detail, LINKISH);
    const onMaster = colsLike(f.master, LINKISH);
    line(`  ${f.label} (${f.detail})`);
    line(`      detail: ${onDetail.length ? onDetail.join(", ") : "(nothing that looks like a link)"}`);
    line(`      master: ${onMaster.length ? onMaster.join(", ") : "(nothing that looks like a link)"}`);
  }

  // -------------------------------------------------------------------------
  // 3. What the Sales Order's own lines say about having been transferred.
  // -------------------------------------------------------------------------
  const so = found.find((f) => f.code === "SO");
  if (so) {
    line("");
    rule();
    line("3. WHAT A SALES ORDER LINE RECORDS ABOUT BEING TRANSFERRED");
    rule();
    const qtyish = colsLike(so.detail, /(qty|quantity|outstanding|transfer)/i);
    line(`  ${so.detail}: ${qtyish.join(", ") || "(no quantity-looking columns)"}`);
  }

  // -------------------------------------------------------------------------
  // 4. A REAL EXAMPLE. Take recent target documents and print whatever their
  //    link columns actually contain - the proof that they are filled in, not
  //    merely present.
  // -------------------------------------------------------------------------
  line("");
  rule();
  line("4. REAL ROWS - are those columns actually filled in?");
  rule();
  for (const f of found.filter((x) => x.code !== "SO")) {
    const mNo = col(f.master, "DocNo");
    const mKey = col(f.master, "DocKey");
    const dKey = col(f.detail, "DocKey");
    const mDate = col(f.master, "DocDate");
    const links = colsLike(f.detail, LINKISH);
    if (!mNo || !mKey || !dKey || !links.length) {
      line("");
      line(`  ${f.label}: nothing to sample (no link columns, or no DocNo/DocKey).`);
      continue;
    }
    const pick = links.map((c) => `d.[${c}]`).join(", ");
    try {
      const rows = await query(
        `SELECT TOP 6 m.[${mNo}] AS DocNo${mDate ? `, m.[${mDate}] AS DocDate` : ""}, ${pick}
           FROM [${f.detail}] d JOIN [${f.master}] m ON m.[${mKey}] = d.[${dKey}]
          ${mDate ? `ORDER BY m.[${mDate}] DESC` : ""}`
      );
      line("");
      line(`  ${f.label} - most recent lines and what they say about their source:`);
      if (!rows.length) line("      (no rows at all)");
      for (const r of rows) {
        const bits = links.map((c) => `${c}=${r[c] === null ? "NULL" : r[c]}`);
        line(`      ${r.DocNo}${r.DocDate ? " " + String(r.DocDate).slice(0, 10) : ""} | ${bits.join(" ")}`);
      }
    } catch (e) {
      line(`  ${f.label}: could not sample - ${e.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. THE WHOLE JOURNEY, on one order. If a From…Key column exists on the
  //    target's detail rows, this walks it back to the Sales Order and prints
  //    the pair - which is exactly what the app would have to do.
  // -------------------------------------------------------------------------
  if (so) {
    line("");
    rule();
    line("5. FOLLOWING ONE ORDER THROUGH");
    rule();
    const soNo = col(so.master, "DocNo");
    const soKey = col(so.master, "DocKey");

    // The app's own orders are numbered SO-YYMM-NNN; prefer one of those, or
    // whatever was named on the command line.
    let target = null;
    try {
      const rows = WANTED_SO
        ? await query(`SELECT TOP 1 [${soNo}] AS DocNo, [${soKey}] AS DocKey FROM [${so.master}] WHERE [${soNo}] = @n`, { n: WANTED_SO })
        : await query(`SELECT TOP 1 [${soNo}] AS DocNo, [${soKey}] AS DocKey FROM [${so.master}] WHERE [${soNo}] LIKE 'SO-%' ORDER BY [${soKey}] DESC`);
      target = rows[0] || null;
      if (!target && !WANTED_SO) {
        const any = await query(`SELECT TOP 1 [${soNo}] AS DocNo, [${soKey}] AS DocKey FROM [${so.master}] ORDER BY [${soKey}] DESC`);
        target = any[0] || null;
      }
    } catch (e) {
      line(`  Could not pick a Sales Order: ${e.message}`);
    }

    if (!target) {
      line(`  No Sales Order found${WANTED_SO ? ` called ${WANTED_SO}` : ""}.`);
    } else {
      line(`  Following ${target.DocNo}  (DocKey ${target.DocKey})`);
      line("");
      for (const f of found.filter((x) => x.code !== "SO")) {
        const fromKey = colsLike(f.detail, /^from.*key$/i)[0];
        const fromType = colsLike(f.detail, /^from.*type$/i)[0];
        const mNo = col(f.master, "DocNo");
        const mKey = col(f.master, "DocKey");
        const dKey = col(f.detail, "DocKey");
        if (!fromKey || !mNo || !mKey || !dKey) {
          line(`    ${f.label.padEnd(15)} cannot be traced - no From…Key column on ${f.detail}`);
          continue;
        }
        try {
          const hits = await query(
            `SELECT DISTINCT m.[${mNo}] AS DocNo${fromType ? `, d.[${fromType}] AS FromType` : ""}
               FROM [${f.detail}] d JOIN [${f.master}] m ON m.[${mKey}] = d.[${dKey}]
              WHERE d.[${fromKey}] = @k`,
            { k: target.DocKey }
          );
          line(`    ${f.label.padEnd(15)} ${hits.length
            ? hits.map((h) => h.DocNo + (h.FromType ? ` (from ${h.FromType})` : "")).join(", ")
            : "- none"}`);
        } catch (e) {
          line(`    ${f.label.padEnd(15)} lookup failed - ${e.message}`);
        }
      }
      line("");
      line("  If a document number appeared on any line above, the app can find it");
      line("  the same way, and the feature is buildable. If every line says");
      line("  \"cannot be traced\", the link is somewhere else and I will look again.");
    }
  }

  line("");
  rule();
  line("Done. Copy this whole output back to Claude.");
  rule();
  line("");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\nFAILED: " + e.message);
  console.error("\nNothing was changed - this script only reads.");
  process.exit(1);
});
