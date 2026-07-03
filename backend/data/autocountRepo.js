// data/autocountRepo.js
// ============================================================================
// AutoCount data source — READ-ONLY items, tailored to the AED_OUTBOARD schema
// (confirmed by inspect-autocount.js on 3 Jul 2026):
//   - Item     : ItemCode, Description, Desc2, ItemBrand, BaseUOM, IsActive
//   - ItemUOM  : ItemCode, UOM, Price, BarCode   (price lives here, per UOM)
//
// Lookup matches the scanned/typed code against BOTH Item.ItemCode and
// ItemUOM.BarCode (spaces stripped, case-insensitive), preferring the base
// UOM's price row and active items.
//
// ORDER/SLIP writes are deliberately NOT implemented — those need the official
// AutoCount API and stay on SQLite.
// ============================================================================

const { query } = require("./autocountConnection");

function mapItem(row) {
  if (!row) return null;
  const desc = row.Description || row.Desc2 || row.ItemCode;
  return {
    item_code:   row.ItemCode,
    barcode:     row.BarCode || row.ItemCode,
    description: desc,
    brand:       row.ItemBrand || "",
    uom:         row.UOM || row.BaseUOM || "UNIT",
    unit_price:  Number(row.Price ?? 0),
  };
}

// Tolerant lookup: exact normalized match on ItemCode or BarCode first;
// if nothing, fall back to a suffix match on ItemCode (mirrors SQLite repo).
async function findItem(code) {
  const raw = String(code || "").trim();
  if (!raw) return null;
  const norm = raw.replace(/\s+/g, "").toUpperCase();

  const baseSelect = `
    SELECT TOP 1
           i.ItemCode, i.Description, i.Desc2, i.ItemBrand, i.BaseUOM,
           u.UOM, u.Price, u.BarCode
      FROM Item i
      LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode`;

  // Prefer: active items first, then the base-UOM price row.
  const preference = `
     ORDER BY CASE WHEN i.IsActive = 'T' THEN 0 ELSE 1 END,
              CASE WHEN u.UOM = i.BaseUOM THEN 0 ELSE 1 END`;

  // 1) Exact match on item code or barcode (normalized).
  let rows = await query(
    baseSelect + `
     WHERE REPLACE(UPPER(i.ItemCode), ' ', '') = @norm
        OR REPLACE(UPPER(ISNULL(u.BarCode, '')), ' ', '') = @norm` + preference,
    { norm }
  );
  if (rows.length) return mapItem(rows[0]);

  // 2) Fallback: code ends with the scanned value (helps prefixed barcodes).
  rows = await query(
    baseSelect + `
     WHERE REPLACE(UPPER(i.ItemCode), ' ', '') LIKE '%' + @norm` + preference,
    { norm }
  );
  return rows.length ? mapItem(rows[0]) : null;
}

// Full catalogue: active items with their base-UOM price.
async function listItems() {
  const rows = await query(`
    SELECT i.ItemCode, i.Description, i.Desc2, i.ItemBrand, i.BaseUOM,
           u.UOM, u.Price, u.BarCode
      FROM Item i
      LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
     WHERE i.IsActive = 'T'
     ORDER BY i.ItemCode`);
  return rows.map(mapItem);
}

// ---- Writes: NOT implemented (require the AutoCount API) --------------------
function notImplemented() {
  const e = new Error(
    "AutoCount write operations are not implemented (requires the AutoCount API/SDK). " +
    "Orders and service slips stay on the SQLite source."
  );
  e.status = 501;
  return e;
}
async function createOrder() { throw notImplemented(); }
async function getOrder() { throw notImplemented(); }
const slips = new Proxy({}, {
  get() { return () => { throw notImplemented(); }; },
});

module.exports = { findItem, listItems, createOrder, getOrder, slips };
