// What AutoCount calls the kind of machine a model is.
//
//   cd /d C:\om-order-app
//   node tools\show-item-categories.js
//
// RUN THIS ON THE SERVER. It is the only machine that can reach AutoCount.
//
// WHY IT EXISTS
// machine-types.js names a machine from John's own list - "EBZ5100" prints as
// "EBZ5100 Backpack Blower". Everything NOT on that list is meant to take its
// type from AutoCount's Item Category instead, and nothing can be written
// against that field until we have seen it: AutoCount installations differ on
// what the column is called, and the values might be readable words or they
// might be internal codes. Printing "M01" on a customer's quotation would be
// worse than printing nothing.
//
// So this looks, and prints what it found. Paste the output back.
//
// READ-ONLY. Every statement is a SELECT against system catalogues or a TOP-N
// sample. There is no INSERT, UPDATE or DELETE anywhere in this file, and it
// writes nothing to disk.
//
// If it cannot read the service settings, the AutoCount connection details can
// be given in the environment instead - see backend/data/autocountConnection.js.
const path = require("path");

// The AUTOCOUNT_DB_* vars live on the OMService service, not in a shell, so a
// bare `node` run has to be told to read them. Requiring the module only
// defines the functions; .load() is the part that matters.
try {
  require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load();
} catch (e) {
  console.log("(could not read the service settings: " + e.message + ")");
}

const { query } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));

// Machines, not spare parts: the catalogue files whole units under a U prefix.
// Picked to span the brands, so a category that only exists for Husqvarna is
// visible as such.
const SAMPLE_MODELS = [
  "EBZ5100", "EB6200", "BK3410", "BK4310", "HB2302", "HBZ260",
  "525BX", "525LK", "572XP", "T525", "AM550", "PHT1500",
  "IS2600Z", "226V-G4", "K10SP", "GZ2800",
];

const pad = (s, n) => String(s == null ? "" : s).padEnd(n);

async function main() {
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  console.log(`Connected to ${who[0].db} as ${who[0].login} (read-only)\n`);

  // 1. WHICH COLUMN IS IT?
  // Anything on Item that could plausibly hold a category. Named rather than
  // guessed at, because a column that does not exist fails the whole query.
  console.log("=== Columns on Item that could hold a category ===");
  const cols = await query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS Len
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME = 'Item'
       AND ( COLUMN_NAME LIKE '%Group%'
          OR COLUMN_NAME LIKE '%Categ%'
          OR COLUMN_NAME LIKE '%Type%'
          OR COLUMN_NAME LIKE '%Class%'
          OR COLUMN_NAME LIKE '%Brand%'
          OR COLUMN_NAME LIKE '%Desc%' )
     ORDER BY COLUMN_NAME`);
  if (!cols.length) {
    console.log("  (none - the item table may not be called Item on this install)");
    return;
  }
  cols.forEach((c) =>
    console.log(`  ${pad(c.COLUMN_NAME, 26)} ${c.DATA_TYPE}${c.Len ? "(" + c.Len + ")" : ""}`));
  console.log("");

  // Only the code-ish ones are worth sampling; Description and Desc2 we
  // already read elsewhere and already know are long free text.
  const catCols = cols
    .map((c) => c.COLUMN_NAME)
    .filter((n) => !/^Desc/i.test(n));
  if (!catCols.length) {
    console.log("No category-like column found. Paste the list above back and we'll look again.");
    return;
  }

  // 2. WHAT IS IN IT, for machines we actually service?
  console.log("=== Real machines, and what those columns say ===");
  const select = catCols.map((c) => `i.[${c}]`).join(",\n            ");
  for (const model of SAMPLE_MODELS) {
    const rows = await query(
      `SELECT TOP 1
              i.ItemCode,
              LEFT(COALESCE(NULLIF(i.Description, ''), ''), 46) AS Descr,
              ${select}
         FROM Item i
        WHERE i.IsActive = 'T'
          AND UPPER(i.ItemCode) LIKE 'U%'
          AND REPLACE(UPPER(i.ItemCode), ' ', '') LIKE '%' + @m + '%'
        ORDER BY i.ItemCode`,
      { m: model.replace(/\s+/g, "").toUpperCase() }
    );
    if (!rows.length) { console.log(`  ${pad(model, 12)} (not in the catalogue)`); continue; }
    const r = rows[0];
    const vals = catCols.map((c) => `${c}=${r[c] == null || r[c] === "" ? "-" : r[c]}`).join("  ");
    console.log(`  ${pad(model, 12)} ${pad(r.ItemCode, 26)} ${pad(r.Descr, 48)}`);
    console.log(`  ${pad("", 12)} ${vals}`);
  }
  console.log("");

  // 3. ARE THE VALUES CODES WITH A LOOKUP BEHIND THEM?
  // If Item holds "M01" there is usually a table that says M01 means Blower.
  // Show what each column's distinct values look like, and the lookup if
  // there is one - that is what decides whether this can be printed at all.
  for (const col of catCols) {
    const vals = await query(
      `SELECT TOP 25 i.[${col}] AS v, COUNT(*) AS n
         FROM Item i
        WHERE i.IsActive = 'T' AND UPPER(i.ItemCode) LIKE 'U%'
          AND i.[${col}] IS NOT NULL AND i.[${col}] <> ''
        GROUP BY i.[${col}]
        ORDER BY COUNT(*) DESC`);
    if (!vals.length) continue;
    console.log(`=== ${col}: the values machines actually carry ===`);
    vals.forEach((v) => console.log(`  ${pad(v.v, 30)} ${v.n} machine(s)`));

    // A table of the same name usually holds the readable version.
    const lk = await query(
      `SELECT TOP 1 TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = @t`, { t: col });
    if (lk.length) {
      const lkCols = await query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`, { t: col });
      console.log(`  -> there is a "${col}" table: ${lkCols.map((c) => c.COLUMN_NAME).join(", ")}`);
      const desc = lkCols.map((c) => c.COLUMN_NAME).find((n) => /desc|name/i.test(n));
      if (desc) {
        const rows = await query(`SELECT TOP 25 * FROM [${col}]`);
        console.log(`  -> what those codes mean:`);
        rows.forEach((r) => {
          const key = Object.values(r)[0];
          console.log(`       ${pad(key, 22)} ${r[desc]}`);
        });
      }
    }
    console.log("");
  }

  console.log("Done. Paste all of the above back - none of it is confidential;");
  console.log("it is column names and the names of machine categories.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFailed: " + e.message);
    console.error("\nIf this says the login failed, the AUTOCOUNT_DB_* settings could not");
    console.error("be read. Run it from C:\\om-order-app so serviceEnv can find the service.");
    process.exit(1);
  });
