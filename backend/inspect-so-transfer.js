// inspect-so-transfer.js
// ============================================================================
// READ-ONLY AutoCount inspector: what happens to a SALES ORDER after it is
// converted to a Delivery Order, an Invoice or a Cash Sale.
//
// WHY THIS EXISTS
// John asked (24 Sep 2026) whether the app can notice by itself that an SO has
// become DO-2609-220, and record that against the slip - instead of somebody
// typing the number into Close Service by hand.
//
// WHAT THE FIRST RUN FOUND, 24 Sep 2026
//   - The tables are SO/SODTL, DO/DODTL, IV/IVDTL, CS/CSDTL.
//   - Every target detail table carries FromDocType, FromDocNo and
//     FromDocDtlKey. FromDocNo is the source document's NUMBER, which is
//     better than a key: no join is needed to know an invoice came from
//     SO-2609-046.
//   - But every row sampled had all three NULL, and the trace printed "none"
//     because it compared FromDocDtlKey (a DETAIL key) against the order's
//     DocKey (a MASTER key), which can never match. That was this script's
//     fault, not AutoCount's.
//
// SO THE QUESTION IS NOW A DIFFERENT ONE, and it is not really about the
// schema at all: has any document in this company's database EVER been made by
// transferring an order, or does the office key each one fresh? The columns
// being there means nothing if nobody uses the conversion that fills them.
// That is what this version asks.
//
// HOW TO RUN (on the server, from the backend folder):
//   inspect-so-transfer.bat
//   inspect-so-transfer.bat "SO-2609-046"
//
// SAFETY: every statement is a SELECT, against either a system catalog or a
// TOP-few sample. There is no INSERT, UPDATE or DELETE anywhere in this file,
// so it cannot change anything in AutoCount. Safe to run mid-afternoon.
// ============================================================================

require("./serviceEnv").load();
const { query } = require("./data/autocountConnection");

const WANTED_SO = String(process.argv[2] || "").trim();

const TARGETS = [
  ["DO", "DODTL", "Delivery Order"],
  ["IV", "IVDTL", "Invoice"],
  ["CS", "CSDTL", "Cash Sale"],
];

const line = (s) => console.log(s === undefined ? "" : s);
const rule = () => line("-".repeat(70));
const head = (n, t) => { line(""); rule(); line(`${n}. ${t}`); rule(); };

async function safe(label, fn) {
  try { return await fn(); }
  catch (e) { line(`  ${label}: could not be read - ${e.message}`); return null; }
}

