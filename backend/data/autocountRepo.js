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

// ============================================================================
// PRICE WRITE-BACK (the ONE deliberate write this repo performs).
//
// Fills in MISSING prices only: when staff key a price into the app for a part
// whose AutoCount price is 0/NULL, that price is written to the item's
// base-UOM row in ItemUOM at Sales Order creation.
//
// Safeguards:
//   - Only runs when AUTOCOUNT_PRICE_WRITEBACK=true (explicit opt-in switch)
//   - NEVER overwrites an existing non-zero AutoCount price (re-checked at
//     write time, inside the UPDATE's WHERE clause too)
//   - Updates exactly one row: the item's base-UOM price
//   - Every attempt (updated / skipped / failed) is logged by the caller
// ============================================================================

function writebackEnabled() {
  return String(process.env.AUTOCOUNT_PRICE_WRITEBACK || "false").toLowerCase() === "true";
}

// Update the base-UOM price for itemCode IF its current price is 0/NULL.
// Returns { status: "updated" | "skipped_has_price" | "skipped_not_found",
//           item_code, old_price, new_price }
async function updateItemPriceIfMissing(itemCode, newPrice) {
  const p = Number(newPrice);
  if (!Number.isFinite(p) || p <= 0) {
    const e = new Error("Invalid price for write-back."); e.status = 400; throw e;
  }
  const norm = String(itemCode || "").replace(/\s+/g, "").toUpperCase();

  // Resolve the exact item + base UOM + current price.
  const rows = await query(
    `SELECT TOP 1 i.ItemCode, i.BaseUOM, u.Price
       FROM Item i
       LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
      WHERE REPLACE(UPPER(i.ItemCode), ' ', '') = @norm`,
    { norm }
  );
  if (!rows.length) {
    return { status: "skipped_not_found", item_code: itemCode, old_price: null, new_price: p };
  }
  const row = rows[0];
  const current = Number(row.Price ?? 0);
  if (current > 0) {
    return { status: "skipped_has_price", item_code: row.ItemCode, old_price: current, new_price: p };
  }

  // Belt-and-braces: the WHERE clause re-checks the price is still 0/NULL, so
  // even a race with someone setting the price in AutoCount cannot overwrite.
  await query(
    `UPDATE ItemUOM
        SET Price = @p
      WHERE ItemCode = @code AND UOM = @uom
        AND (Price IS NULL OR Price = 0)`,
    { p, code: row.ItemCode, uom: row.BaseUOM }
  );
  return { status: "updated", item_code: row.ItemCode, old_price: current, new_price: p };
}

module.exports.writebackEnabled = writebackEnabled;
module.exports.updateItemPriceIfMissing = updateItemPriceIfMissing;
