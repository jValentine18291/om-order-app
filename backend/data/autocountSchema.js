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

module.exports = { findTables, columns, sampleOrder, usedColumns };
