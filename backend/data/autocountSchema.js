// data/autocountSchema.js
// ============================================================================
// READ-ONLY inspection of AutoCount's Sales Order tables.
//
// Nothing here writes. It exists so the Sales Order insert can be built from
// AutoCount's real schema rather than a guess: a document carries a running
// number, GST codes and amounts, and required columns that differ between
// AutoCount versions, and getting any of them wrong writes a broken document
// into the accounts.
//
// Every statement below is a SELECT. There is no INSERT, UPDATE or DELETE in
// this file, and there must never be.
// ============================================================================

const { query } = require("./autocountConnection");

// Tables whose names suggest sales orders or document numbering, so we find
// out what this installation actually calls them instead of assuming "SO".
async function findTables() {
  return query(
    `SELECT TABLE_NAME AS name
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND ( TABLE_NAME LIKE 'SO%'
           OR TABLE_NAME LIKE '%SalesOrder%'
           OR TABLE_NAME LIKE '%DocNum%'
           OR TABLE_NAME LIKE '%RunningNum%'
           OR TABLE_NAME LIKE '%DocumentNum%' )
      ORDER BY TABLE_NAME`
  );
}

// Column definitions, with the detail that matters for an insert: what is
// NOT NULL, and what already has a default (so it can be left out).
async function columns(table) {
  return query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type,
            CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS [default]
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @table
      ORDER BY ORDINAL_POSITION`,
    { table }
  );
}

// The most recent Sales Order, header and lines. Seeing one real document is
// worth more than any amount of column-name reading: it shows which columns
// are actually populated, how GST is recorded, and how the note lines in
// John's block are represented.
async function sampleOrder(headerTable, detailTable, keyColumn) {
  const header = await query(
    `SELECT TOP 1 * FROM [${headerTable}] ORDER BY DocDate DESC, DocNo DESC`
  );
  if (!header.length) return { header: null, lines: [] };
  const key = header[0][keyColumn];
  const lines = await query(
    `SELECT TOP 40 * FROM [${detailTable}] WHERE ${keyColumn} = @key`,
    { key }
  );
  return { header: header[0], lines };
}

// Only the columns that are actually populated - an AutoCount document table
// has well over a hundred columns and most sit empty.
function usedColumns(row) {
  if (!row) return [];
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== "" && !(typeof v === "number" && v === 0))
    .map(([k, v]) => `${k} = ${v instanceof Date ? v.toISOString().slice(0, 19) : String(v).slice(0, 60)}`);
}

// Are the keys auto-generated, or must we allocate them? This decides the
// whole shape of the insert, and INFORMATION_SCHEMA does not say.
async function identityColumns(tables) {
  return query(
    `SELECT OBJECT_NAME(object_id) AS [table], name AS [column],
            seed_value AS seed, increment_value AS increment, last_value AS [last]
       FROM sys.identity_columns
      WHERE OBJECT_NAME(object_id) IN (${tables.map((_, i) => "@t" + i).join(",")})`,
    Object.fromEntries(tables.map((t, i) => ["t" + i, t]))
  );
}

// If the keys are not identities, AutoCount allocates them somewhere, and we
// must find where before writing a single row - picking our own key risks
// colliding with whatever AutoCount hands out next.
//
// No STRING_AGG here: that needs SQL Server 2017 and this instance is older.
async function serverVersion() {
  return query("SELECT @@VERSION AS version, SERVERPROPERTY('ProductVersion') AS product");
}

// Any column whose name suggests it holds "the next one to use".
async function numberingColumns() {
  return query(
    `SELECT TABLE_NAME AS [table], COLUMN_NAME AS [column], DATA_TYPE AS type
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE COLUMN_NAME LIKE '%Next%'
         OR COLUMN_NAME LIKE '%Running%'
         OR COLUMN_NAME LIKE '%LastUsed%'
         OR COLUMN_NAME LIKE '%CurrentNo%'
         OR COLUMN_NAME LIKE '%LastNumber%'
         OR COLUMN_NAME LIKE '%LastKey%'
      ORDER BY TABLE_NAME, COLUMN_NAME`
  );
}

// AutoCount may allocate keys through a stored procedure. If it does, calling
// that is far safer than inventing a number ourselves.
async function keyRoutines() {
  return query(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
       FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_NAME LIKE '%Key%'
         OR ROUTINE_NAME LIKE '%Number%'
         OR ROUTINE_NAME LIKE '%Seq%'
         OR ROUTINE_NAME LIKE '%DocNo%'
      ORDER BY ROUTINE_NAME`
  );
}

// The highest key in use ACROSS the document system, not just in SO. DocKey is
// one sequence for every document type, and SO has not been written to since
// March 2024 - so its own maximum says nothing about where the counter sits.
const DOC_TABLES = [
  "SO", "DO", "IV", "CS", "DN", "CN", "PO", "GR", "PI", "QT", "ADJ", "XS", "XP",
  "ARInvoice", "ARPayment", "ARCN", "ARDN", "APInvoice", "APPayment", "JE",
  "StockTake", "XFER", "ISS", "RCV",
];

