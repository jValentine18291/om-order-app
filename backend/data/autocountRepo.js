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

const { query, execute } = require("./autocountConnection");

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
  // Used by the Sales Order path: fills the Contractor price from what a
  // technician keyed on the slip, when AutoCount has no price for that part.
  //
  // The slip carries AutoCount's OWN item code, so resolving it is an exact
  // match on the full code and cannot land on the wrong variant the way a bare
  // diagram number can. Once resolved, the write is the same hardened one the
  // Parts Diagram uses, so this path also checks that a row actually changed
  // rather than assuming it did - it used to report "updated in AutoCount"
  // even when its own blank-price guard had blocked the write, and that log is
  // the only record there is.
  const norm = String(itemCode || "").replace(/\s+/g, "").toUpperCase();
  const rows = await query(
    `SELECT TOP 1 i.ItemCode FROM Item i
      WHERE REPLACE(UPPER(i.ItemCode), ' ', '') = @norm`,
    { norm }
  );
  if (!rows.length) {
    return { status: "skipped_not_found", item_code: itemCode, old_price: null, new_price: Number(newPrice) };
  }

  const r = await setMissingPrice(rows[0].ItemCode, "contractor", newPrice);
  const asSkip = {
    updated: "updated",
    already_priced: "skipped_has_price",
    no_uom_row: "skipped_no_uom_row",
    not_found: "skipped_not_found",
  };
  return {
    status: asSkip[r.status] || "skipped",
    item_code: r.item_code,
    old_price: r.old_price,
    new_price: r.new_price,
  };
}

// ============================================================================
// SET A MISSING PRICE (Parts Diagram -> Check Price -> Set price)
//
// This is a WRITE into the live accounting database, so it is deliberately
// narrow:
//
//   - Only fills a price that is currently blank or zero. It can never change
//     a price that already exists; the UPDATE re-checks that in its own WHERE
//     clause, so even a race with someone pricing the item in AutoCount at the
//     same moment loses safely rather than overwriting them.
//   - Takes the EXACT ItemCode that the price lookup already resolved, and
//     matches it exactly. getPartPrices has to search loosely (the IPL prints
//     "612912230" where AutoCount holds "SZEN 612912230C"), and a loose match
//     is fine for reading but completely unacceptable for writing - it could
//     price the wrong item. So the caller passes back the resolved code and
//     this never guesses.
//   - Updates exactly one column on exactly one row: the item's base-UOM row.
//   - Refuses to create an ItemUOM row that does not exist. That is a bigger
//     change than filling in a price and belongs in AutoCount.
//   - Reports rows-changed honestly instead of assuming success.
// ============================================================================

// The tier name arrives from the browser, so it must never reach the SQL text.
// It is looked up in this fixed table instead, and an unknown tier is rejected.
const PRICE_TIERS = {
  contractor: { column: "Price", label: "Contractor Price" },
  list: { column: "Price6", label: "List Price" },
};

// A fat-finger ceiling. A price is keyed by hand into an accounting system, so
// an extra digit is the realistic mistake; this stops the daft ones without
// getting in the way of a genuinely expensive part.
const MAX_PRICE = 100000;

