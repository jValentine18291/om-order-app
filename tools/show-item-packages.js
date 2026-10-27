// How AutoCount stores Item Packages.
//
//   cd /d C:\om-order-app
//   node tools\show-item-packages.js
//
// RUN THIS ON THE SERVER. It is the only machine that can reach AutoCount.
//
// WHY IT EXISTS
// John, 27 Oct 2026: technicians should be able to pick an Item Package when
// adding parts to a machine, not only single items. The part search reads the
// Item table and nothing else, and AutoCount keeps packages in tables of their
// own whose names and columns differ between installations. Nothing can be
// written against them until we have seen them, so this looks and prints what
// it found. Paste the output back.
//
// READ-ONLY. Every statement is a SELECT against system catalogues or a TOP-N
// sample. There is no INSERT, UPDATE or DELETE anywhere in this file, and it
// writes nothing to disk.
const path = require("path");

try {
  require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load();
} catch (e) {
  console.log("(could not read the service settings: " + e.message + ")");
}

const { query } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));

const pad = (s, n) => String(s == null ? "" : s).padEnd(n);
const cell = (v) => {
  if (v == null) return "-";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, " ").slice(0, 40);
};

async function main() {
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  console.log(`Connected to ${who[0].db} as ${who[0].login} (read-only)\n`);

  // 1. Every table with "Package" in its name, with its row count.
  const tables = await query(`
    SELECT t.TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.TABLES t
     WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_NAME LIKE '%Package%'
     ORDER BY t.TABLE_NAME`);
  console.log("=== Tables with \"Package\" in the name ===");
  if (!tables.length) console.log("  (none)");
  for (const t of tables) {
    const n = await query(`SELECT COUNT(*) AS n FROM [${t.name}]`);
    console.log(`  ${pad(t.name, 34)} ${n[0].n} row(s)`);
  }
  console.log("");

  // 2. Their columns, and a few rows of each - only tables with rows, and only
  // the first eight columns of a row, so the output stays pasteable.
  for (const t of tables) {
    const cols = await query(
      `SELECT COLUMN_NAME AS c, DATA_TYPE AS d, CHARACTER_MAXIMUM_LENGTH AS len
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`, { t: t.name });
    console.log(`=== ${t.name}: columns ===`);
    console.log("  " + cols.map((c) => `${c.c} ${c.d}${c.len ? "(" + c.len + ")" : ""}`).join(", "));
    const rows = await query(`SELECT TOP 5 * FROM [${t.name}]`);
    if (rows.length) {
      console.log(`--- ${t.name}: first ${rows.length} row(s) ---`);
      for (const r of rows) {
        console.log("  " + Object.entries(r)
          .filter(([, v]) => !Buffer.isBuffer(v))
          .slice(0, 12)
          .map(([k, v]) => `${k}=${cell(v)}`).join("  "));
      }
    }
    console.log("");
  }

  // 3. Item columns that might mark an item as a package instead.
  const flags = await query(`
    SELECT COLUMN_NAME AS c, DATA_TYPE AS d
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME = 'Item' AND (COLUMN_NAME LIKE '%Package%' OR COLUMN_NAME LIKE '%Bom%' OR COLUMN_NAME LIKE '%Kit%')
     ORDER BY COLUMN_NAME`);
  console.log("=== Item columns that might mark a package ===");
  if (!flags.length) console.log("  (none)");
  flags.forEach((f) => console.log(`  ${f.c} ${f.d}`));
  console.log("");

  // 4. How a package travels on a sales document. The app writes Sales Orders
  // straight into SO/SODTL, and SODTL.ItemCode must be a real item, so a
  // package can only go on as one line if the detail tables have a column of
  // their own for it. And if AutoCount's own invoices have used packages, how
  // those lines look is the pattern to copy.
  for (const dtl of ["SODTL", "IVDTL", "CSDTL", "DODTL"]) {
    try { await packageColumns(dtl); } catch (e) { console.log(`  (${dtl}: ${e.message})`); }
  }
}

async function packageColumns(dtl) {
  {
    const pc = await query(
      `SELECT COLUMN_NAME AS c, DATA_TYPE AS d FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @t AND (COLUMN_NAME LIKE '%Package%' OR COLUMN_NAME LIKE '%Pkg%')
        ORDER BY ORDINAL_POSITION`, { t: dtl });
    console.log(`=== ${dtl}: package columns ===`);
    if (!pc.length) { console.log("  (none)"); return; }
    pc.forEach((c) => console.log(`  ${c.c} ${c.d}`));
    const where = pc.map((c) => `([${c.c}] IS NOT NULL AND CAST([${c.c}] AS nvarchar(100)) NOT IN ('', 'F', '0'))`).join(" OR ");
    const used = await query(`SELECT COUNT(*) AS n FROM [${dtl}] WHERE ${where}`);
    console.log(`  lines that use them: ${used[0].n}`);
    if (used[0].n) {
      const keys = await query(`SELECT TOP 2 DocKey FROM [${dtl}] WHERE ${where} GROUP BY DocKey ORDER BY DocKey DESC`);
      for (const k of keys) {
        const lines = await query(
          `SELECT ${["Seq", "ItemCode", "Description", "Qty", "UOM", "UnitPrice", ...pc.map((c) => c.c)]
              .map((c) => `[${c}]`).join(", ")}
             FROM [${dtl}] WHERE DocKey = @k ORDER BY Seq`, { k: k.DocKey });
        console.log(`  --- one ${dtl.replace("DTL", "")} that used a package (DocKey ${k.DocKey}) ---`);
        lines.forEach((l) => console.log("    " + Object.entries(l).map(([n, v]) => `${n}=${cell(v)}`).join("  ")));
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\nStopped: " + e.message);
  process.exit(1);
});
