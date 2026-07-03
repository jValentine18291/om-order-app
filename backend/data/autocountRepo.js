// data/autocountRepo.js
// ============================================================================
// AutoCount data source — implements the repository contract for ITEMS
// (read-only). ORDER creation is deliberately NOT implemented: writing sales
// orders into AutoCount must go through the official AutoCount API/SDK to keep
// accounting data valid. Until then, order functions throw, and dataSource.js
// keeps orders + service slips pointed at SQLite.
//
// ⚠️ The exact table/column names below are AutoCount's TYPICAL layout and MUST
// be confirmed against YOUR database using inspect-autocount.js. Lines marked
// CONFIRM are the ones to verify/adjust once the inspection output is in hand.
// ============================================================================

const { query } = require("./autocountConnection");

// ---- Map an AutoCount item row to the app's item shape ----------------------
// CONFIRM: adjust the source column names on the right to match your schema.
function mapItem(row) {
  if (!row) return null;
  return {
    item_code:   row.ItemCode,                            // CONFIRM
    barcode:     row.Barcode || row.ItemCode,             // CONFIRM (may be a separate table)
    description: row.Description || row.ItemCode,         // CONFIRM
    brand:       row.Brand || "",                         // CONFIRM (often not a direct column)
    uom:         row.BaseUOM || row.UOM || "UNIT",        // CONFIRM
    unit_price:  Number(row.Price ?? row.UnitPrice ?? 0), // CONFIRM (price often in Item or ItemUOM)
  };
}

// ---- findItem: tolerant lookup ----------------------------------------------
// CONFIRM: table name "Item" and column "ItemCode". Tolerant matching strips
// spaces and compares case-insensitively, mirroring the SQLite behaviour.
async function findItem(code) {
  const raw = String(code || "").trim();
  if (!raw) return null;
  const norm = raw.replace(/\s+/g, "").toUpperCase();

  const rows = await query(
    `SELECT TOP 1 *
       FROM Item                                            -- CONFIRM table name
      WHERE REPLACE(UPPER(ItemCode), ' ', '') = @norm       -- CONFIRM column
         OR REPLACE(UPPER(ItemCode), ' ', '') LIKE '%' + @norm`,
    { norm }
  );
  return rows.length ? mapItem(rows[0]) : null;
}

// ---- listItems: full catalogue ----------------------------------------------
async function listItems() {
  const rows = await query(
    `SELECT * FROM Item ORDER BY Description`               // CONFIRM table/columns
  );
  return rows.map(mapItem);
}

// ---- Orders / slips: NOT implemented for AutoCount ---------------------------
// Writing must use the AutoCount API/SDK to stay valid. These throw so any
// accidental routing here fails loudly instead of corrupting accounting data.
function notImplemented() {
  const e = new Error(
    "AutoCount write operations are not implemented (requires the AutoCount API/SDK). " +
    "Keep orders and service slips on the SQLite source."
  );
  e.status = 501;
  return e;
}
async function createOrder() { throw notImplemented(); }
async function getOrder() { throw notImplemented(); }

// Service-slip operations are an app concept, not an AutoCount one — they stay
// in SQLite regardless. Any call landing here is a wiring mistake.
const slips = new Proxy({}, {
  get() { return () => { throw notImplemented(); }; },
});

module.exports = { findItem, listItems, createOrder, getOrder, slips };
