// inspect-desc2.js
// ============================================================================
// READ-ONLY. Answers one question before any code is written:
//
//   Is the second description line on an AutoCount item reliably a list of the
//   machines that part fits?
//
// John believes it is, and the app already searches and displays it - but it
// is shown as an unlabelled grey line, so nobody knows what it means. Before
// building "which machines use this part" on top of it, this measures how
// consistently it is filled in and what shape the values take. Building a
// feature on a field that is populated half the time, in three different
// styles, is how a feature becomes a support burden.
//
// Only SELECTs. Nothing is written, and no credentials are printed.
//
// USAGE (on the server, from the backend folder):
//   inspect-desc2.bat
//   inspect-desc2.bat "544RR"        <- also show what one part says
// ============================================================================

const { query } = require("./data/autocountConnection");

const probe = process.argv[2] || "";
const pct = (n, of) => (of ? ((n / of) * 100).toFixed(1) + "%" : "-");

async function main() {
  const who = await query("SELECT DB_NAME() AS db");
  console.log(`Connected read-only to: ${who[0].db}\n`);

  // ---- 1. How much of the catalogue actually has a second line? ------------
  const [counts] = await query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(Desc2, ''))), '') IS NOT NULL THEN 1 ELSE 0 END) AS withDesc2,
           SUM(CASE WHEN LTRIM(RTRIM(ISNULL(Desc2, ''))) = LTRIM(RTRIM(ISNULL(Description, ''))) THEN 1 ELSE 0 END) AS sameAsDesc1
      FROM Item WHERE IsActive = 'T'`);
  console.log("=== COVERAGE (active items) ===");
  console.log(`  active items          : ${counts.total}`);
  console.log(`  have a 2nd line       : ${counts.withDesc2}  (${pct(counts.withDesc2, counts.total)})`);
  console.log(`  2nd line same as 1st  : ${counts.sameAsDesc1}  (these carry no extra information)\n`);

  // ---- 2. What shape are the values? --------------------------------------
  // A model list tends to be short and separated by commas or slashes. Prose
  // tends to be long and separated by spaces alone. The split tells us which.
  const [shape] = await query(`
    SELECT COUNT(*) AS n,
           AVG(CAST(LEN(Desc2) AS FLOAT)) AS avgLen,
           MAX(LEN(Desc2)) AS maxLen,
           SUM(CASE WHEN Desc2 LIKE '%,%' THEN 1 ELSE 0 END) AS withComma,
           SUM(CASE WHEN Desc2 LIKE '%/%' THEN 1 ELSE 0 END) AS withSlash,
           SUM(CASE WHEN Desc2 LIKE '%;%' THEN 1 ELSE 0 END) AS withSemi,
           SUM(CASE WHEN Desc2 LIKE '%[0-9]%' THEN 1 ELSE 0 END) AS withDigit
      FROM Item
     WHERE IsActive = 'T' AND NULLIF(LTRIM(RTRIM(ISNULL(Desc2, ''))), '') IS NOT NULL`);
  console.log("=== SHAPE OF THE 2nd LINE ===");
  console.log(`  average length        : ${Math.round(shape.avgLen)} characters (longest ${shape.maxLen})`);
  console.log(`  contains a comma      : ${shape.withComma}  (${pct(shape.withComma, shape.n)})`);
  console.log(`  contains a slash      : ${shape.withSlash}  (${pct(shape.withSlash, shape.n)})`);
  console.log(`  contains a semicolon  : ${shape.withSemi}  (${pct(shape.withSemi, shape.n)})`);
  console.log(`  contains a digit      : ${shape.withDigit}  (${pct(shape.withDigit, shape.n)})  <- model numbers usually do\n`);

  // ---- 3. Read some, at random, across the whole catalogue -----------------
  const sample = await query(`
    SELECT TOP 25 ItemCode, Description, Desc2
      FROM Item
     WHERE IsActive = 'T' AND NULLIF(LTRIM(RTRIM(ISNULL(Desc2, ''))), '') IS NOT NULL
     ORDER BY NEWID()`);
  console.log("=== 25 AT RANDOM (what the 2nd line actually says) ===");
  for (const r of sample) {
    console.log(`  ${String(r.ItemCode).padEnd(18)} | ${String(r.Description || "").slice(0, 34).padEnd(34)} | ${r.Desc2}`);
  }

  // ---- 4. Is it a controlled vocabulary or free text? ---------------------
  // If the same handful of values repeat across many parts, it is a real list
  // worth making tappable. If almost every value is unique, it is free text.
  const repeats = await query(`
    SELECT TOP 15 Desc2, COUNT(*) AS n
      FROM Item
     WHERE IsActive = 'T' AND NULLIF(LTRIM(RTRIM(ISNULL(Desc2, ''))), '') IS NOT NULL
     GROUP BY Desc2 HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC`);
  console.log("\n=== MOST REPEATED VALUES (shared by how many parts) ===");
  if (!repeats.length) console.log("  none repeat - the 2nd line is free text, unique per part");
  for (const r of repeats) console.log(`  ${String(r.n).padStart(5)} parts | ${r.Desc2}`);

  const [uniq] = await query(`
    SELECT COUNT(DISTINCT Desc2) AS distinctValues, COUNT(*) AS rows
      FROM Item
     WHERE IsActive = 'T' AND NULLIF(LTRIM(RTRIM(ISNULL(Desc2, ''))), '') IS NOT NULL`);
  console.log(`\n  ${uniq.distinctValues} distinct values across ${uniq.rows} parts`);
  console.log(`  ${uniq.distinctValues === uniq.rows ? "every value unique - free text" : "values are reused - a real vocabulary"}\n`);

  // ---- 5. One part the user named ----------------------------------------
  if (probe) {
    const norm = probe.replace(/\s+/g, "").toUpperCase();
    const rows = await query(
      `SELECT TOP 5 ItemCode, Description, Desc2
         FROM Item
        WHERE IsActive = 'T'
          AND (REPLACE(UPPER(ItemCode), ' ', '') LIKE '%' + @n + '%' OR Desc2 LIKE '%' + @q + '%')`,
      { n: norm, q: probe }
    );
    console.log(`=== ITEMS MATCHING "${probe}" ===`);
    if (!rows.length) console.log("  nothing matched");
    for (const r of rows) console.log(`  ${String(r.ItemCode).padEnd(18)} | ${r.Description} | ${r.Desc2 || "(no 2nd line)"}`);
    console.log();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("Failed:", e.message); process.exit(1); });