async function setMissingPrice(exactItemCode, tier, newPrice) {
  const spec = PRICE_TIERS[String(tier || "").toLowerCase()];
  if (!spec) {
    const e = new Error("Unknown price type."); e.status = 400; throw e;
  }
  const code = String(exactItemCode || "").trim();
  if (!code) {
    const e = new Error("Missing item code."); e.status = 400; throw e;
  }
  const p = Number(newPrice);
  if (!Number.isFinite(p) || p <= 0) {
    const e = new Error("Enter a price greater than zero."); e.status = 400; throw e;
  }
  if (p > MAX_PRICE) {
    const e = new Error(`That price looks wrong (over ${MAX_PRICE}). Set it in AutoCount if it is correct.`);
    e.status = 400; throw e;
  }
  // Round to cents rather than trusting whatever the browser sent.
  const price = Math.round(p * 100) / 100;

  const rows = await query(
    `SELECT TOP 1 i.ItemCode, i.BaseUOM, u.UOM AS UomRow, u.${spec.column} AS CurrentPrice
       FROM Item i
       LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
      WHERE i.ItemCode = @code`,
    { code }
  );
  if (!rows.length) {
    return { status: "not_found", tier: spec.label, item_code: code, old_price: null, new_price: price };
  }
  const row = rows[0];
  const base = { tier: spec.label, item_code: row.ItemCode, new_price: price };

  if (row.UomRow === null || row.UomRow === undefined) {
    return { ...base, status: "no_uom_row", old_price: null };
  }
  const current = row.CurrentPrice === null || row.CurrentPrice === undefined ? 0 : Number(row.CurrentPrice);
  if (current > 0) {
    return { ...base, status: "already_priced", old_price: current };
  }

  const res = await execute(
    `UPDATE ItemUOM
        SET ${spec.column} = @price
      WHERE ItemCode = @code AND UOM = @uom
        AND (${spec.column} IS NULL OR ${spec.column} = 0)`,
    { price, code: row.ItemCode, uom: row.BaseUOM }
  );
  if (!res.rowsAffected) {
    // The guard in the WHERE clause held: someone priced it in between.
    return { ...base, status: "already_priced", old_price: null };
  }
  return { ...base, status: "updated", old_price: 0 };
}

// ============================================================================
// SHELF LOCATION WRITE-BACK
// ============================================================================
// The third thing this app writes into AutoCount, after prices and Sales
// Orders. Admin only: when a part moves shelf, whoever moved it can correct it
// from the phone in front of the bin instead of remembering to do it later at
// a desk, which is how a location goes stale.
//
// It differs from the price write in one important way: a price may only ever
// be filled in when blank, but a location is MEANT to be changed - that is the
// whole point. So the safety is not "refuse if occupied", it is:
//   - exact ItemCode only, never a loose match (see the IPL variant rule:
//     848BE058B2 and 848BE058B2R are different parts)
//   - one column, on the one base-UOM row, and rowsAffected is read not assumed
//   - the old value is read first and shown to the person for confirmation,
//     and both values go in the log
//   - length checked against the column's ACTUAL width, read from the server
//
// Writing here bypasses AutoCount's own audit trail, so backend/location-
// updates.log is the only record of who moved what. Do not delete it.

function locationWritebackEnabled() {
  // On unless deliberately switched off. The other two write-backs default off
  // because they touch money; a shelf label does not, and John asked for this
  // one to work on deployment.
  return String(process.env.AUTOCOUNT_LOCATION_WRITEBACK || "true").toLowerCase() === "true";
}

// How wide ItemUOM.Shelf actually is, asked once and remembered. Guessing a cap
// would either reject a legitimate location or let the driver raise "String or
// binary data would be truncated", which tells the person at the bin nothing.
let shelfWidth = null;
async function shelfMaxChars() {
  if (shelfWidth !== null) return shelfWidth;
  try {
    const rows = await query(
      `SELECT CHARACTER_MAXIMUM_LENGTH AS Len
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'ItemUOM' AND COLUMN_NAME = 'Shelf'`
    );
    const n = rows.length ? Number(rows[0].Len) : 0;
    // -1 means varchar(max); treat anything unreadable as a conservative 20.
    shelfWidth = n === -1 ? 255 : (Number.isFinite(n) && n > 0 ? n : 20);
  } catch (_) {
    shelfWidth = 20;
  }
  return shelfWidth;
}

