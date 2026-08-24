// data/autocountRepo.js
// ============================================================================
// AutoCount data source — READ-ONLY items, tailored to the AED_OUTBOARD schema
// (confirmed by inspect-autocount.js on 3 Jul 2026):
//   - Item     : ItemCode, Description, Desc2, ItemBrand, BaseUOM, IsActive
//   - ItemUOM  : ItemCode, UOM, Price, BarCode   (price lives here, per UOM)
//               Price1 = Contractor Price, Price6 = List Price
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

// ============================================================================
// DEBTOR (customer) search — read-only, for Company Name suggestions in the
// New Service form. Standard AutoCount layout: Debtor(AccNo, CompanyName).
// CONFIRM on first live test; adjust column names if the test errors.
// ============================================================================
async function searchDebtors(q, limit = 12) {
  const term = String(q || "").trim();
  if (!term) return [];
  const cap = Math.max(1, Math.min(20, Number(limit) || 12));
  const rows = await query(
    `SELECT TOP ${cap} AccNo, CompanyName
       FROM Debtor
      WHERE CompanyName LIKE '%' + @term + '%'
      ORDER BY CompanyName`,
    { term }
  );
  return rows.map((r) => ({ acc_no: r.AccNo, company: r.CompanyName }));
}
module.exports.searchDebtors = searchDebtors;

// ============================================================================
// FIND PART — read-only part search + stock info for the Find Part screen.
// Balance = SUM(StockDTL.Qty) per item (confirmed against live data: opening
// balance + transaction rows; this is how AutoCount derives stock balance).
// Shelf comes from ItemUOM (base-UOM row).
// ============================================================================

// Search by description (or code) for the suggestion list.
// The search is split into words and EVERY word must match somewhere in
// Description, Desc2 (AutoCount's 2nd description line, typically the machine
// model e.g. "BK3410"), or the item code. So "BK3410 Recoil" finds an item
// with Description "Recoil Assy 2-58" and Desc2 "BK3410".
async function searchParts(q, limit = 15) {
  const term = String(q || "").trim();
  if (!term) return [];
  const cap = Math.max(1, Math.min(20, Number(limit) || 15));

  const words = term.split(/\s+/).slice(0, 6); // sane cap on word count
  const params = {};
  const conditions = words.map((w, idx) => {
    params[`w${idx}`] = w;
    params[`n${idx}`] = w.replace(/\s+/g, "").toUpperCase();
    return `( i.Description LIKE '%' + @w${idx} + '%'
           OR i.Desc2 LIKE '%' + @w${idx} + '%'
           OR REPLACE(UPPER(i.ItemCode), ' ', '') LIKE '%' + @n${idx} + '%' )`;
  });

  const rows = await query(
    `SELECT TOP ${cap}
            i.ItemCode,
            COALESCE(NULLIF(i.Description, ''), NULLIF(i.Desc2, ''), i.ItemCode) AS Descr,
            NULLIF(i.Desc2, '') AS Desc2
       FROM Item i
      WHERE i.IsActive = 'T'
        AND ${conditions.join("\n        AND ")}
      ORDER BY Descr`,
    params
  );
  return rows.map((r) => ({
    item_code: r.ItemCode,
    description: r.Descr,
    desc2: r.Desc2 && r.Desc2 !== r.Descr ? r.Desc2 : "",
  }));
}

// Full stock card for one part: code, description, shelf, balance qty.
async function getPartStock(code) {
  const norm = String(code || "").replace(/\s+/g, "").toUpperCase();
  if (!norm) return null;
  const rows = await query(
    `SELECT TOP 1
            i.ItemCode,
            COALESCE(NULLIF(i.Description, ''), NULLIF(i.Desc2, ''), i.ItemCode) AS Descr,
            NULLIF(i.Desc2, '') AS Desc2,
            i.BaseUOM,
            u.Shelf,
            (SELECT SUM(s.Qty) FROM StockDTL s
              WHERE REPLACE(UPPER(s.ItemCode), ' ', '') = REPLACE(UPPER(i.ItemCode), ' ', '')
            ) AS BalQty
       FROM Item i
       LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
      WHERE REPLACE(UPPER(i.ItemCode), ' ', '') = @norm`,
    { norm }
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    item_code: r.ItemCode,
    description: r.Descr,
    desc2: r.Desc2 && r.Desc2 !== r.Descr ? r.Desc2 : "",
    shelf: r.Shelf || "",
    uom: r.BaseUOM || "",
    bal_qty: r.BalQty === null || r.BalQty === undefined ? 0 : Number(r.BalQty),
  };
}

module.exports.searchParts = searchParts;
module.exports.getPartStock = getPartStock;

// ---- Part prices -----------------------------------------------------------
// AutoCount carries the tiers on the item's base-UOM row:
//   Price1 = Contractor Price
//   Price6 = List Price
//
// The exact column names are confirmed at runtime rather than assumed, because
// getting a price column wrong means quoting a customer the wrong figure. If
// the columns are not there, this returns null and the app says prices are
// unavailable — it never falls back to a different column.
let priceColumns = null;

async function detectPriceColumns() {
  if (priceColumns) return priceColumns;
  const rows = await query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'ItemUOM' AND COLUMN_NAME IN ('Price1', 'Price6')`
  );
  const names = rows.map((r) => r.COLUMN_NAME);
  priceColumns = {
    contractor: names.includes("Price1") ? "Price1" : null,
    list: names.includes("Price6") ? "Price6" : null,
  };
  if (!priceColumns.contractor || !priceColumns.list) {
    console.warn(
      "[autocount] ItemUOM is missing Price1/Price6 — part prices will read as unavailable. Run inspect-prices.js to find where the tiers live."
    );
  }
  return priceColumns;
}

async function getPartPrices(code) {
  const norm = String(code || "").replace(/\s+/g, "").toUpperCase();
  if (!norm) return null;

  const cols = await detectPriceColumns();
  if (!cols.contractor || !cols.list) return null;

  const rows = await query(
    `SELECT TOP 1
            i.ItemCode,
            u.[${cols.contractor}] AS ContractorPrice,
            u.[${cols.list}]       AS ListPrice
       FROM Item i
       LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
      WHERE REPLACE(UPPER(i.ItemCode), ' ', '') = @norm`,
    { norm }
  );
  if (!rows.length) return null;

  const r = rows[0];
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    item_code: r.ItemCode,
    contractor_price: num(r.ContractorPrice),
    list_price: num(r.ListPrice),
  };
}

module.exports.getPartPrices = getPartPrices;
