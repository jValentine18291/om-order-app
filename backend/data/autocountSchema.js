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

// If the keys are not identities, AutoCount allocates them somewhere. Look for
// any table that could hold a running number, by shape rather than by name.
async function numberingCandidates() {
  return query(
    `SELECT TOP 40 t.TABLE_NAME AS [table],
            STRING_AGG(CONVERT(nvarchar(max), c.COLUMN_NAME), ', ') AS cols
       FROM INFORMATION_SCHEMA.TABLES t
       JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_TYPE = 'BASE TABLE'
        AND t.TABLE_NAME IN (
              SELECT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS
               WHERE COLUMN_NAME IN ('NextNumber','RunningNumber','LastNumber','NextDocNo','DocNoFormat','NextKey','LastKey')
            )
      GROUP BY t.TABLE_NAME`
  );
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

module.exports = { findTables, columns, sampleOrder, usedColumns,
                   identityColumns, numberingCandidates, docKeyTables, allLines };
