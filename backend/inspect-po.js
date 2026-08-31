// inspect-po.js
// ============================================================================
// READ-ONLY AutoCount inspector, focused on PURCHASE ORDERS.
//
// The app shows "already on order" when someone is about to request more of a
// part, and reads that from AutoCount's PO / PODtl tables. This app had never
// touched those tables before, so nothing about their shape was assumed — the
// code looks the columns up at runtime and shows nothing if they are not what
// it expects. This script prints what is actually there, for when that
// happens or when the number looks wrong.
//
// HOW TO RUN (on the server, from the backend folder):
//   inspect-po.bat
//
// or, if the credentials are already in your session:
//   node inspect-po.js
//
// A part code can be passed to see its own outstanding quantity:
//   inspect-po.bat "SZEN 140051111"
//
// SAFETY: every statement is a SELECT against system catalogs or a TOP-few
// sample. There is no INSERT, UPDATE or DELETE anywhere in this file, so it
// cannot change anything in AutoCount.
// ============================================================================

const { query } = require("./data/autocountConnection");

const SAMPLE_ITEM = process.argv[2] || "";

async function main() {
  console.log("Connecting to AutoCount SQL Server (read-only)…\n");
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  console.log(`Database: ${who[0].db}  (login: ${who[0].login})\n`);

  // 1. Do the tables exist at all, and what are they called?
  const tables = await query(
    `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND (TABLE_NAME LIKE 'PO%' OR TABLE_NAME LIKE '%Purchase%')
      ORDER BY TABLE_NAME`
  );
  console.log("Tables whose name looks like a Purchase Order:");
  console.log("  " + (tables.map((t) => t.TABLE_NAME).join(", ") || "(none found)"));
  console.log("");

  // 2. The columns the app cares about.
  for (const t of ["PO", "PODtl"]) {
    const cols = await query(
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @t
        ORDER BY ORDINAL_POSITION`,
      { t }
    );
    if (!cols.length) { console.log(`${t}: no such table.\n`); continue; }
    console.log(`${t} — ${cols.length} columns:`);
    console.log("  " + cols.map((c) => `${c.COLUMN_NAME} (${c.DATA_TYPE})`).join("\n  "));
    console.log("");
  }

  // 3. What the app decided it could use.
  try {
    const acRepo = require("./data/autocountRepo");
    const shape = await acRepo.purchaseOrderShape();
    console.log("What the app will use:");
    console.log("  " + (shape ? JSON.stringify(shape, null, 2).replace(/\n/g, "\n  ")
                               : "NOTHING — the expected columns are missing, so the app hides the figure."));
    console.log("");

    if (SAMPLE_ITEM) {
      const map = await acRepo.getOnOrder([SAMPLE_ITEM]);
      console.log(`Outstanding for ${SAMPLE_ITEM}:`);
      console.log("  " + (map ? JSON.stringify(map.get(SAMPLE_ITEM.trim()) || { qty: 0, orders: [] })
                              : "unavailable"));
      console.log("");
    }
  } catch (e) {
    console.log("Could not run the app's own lookup: " + e.message + "\n");
  }

  // 4. A few real rows, so the numbers can be sanity-checked by eye.
  try {
    const sample = await query(
      `SELECT TOP 8 m.DocNo, m.DocDate, d.ItemCode, d.Qty
         FROM PODtl d JOIN PO m ON m.DocKey = d.DocKey
        ORDER BY m.DocDate DESC`
    );
    console.log("Most recent Purchase Order lines:");
    for (const r of sample) {
      console.log(`  ${r.DocNo} | ${String(r.DocDate).slice(0, 10)} | ${r.ItemCode} | qty ${r.Qty}`);
    }
  } catch (e) {
    console.log("Could not read sample rows: " + e.message);
  }
  console.log("\nDone. Copy this whole output back to Claude.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\nFAILED: " + e.message);
  process.exit(1);
});