async function globalMaxDocKey() {
  const parts = DOC_TABLES.map(
    (t) => `SELECT '${t}' AS [table], MAX(DocKey) AS maxKey FROM [${t}]`
  );
  const rows = await query(parts.join(" UNION ALL "));
  return rows.filter((r) => r.maxKey !== null).sort((a, b) => Number(b.maxKey) - Number(a.maxKey));
}

// What each document type was last used, so we can see what is actually in use
// today rather than assuming.
async function lastUsed() {
  const parts = DOC_TABLES.map(
    (t) => `SELECT '${t}' AS [table], MAX(DocDate) AS lastDate, COUNT(*) AS docs FROM [${t}]`
  );
  try {
    return await query(parts.join(" UNION ALL "));
  } catch (_) {
    return [];
  }
}

// Which other tables carry a DocKey - i.e. what else might a Sales Order touch.
async function docKeyTables() {
  return query(
    `SELECT DISTINCT TABLE_NAME AS [table]
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE COLUMN_NAME = 'DocKey'
      ORDER BY TABLE_NAME`
  );
}

// Every line of one order, so the SubTotal row and a parts row are both seen.
async function allLines(detailTable, keyColumn, key) {
  return query(`SELECT * FROM [${detailTable}] WHERE ${keyColumn} = @key ORDER BY Seq`, { key });
}

// ---- Finding the global DocKey counter ------------------------------------
// DocKey is one sequence across every document table (a Sales Order and the
// Delivery Order it became sit either side of the same run), so it cannot be
// allocated by looking at SO alone. AutoCount keeps the next value somewhere.
//
// Rather than guess at table names, look for the NUMBER. Whatever holds the
// next key must contain a value just above the highest key in use, so scan
// every numeric column of every small table for one in that range. A counter
// lives in a table with a handful of rows, never a document table.

async function smallTableNumericColumns(maxRows = 200) {
  return query(
    `SELECT t.name AS [table], c.name AS [column], SUM(p.rows) AS [rows]
       FROM sys.tables t
       JOIN sys.columns c ON c.object_id = t.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE ty.name IN ('bigint', 'int', 'numeric', 'decimal')
      GROUP BY t.name, c.name
     HAVING SUM(p.rows) BETWEEN 1 AND @maxRows
      ORDER BY t.name, c.name`,
    { maxRows }
  );
}

// Look for the counter by its value. Table and column names come from the
// catalogue, never from user input, and are bracket-quoted regardless.
async function findValueNear(candidates, low, high) {
  const hits = [];
  const chunkSize = 60;
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const parts = chunk.map((c) => {
      const t = String(c.table).replace(/[^A-Za-z0-9_]/g, "");
      const col = String(c.column).replace(/[^A-Za-z0-9_]/g, "");
      return `SELECT '${t}.${col}' AS spot, CAST(MAX([${col}]) AS bigint) AS val ` +
             `FROM [${t}] WHERE [${col}] BETWEEN ${low} AND ${high}`;
    });
    try {
      const rows = await query(parts.join(" UNION ALL "));
      for (const r of rows) if (r.val !== null) hits.push(r);
    } catch (_) { /* a column that will not cast is not the counter */ }
  }
  return hits;
}

// ---- Watching the counter move --------------------------------------------
// Far better than guessing at a value: take a reading of every small table
// before a Sales Order is created in AutoCount, and another afterwards.
// Whatever moved IS the counter. Nothing is inferred.
async function snapshot(maxRows = 2000) {
  const cols = await query(
    `SELECT t.name AS [table], c.name AS [column]
       FROM sys.tables t
       JOIN sys.columns c ON c.object_id = t.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE ty.name IN ('bigint', 'int', 'numeric', 'decimal', 'smallint')
      GROUP BY t.name, c.name
     HAVING SUM(p.rows) BETWEEN 1 AND @maxRows`,
    { maxRows }
  );

  const readings = {};
  const chunkSize = 50;
  for (let i = 0; i < cols.length; i += chunkSize) {
    const chunk = cols.slice(i, i + chunkSize);
    const parts = chunk.map((c) => {
      const t = String(c.table).replace(/[^A-Za-z0-9_]/g, "");
      const col = String(c.column).replace(/[^A-Za-z0-9_]/g, "");
      return `SELECT '${t}.${col}' AS spot, CAST(MAX([${col}]) AS bigint) AS val FROM [${t}]`;
    });
    try {
      for (const r of await query(parts.join(" UNION ALL "))) {
        if (r.val !== null) readings[r.spot] = String(r.val);
      }
    } catch (_) {
      // One unreadable column must not lose the other forty-nine.
      for (const c of chunk) {
        const t = String(c.table).replace(/[^A-Za-z0-9_]/g, "");
        const col = String(c.column).replace(/[^A-Za-z0-9_]/g, "");
        try {
          const one = await query(`SELECT CAST(MAX([${col}]) AS bigint) AS val FROM [${t}]`);
          if (one[0] && one[0].val !== null) readings[`${t}.${col}`] = String(one[0].val);
        } catch (_) { /* skip */ }
      }
    }
  }
  return readings;
}

module.exports = { findTables, columns, sampleOrder, usedColumns,
                   identityColumns, docKeyTables, allLines,
                   serverVersion, numberingColumns, keyRoutines, globalMaxDocKey, lastUsed,
                   smallTableNumericColumns, findValueNear, snapshot };
