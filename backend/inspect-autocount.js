// inspect-autocount.js
// ============================================================================
// READ-ONLY AutoCount schema inspector.
//
// Run this on a machine that can reach the AutoCount SQL Server, with the
// AUTOCOUNT_DB_* environment variables set (see data/autocountConnection.js).
// It does NOT write anything — it only reads metadata (table and column names)
// and a tiny sample so we can see how your AutoCount version stores items and
// prices.
//
// HOW TO RUN (from the backend folder):
//   node inspect-autocount.js
//
// Then copy the printed output and share it back. Table/column names are safe
// to share. Review the few sample rows before sharing and remove them if
// anything looks sensitive.
//
// SAFETY: every statement here is a SELECT against system catalogs or a TOP-few
// sample. There are no INSERT/UPDATE/DELETE statements anywhere in this file.
// ============================================================================

const { query } = require("./data/autocountConnection");

async function main() {
  console.log("Connecting to AutoCount SQL Server (read-only)…\n");

  // 1. Confirm connection + which database we're on.
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  console.log(`Connected to database: ${who[0].db}  (login: ${who[0].login})\n`);

  // 2. Find tables whose names suggest items / stock / prices.
  console.log("=== Tables that look item/price related ===");
  const tables = await query(`
    SELECT TABLE_SCHEMA, TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
      AND (
        TABLE_NAME LIKE '%Item%' OR
        TABLE_NAME LIKE '%Stock%' OR
        TABLE_NAME LIKE '%Price%' OR
        TABLE_NAME LIKE '%Product%'
      )
    ORDER BY TABLE_NAME
  `);
  tables.forEach((t) => console.log(`  ${t.TABLE_SCHEMA}.${t.TABLE_NAME}`));
  console.log("");

  // 3. For the most likely item table, show its columns.
  const candidates = ["Item", "ItemMaster", "StockItem", "MST_Item"];
  for (const tbl of candidates) {
    const cols = await query(
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tbl
        ORDER BY ORDINAL_POSITION`,
      { tbl }
    );
    if (cols.length) {
      console.log(`=== Columns in "${tbl}" ===`);
      cols.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
      console.log("");

      try {
        const sample = await query(`SELECT TOP 3 * FROM ${tbl}`);
        console.log(`=== Sample rows from "${tbl}" (review before sharing) ===`);
        console.log(JSON.stringify(sample, null, 2));
        console.log("");
      } catch (e) {
        console.log(`  (could not sample ${tbl}: ${e.message})\n`);
      }
      break; // stop after the first matching candidate
    }
  }

  // 4. Item-UOM/price table columns (AutoCount often stores price per UOM).
  const uomCols = await query(
    `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'ItemUOM'
      ORDER BY ORDINAL_POSITION`
  );
  if (uomCols.length) {
    console.log(`=== Columns in "ItemUOM" ===`);
    uomCols.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
    console.log("");
  }

  // 5. Look for price-related columns anywhere.
  console.log("=== Columns mentioning 'price' anywhere ===");
  const priceCols = await query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE COLUMN_NAME LIKE '%Price%'
    ORDER BY TABLE_NAME, COLUMN_NAME
  `);
  priceCols.forEach((c) => console.log(`  ${c.TABLE_NAME}.${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
  console.log("");

  console.log("Done. Copy the above (table/column names) and share it back.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nInspection failed:");
  console.error("  " + err.message);
  console.error("\nCheck: env vars set correctly? server reachable? login valid?");
  process.exit(1);
});