async function setPartShelf(exactItemCode, newShelf) {
  const code = String(exactItemCode || "").trim();
  if (!code) { const e = new Error("Missing item code."); e.status = 400; throw e; }

  // Trimmed, and inner runs of whitespace collapsed: "A1  -  3" and "A1 - 3"
  // are the same shelf and should not read as two.
  const shelf = String(newShelf === undefined || newShelf === null ? "" : newShelf)
    .replace(/\s+/g, " ").trim();
  if (!shelf) {
    const e = new Error("Enter a location. To clear one, do it in AutoCount.");
    e.status = 400; throw e;
  }
  const cap = await shelfMaxChars();
  if (shelf.length > cap) {
    const e = new Error(`A location can be at most ${cap} characters in AutoCount.`);
    e.status = 400; throw e;
  }

  const rows = await query(
    `SELECT TOP 1 i.ItemCode, i.BaseUOM, u.UOM AS UomRow, u.Shelf AS CurrentShelf
       FROM Item i
       LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
      WHERE i.ItemCode = @code`,
    { code }
  );
  if (!rows.length) {
    return { status: "not_found", item_code: code, old_shelf: null, new_shelf: shelf };
  }
  const row = rows[0];
  const base = { item_code: row.ItemCode, new_shelf: shelf };
  if (row.UomRow === null || row.UomRow === undefined) {
    return { ...base, status: "no_uom_row", old_shelf: null };
  }
  const current = row.CurrentShelf === null || row.CurrentShelf === undefined
    ? "" : String(row.CurrentShelf).trim();
  if (current === shelf) {
    return { ...base, status: "unchanged", old_shelf: current };
  }

  const res = await execute(
    `UPDATE ItemUOM SET Shelf = @shelf WHERE ItemCode = @code AND UOM = @uom`,
    { shelf, code: row.ItemCode, uom: row.BaseUOM }
  );
  if (!res.rowsAffected) {
    return { ...base, status: "no_uom_row", old_shelf: current };
  }
  return { ...base, status: "updated", old_shelf: current };
}

module.exports.locationWritebackEnabled = locationWritebackEnabled;
module.exports.setPartShelf = setPartShelf;

module.exports.PRICE_TIERS = PRICE_TIERS;
module.exports.setMissingPrice = setMissingPrice;

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
// Confirmed against the live schema on 24 Aug 2026:
//
//   ItemUOM has Price, Price2 ... Price6 — there is NO Price1 column.
//   AutoCount's interface labels the base Price column as "Price 1", which is
//   why looking for a literal Price1 found nothing.
//
//   Contractor Price = ItemUOM.Price    (shown as "Price 1" in AutoCount)
//   List Price       = ItemUOM.Price6
//
// Corroborated by SZEN 612912230C: Price 12.80, Price6 17.00 — list above
// contractor, as it should be. The category-based ItemPrice table is empty for
// that item, so multi-pricing by customer category is not in use here.
//
// Note ItemUOM.Price is the same figure the app already bills parts at on a
// service slip, so a technician's parts and the Contractor Price agree.
async function getPartPrices(code) {
  // EXACT match, deliberately. This used to search loosely, because the IPL
  // prints "612912230" where AutoCount holds "SZEN 612912230C" and an exact
  // match found nothing. But a loose search cannot tell "SZEN 848BE058B2"
  // from "SZEN 848BE058B2R" - it just took whichever ranked first, so both
  // variants of a part showed the SAME price, and setting a price could write
  // it to the wrong item.
  //
  // Resolving the IPL number now happens in one place only: parts-search,
  // which returns every candidate so the user picks the variant they mean.
  // The caller passes that exact ItemCode here, so the price shown and the
  // price written always belong to the item the user actually chose.
  const itemCode = String(code || "").trim();
  if (!itemCode) return { error: "no-code" };

  const rows = await query(
    `SELECT TOP 1
            i.ItemCode,
            u.Price  AS ContractorPrice,
            u.Price6 AS ListPrice
       FROM Item i
       LEFT JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
      WHERE i.ItemCode = @itemCode`,
    { itemCode }
  );
  if (!rows.length) return { error: "not-found" };

  const r = rows[0];
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    item_code: r.ItemCode,
    contractor_price: num(r.ContractorPrice),
    list_price: num(r.ListPrice),
  };
}

module.exports.getPartPrices = getPartPrices;
