// inspect-stock.js
// ============================================================================
// READ-ONLY inspector #2: find where STOCK BALANCE quantities live.
// Same usage as inspect-autocount.js — set the AUTOCOUNT_DB_* env vars in the
// same Command Prompt window, then:  node inspect-stock.js "ITEMCODE"
// (pass a real item code that HAS stock, in quotes if it contains spaces)
//
// Only SELECTs against system catalogs, views list, and per-item samples.
// ============================================================================

require("./serviceEnv").load();
const { query } = require("./data/autocountConnection");

const itemCode = process.argv[2] || "";

async function main() {
  console.log("Connecting (read-only)…\n");
  const who = await query("SELECT DB_NAME() AS db");
  console.log(`Connected to: ${who[0].db}\n`);

  // 1. Views (the first inspection listed only base tables) that look stock/balance related.
  console.log("=== VIEWS mentioning stock/bal/qty ===");
  const views = await query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS
    WHERE TABLE_NAME LIKE '%Stock%' OR TABLE_NAME LIKE '%Bal%' OR TABLE_NAME LIKE '%Qty%'
    ORDER BY TABLE_NAME`);
  views.forEach((v) => console.log("  " + v.TABLE_NAME));

  // 2. Tables with Bal/Qty in the name (beyond the item ones we saw).
  console.log("\n=== TABLES mentioning Bal ===");
  const tabs = await query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE='BASE TABLE' AND (TABLE_NAME LIKE '%Bal%')
    ORDER BY TABLE_NAME`);
  tabs.forEach((t) => console.log("  " + t.TABLE_NAME));

  // 3. Columns of the most likely balance sources.
  for (const obj of ["StockDTL", "StockPBalance", "ItemLevelByLocation", "UTDStockCost"]) {
    const cols = await query(
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @obj ORDER BY ORDINAL_POSITION`, { obj });
    if (cols.length) {
      console.log(`\n=== Columns in "${obj}" ===`);
      cols.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
    }
  }

  // 4. If an item code was given, sample its rows in the candidates.
  if (itemCode) {
    const norm = itemCode.replace(/\s+/g, "").toUpperCase();
    console.log(`\n=== Samples for item "${itemCode}" ===`);
    for (const obj of ["StockDTL", "StockPBalance", "ItemLevelByLocation"]) {
      try {
        const rows = await query(
          `SELECT TOP 5 * FROM ${obj} WHERE REPLACE(UPPER(ItemCode),' ','') = @norm`, { norm });
        console.log(`\n-- ${obj}: ${rows.length} row(s)`);
        if (rows.length) console.log(JSON.stringify(rows, null, 2));
      } catch (e) {
        console.log(`\n-- ${obj}: (${e.message})`);
      }
    }
    // Shelf, for good measure (confirmed column).
    const shelf = await query(
      `SELECT ItemCode, UOM, Shelf FROM ItemUOM WHERE REPLACE(UPPER(ItemCode),' ','') = @norm`, { norm });
    console.log(`\n-- ItemUOM Shelf: ${JSON.stringify(shelf)}`);
  } else {
    console.log(`\n(No item code given — rerun as: node inspect-stock.js "SOME CODE" for samples)`);
  }

  console.log("\nDone. Copy ALL of the above and share it back.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nInspection failed:", err.message);
  process.exit(1);
});
