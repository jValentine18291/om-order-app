// How AutoCount ties a package's own items to its package line.
//
//   cd /d C:\om-order-app
//   node tools\show-package-lines.js
//
// RUN THIS ON THE SERVER. It is the only machine that can reach AutoCount.
//
// WHY IT EXISTS
// show-item-packages.js (27 Oct 2026) found that a sales document carries a
// package as one line with no item code and a PackageDocKey, PLUS the
// package's items as lines of their own - numbered from 16 again, so they are
// children of the package line, not ordinary lines. Nothing named "Package"
// links them, so the link is some other column. To write a Sales Order with a
// package that AutoCount can convert to a DO or invoice, the app has to copy
// that shape exactly. This prints every column of the lines of real documents
// that used a package, so the link can be seen rather than guessed.
//
// Also lists all six packages with their items, and whether any package code is
// also an ordinary item code.
//
// READ-ONLY. Every statement is a SELECT. There is no INSERT, UPDATE or DELETE
// anywhere in this file, and it writes nothing to disk.
const path = require("path");

try {
  require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load();
} catch (e) {
  console.log("(could not read the service settings: " + e.message + ")");
}

const { query } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));

const cell = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Buffer.isBuffer(v)) return null;
  const s = String(v).replace(/\s+/g, " ");
  if (s.startsWith("{\\rtf")) return "(rtf)";
  return s.slice(0, 40);
};

async function documentLines(table, docKey) {
  const rows = await query(`SELECT * FROM [${table}] WHERE DocKey = @k ORDER BY DtlKey`, { k: docKey });
  console.log(`--- ${table} DocKey ${docKey}: ${rows.length} line(s), every column that is filled ---`);
  for (const r of rows) {
    console.log("  " + Object.entries(r)
      .map(([k, v]) => [k, cell(v)])
      .filter(([, v]) => v !== null && v !== "" && v !== "0" && v !== "F")
      .map(([k, v]) => `${k}=${v}`).join("  "));
  }
  console.log("");
}

async function main() {
  const who = await query("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
  console.log(`Connected to ${who[0].db} as ${who[0].login} (read-only)\n`);

  // 1. The detail tables' columns, all of them, so the link column is in here.
  for (const t of ["SODTL", "CSDTL"]) {
    const cols = await query(
      `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`, { t });
    console.log(`=== ${t}: all ${cols.length} columns ===`);
    console.log("  " + cols.map((c) => c.c).join(", ") + "\n");
  }

  // 2. Two real documents that used a package: the cash sale with the
  // Cleaner Assy, and the newest DO with one.
  await documentLines("CSDTL", 2230413);
  const dos = await query(
    "SELECT TOP 1 DocKey FROM DODTL WHERE PackageDocKey IS NOT NULL ORDER BY DocKey DESC");
  if (dos.length) await documentLines("DODTL", dos[0].DocKey);

  // 3. Every package and its items, and whether the items add up to its price.
  console.log("=== All packages ===");
  const pk = await query("SELECT DocKey, PackageCode, Description, UnitPrice, NetTotal, IsActive, UserUOM FROM Package ORDER BY PackageCode");
  for (const p of pk) {
    const items = await query(
      "SELECT Seq, ItemCode, Description, UOM, Qty, UnitPrice, SubTotal FROM PackageDTL WHERE DocKey = @k ORDER BY Seq", { k: p.DocKey });
    const sum = items.reduce((t, i) => t + Number(i.SubTotal || 0), 0);
    const clash = await query("SELECT COUNT(*) AS n FROM Item WHERE ItemCode = @c", { c: p.PackageCode });
    console.log(`  ${p.PackageCode} | ${p.Description} | $${p.UnitPrice} | active ${p.IsActive} | UOM ${p.UserUOM || "-"} | items add up to $${sum.toFixed(2)}${clash[0].n ? " | ALSO AN ITEM CODE" : ""}`);
    items.forEach((i) => console.log(`      ${i.Seq}  ${i.ItemCode}  ${cell(i.Description)}  ${i.Qty} ${i.UOM}  @ ${i.UnitPrice}`));
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\nStopped: " + e.message);
  process.exit(1);
});
