// inspect-prices.js
// ============================================================================
// READ-ONLY AutoCount inspector, focused on PRICE TIERS.
//
// The app currently knows one price per item (ItemUOM.Price). To show List,
// Contractor and Reseller prices we need to know where your AutoCount keeps
// them — a multi-pricing table, extra columns, or named price categories.
// This script finds out and prints it.
//
// HOW TO RUN (on the server, from the backend folder):
//   node inspect-prices.js
//
// Then copy the whole output back to me.
//
// SAFETY: every statement is a SELECT against system catalogs or a TOP-few
// sample. There is no INSERT, UPDATE or DELETE anywhere in this file, so it
// cannot change anything in AutoCount.
//
// A sample item code can be passed to see its actual prices:
//   node inspect-prices.js "SZEN 8488C34101"
// ============================================================================

const { query } = require("./data/autocountConnection");

const SAMPLE_ITEM = process.argv[2] || "";

async function main() {
  console.log("Connecting to AutoCount SQL Server (read-only)…\n");
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  console.log(`Database: ${who[0].db}  (login: ${who[0].login})\n`);

  // 1. Any table with "Price" in the name.
  console.log("=== Tables with 'Price' in the name ===");
  const priceTables = await query(`
    SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME LIKE '%Price%'
     ORDER BY TABLE_NAME
  `);
  priceTables.forEach((t) => console.log(`  ${t.TABLE_NAME}`));
  if (!priceTables.length) console.log("  (none)");
  console.log("");

  // 2. Every column with "Price" in the name, anywhere. This is what catches a
  //    schema that keeps tiers as Price1/Price2/Price3 style columns.
  console.log("=== Columns with 'Price' in the name (any table) ===");
  const priceCols = await query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE COLUMN_NAME LIKE '%Price%'
     ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  priceCols.forEach((c) => console.log(`  ${c.TABLE_NAME}.${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
  console.log("");

  // 3. Full column list for the price-ish tables, so the join keys are visible.
  for (const t of priceTables) {
    const cols = await query(
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`,
      { t: t.TABLE_NAME }
    );
    console.log(`=== Columns in ${t.TABLE_NAME} ===`);
    cols.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
    try {
      const n = await query(`SELECT COUNT(*) AS n FROM [${t.TABLE_NAME}]`);
      console.log(`  rows: ${n[0].n}`);
      const sample = await query(`SELECT TOP 5 * FROM [${t.TABLE_NAME}]`);
      console.log(`  sample: ${JSON.stringify(sample)}`);
    } catch (e) {
      console.log(`  (could not sample: ${e.message})`);
    }
    console.log("");
  }

  // 4. ItemUOM in full — the tiers may simply be extra columns here.
  console.log("=== Columns in ItemUOM ===");
  const uomCols = await query(`
    SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME = 'ItemUOM' ORDER BY ORDINAL_POSITION
  `);
  uomCols.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
  console.log("");

  // 5. Anything that looks like a named price category / customer tier —
  //    "Contractor" and "Reseller" are business names, so they most likely
  //    appear as data rather than as column names.
  console.log("=== Tables with 'Categor' or 'Tier' or 'Level' in the name ===");
  const catTables = await query(`
    SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_TYPE = 'BASE TABLE'
       AND (TABLE_NAME LIKE '%Categor%' OR TABLE_NAME LIKE '%Tier%' OR TABLE_NAME LIKE '%Level%')
     ORDER BY TABLE_NAME
  `);
  for (const t of catTables) {
    console.log(`  ${t.TABLE_NAME}`);
    try {
      const sample = await query(`SELECT TOP 5 * FROM [${t.TABLE_NAME}]`);
      if (sample.length) console.log(`      sample: ${JSON.stringify(sample)}`);
    } catch (_) {}
  }
  if (!catTables.length) console.log("  (none)");
  console.log("");

  // 6. If an item code was given, show every price row that mentions it.
  if (SAMPLE_ITEM) {
    console.log(`=== Price rows for "${SAMPLE_ITEM}" ===`);
    for (const t of priceTables) {
      const hasItem = await query(
        `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @t AND COLUMN_NAME = 'ItemCode'`,
        { t: t.TABLE_NAME }
      );
      if (!hasItem[0].n) continue;
      try {
        const rows = await query(
          `SELECT TOP 10 * FROM [${t.TABLE_NAME}]
            WHERE REPLACE(UPPER(ItemCode), ' ', '') = @code
               OR REPLACE(UPPER(ItemCode), ' ', '') LIKE '%' + @code`,
          { code: SAMPLE_ITEM.replace(/\s+/g, "").toUpperCase() }
        );
        console.log(`  ${t.TABLE_NAME}: ${rows.length ? JSON.stringify(rows) : "(no rows)"}`);
      } catch (e) {
        console.log(`  ${t.TABLE_NAME}: (query failed: ${e.message})`);
      }
    }
    const uom = await query(
      `SELECT * FROM ItemUOM
        WHERE REPLACE(UPPER(ItemCode), ' ', '') = @code
           OR REPLACE(UPPER(ItemCode), ' ', '') LIKE '%' + @code`,
      { code: SAMPLE_ITEM.replace(/\s+/g, "").toUpperCase() }
    );
    console.log(`  ItemUOM: ${JSON.stringify(uom)}`);

    // The Item row too — every column, so a price held on the item itself
    // rather than per UOM shows up.
    const item = await query(
      `SELECT TOP 3 * FROM Item
        WHERE REPLACE(UPPER(ItemCode), ' ', '') = @code
           OR REPLACE(UPPER(ItemCode), ' ', '') LIKE '%' + @code`,
      { code: SAMPLE_ITEM.replace(/\s+/g, "").toUpperCase() }
    );
    console.log(`  Item: ${JSON.stringify(item)}`);
    console.log("");
  }

  console.log("Done — nothing was modified.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