async function main() {
  line("");
  line("Connecting to AutoCount SQL Server (read-only)…");
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  line(`Database: ${who[0].db}   (login: ${who[0].login})`);

  // -------------------------------------------------------------------------
  head(1, "HAS ANYTHING HERE EVER BEEN MADE BY TRANSFERRING A DOCUMENT?");
  // -------------------------------------------------------------------------
  line("  If these are all zero, nobody uses AutoCount's convert - every");
  line("  document is keyed fresh - and no link exists to read, however many");
  line("  columns are there to hold one.");
  line("");
  let anyLinked = 0;
  for (const [master, detail, label] of TARGETS) {
    const r = await safe(label, () => query(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN d.FromDocNo IS NOT NULL AND d.FromDocNo <> '' THEN 1 ELSE 0 END) AS linked
         FROM [${detail}] d`
    ));
    if (!r) continue;
    const n = Number(r[0].n) || 0, linked = Number(r[0].linked) || 0;
    anyLinked += linked;
    line(`  ${label.padEnd(15)} ${String(n).padStart(7)} lines, ${String(linked).padStart(7)} of them carry a FromDocNo`);
  }

  // What kind of source documents they name, when they name one.
  line("");
  for (const [, detail, label] of TARGETS) {
    const r = await safe(label, () => query(
      `SELECT d.FromDocType AS t, COUNT(*) AS n
         FROM [${detail}] d
        WHERE d.FromDocType IS NOT NULL AND d.FromDocType <> ''
        GROUP BY d.FromDocType ORDER BY COUNT(*) DESC`
    ));
    if (!r) continue;
    line(`  ${label} is made from: ${r.length ? r.map((x) => `${x.t} (${x.n} lines)`).join(", ") : "- nothing, ever"}`);
  }

  // -------------------------------------------------------------------------
  head(2, "REAL EXAMPLES OF A LINKED DOCUMENT");
  // -------------------------------------------------------------------------
  if (!anyLinked) {
    line("  None to show - nothing in this database was made by transfer.");
  } else {
    for (const [master, detail, label] of TARGETS) {
      const r = await safe(label, () => query(
        `SELECT TOP 6 m.DocNo AS DocNo, m.DocDate AS DocDate,
                d.FromDocType AS FromType, d.FromDocNo AS FromNo
           FROM [${detail}] d JOIN [${master}] m ON m.DocKey = d.DocKey
          WHERE d.FromDocNo IS NOT NULL AND d.FromDocNo <> ''
          ORDER BY m.DocDate DESC`
      ));
      if (!r || !r.length) continue;
      line("");
      line(`  ${label}:`);
      for (const x of r) {
        line(`      ${x.DocNo}  ${String(x.DocDate).slice(0, 15)}  <- ${x.FromType} ${x.FromNo}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  head(3, "THE SALES ORDERS THEMSELVES");
  // -------------------------------------------------------------------------
  const counts = await safe("SO", () => query(
    `SELECT COUNT(DISTINCT m.DocKey) AS orders,
            SUM(CASE WHEN d.TransferedQty > 0 THEN 1 ELSE 0 END) AS movedLines
       FROM SO m JOIN SODTL d ON d.DocKey = m.DocKey`
  ));
  if (counts) {
    line(`  ${counts[0].orders} sales orders, ${counts[0].movedLines || 0} lines with a transferred quantity.`);
  }
  // The app's own, which are numbered SO-YYMM-NNN.
  const ours = await safe("app's orders", () => query(
    `SELECT TOP 8 m.DocNo AS DocNo, m.DocDate AS DocDate,
            SUM(d.Qty) AS qty, SUM(d.TransferedQty) AS moved
       FROM SO m JOIN SODTL d ON d.DocKey = m.DocKey
      WHERE m.DocNo LIKE 'SO-%'
      GROUP BY m.DocNo, m.DocDate, m.DocKey
      ORDER BY m.DocKey DESC`
  ));
  if (ours) {
    line("");
    line("  The app's most recent orders, and how much of each has moved on:");
    if (!ours.length) line("      (none found)");
    for (const x of ours) {
      line(`      ${x.DocNo}  ${String(x.DocDate).slice(0, 15)}  qty ${x.qty}, transferred ${x.moved}`);
    }
  }

  // -------------------------------------------------------------------------
  head(4, "FOLLOWING ONE ORDER THROUGH - the right way this time");
  // -------------------------------------------------------------------------
  // By FromDocNo, which holds the order's NUMBER. The first version compared a
  // detail key against a master key and could never have matched.
  let soNo = WANTED_SO;
  if (!soNo) {
    const moved = await safe("a transferred order", () => query(
      `SELECT TOP 1 m.DocNo AS DocNo FROM SO m JOIN SODTL d ON d.DocKey = m.DocKey
        WHERE d.TransferedQty > 0 ORDER BY m.DocKey DESC`
    ));
    if (moved && moved.length) soNo = moved[0].DocNo;
  }
  if (!soNo) {
    const any = await safe("any order", () => query(
      `SELECT TOP 1 DocNo FROM SO ORDER BY DocKey DESC`));
    if (any && any.length) soNo = any[0].DocNo;
  }

  if (!soNo) {
    line("  No sales order to follow.");
  } else {
    line(`  Following ${soNo}`);
    line("");
    let hits = 0;
    for (const [master, detail, label] of TARGETS) {
      const r = await safe(label, () => query(
        `SELECT DISTINCT m.DocNo AS DocNo, m.DocDate AS DocDate, d.FromDocType AS FromType
           FROM [${detail}] d JOIN [${master}] m ON m.DocKey = d.DocKey
          WHERE d.FromDocNo = @n`,
        { n: soNo }
      ));
      if (!r) continue;
      hits += r.length;
      line(`    ${label.padEnd(15)} ${r.length
        ? r.map((x) => `${x.DocNo} (${String(x.DocDate).slice(0, 15)})`).join(", ")
        : "- none"}`);
    }
    line("");
    if (hits) {
      line("  FOUND. The app can read exactly this, and the feature is buildable.");
    } else {
      line("  Nothing found for that order. Either it has not been converted, or");
      line("  the office keys its documents fresh rather than converting - which");
      line("  section 1 above answers.");
    }
  }

  // -------------------------------------------------------------------------
  head(5, "WHAT THIS MEANS");
  // -------------------------------------------------------------------------
  if (anyLinked) {
    line("  AutoCount does record where a document came from, and this office");
    line("  does use it. The app can follow the same trail.");
  } else {
    line("  Nothing in this database has ever been made by converting another");
    line("  document. The columns exist but are never filled, so there is no");
    line("  trail to follow and the feature cannot work this way.");
    line("");
    line("  That is a question about how the office works, not about the app:");
    line("  it would mean staff key each DO / Invoice / Cash Sale fresh rather");
    line("  than converting the Sales Order.");
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
