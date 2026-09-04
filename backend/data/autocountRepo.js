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

// The machines themselves, not their parts. Machine units are the U-prefixed
// item codes - UHUQ, UZEN, UPUL and so on - which is what separates a unit
// from the thousands of spares that would otherwise drown the list.
//
// Same word-by-word matching as searchParts: every word typed has to appear
// somewhere, so "husq 525" finds the 525 Husqvarnas without the order of the
// words mattering.
async function searchMachines(q, limit = 15) {
  const term = String(q || "").trim();
  if (!term) return [];
  const cap = Math.max(1, Math.min(20, Number(limit) || 15));

  const words = term.split(/\s+/).slice(0, 6);
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
        AND UPPER(i.ItemCode) LIKE 'U%'
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
module.exports.searchMachines = searchMachines;

// What is on a shelf. The shelf lives on the item's BASE-UOM row, which is the
// same row setPartShelf writes to - ask any other row and the answer would be
// blank for most items.
//
// Matched as a PREFIX, not an exact string: typing "R4" should show the whole
// of rack R4 rather than nothing, which is what you want when you are standing
// in front of it. Spaces are stripped from both sides of the comparison for
// the same reason setPartShelf collapses them - "R4 E1" and "R4E1" are one
// place, however it was typed in.
//
// Returns the total as well as the page, because "50 parts" and "50 of 300"
// mean very different things to someone checking a shelf against a list.
async function partsByShelf(shelf, limit = 100) {
  const norm = String(shelf || "").replace(/\s+/g, "").toUpperCase();
  if (!norm) return { total: 0, results: [] };
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));

  const where =
    `WHERE i.IsActive = 'T'
       AND u.Shelf IS NOT NULL
       AND REPLACE(UPPER(u.Shelf), ' ', '') LIKE @norm + '%'`;
  const from =
    `FROM Item i
     INNER JOIN ItemUOM u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM`;

  const counted = await query(`SELECT COUNT(*) AS n ${from} ${where}`, { norm });
  const total = counted.length ? Number(counted[0].n) : 0;

  // The balance is matched on the item code EXACTLY, not normalized. The same
  // rule getStockBalances follows and for the same reason: these codes come
  // straight out of Item rather than from someone typing, so the comparison is
  // indexable. Normalizing here - as getPartStock has to, for a typed code -
  // would turn one query into a full scan of the stock-movement table for
  // every row on the shelf.
  const rows = await query(
    `SELECT TOP ${cap}
            i.ItemCode,
            COALESCE(NULLIF(i.Description, ''), NULLIF(i.Desc2, ''), i.ItemCode) AS Descr,
            u.Shelf,
            i.BaseUOM,
            (SELECT SUM(s.Qty) FROM StockDTL s WHERE s.ItemCode = i.ItemCode) AS BalQty
       ${from}
       ${where}
      ORDER BY u.Shelf, Descr`,
    { norm }
  );
  return {
    total,
    results: rows.map((r) => ({
      item_code: r.ItemCode,
      description: r.Descr,
      shelf: r.Shelf || "",
      uom: r.BaseUOM || "",
      // No stock movements at all reads as zero, which is what it means on a
      // shelf: nothing there.
      bal_qty: r.BalQty === null || r.BalQty === undefined ? 0 : Number(r.BalQty),
    })),
  };
}
module.exports.partsByShelf = partsByShelf;

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

// Stock balances for a LIST of parts in one round trip, for the Orders list.
// getPartStock exists for one part typed by a person, so it matches the code
// case-insensitively with spaces stripped - which SQL Server cannot index, and
// costs a full scan of the stock-movement table. Fine once; ruinous in a loop.
//
// Here the codes were stored by the app AND CAME FROM AUTOCOUNT in the first
// place (the search resolved them before the request was saved), so they are
// matched exactly and the whole list is one indexed query.
async function getStockBalances(codes) {
  const list = [...new Set((codes || []).map((c) => String(c || "").trim()).filter(Boolean))];
  const out = new Map();
  // Chunked well under SQL Server's parameter limit; one chunk in practice.
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const params = {};
    chunk.forEach((c, j) => { params[`c${j}`] = c; });
    const rows = await query(
      `SELECT i.ItemCode,
              COALESCE(NULLIF(i.Description, ''), NULLIF(i.Desc2, ''), i.ItemCode) AS Descr,
              (SELECT SUM(s.Qty) FROM StockDTL s WHERE s.ItemCode = i.ItemCode) AS BalQty
         FROM Item i
        WHERE i.ItemCode IN (${chunk.map((_, j) => `@c${j}`).join(",")})`,
      params
    );
    for (const r of rows) {
      out.set(r.ItemCode, {
        description: r.Descr,
        bal_qty: r.BalQty === null || r.BalQty === undefined ? 0 : Number(r.BalQty),
      });
    }
  }
  return out;
}
// ---- What is already on order from a supplier ------------------------------
// "Has this been ordered already?" - asked at the moment someone is about to
// request more. The answer lives in AutoCount's Purchase Orders, which this
// app had never read before, so NOTHING about their shape is assumed: the
// tables and columns are looked up in the catalog once and the query is built
// from what is actually there.
//
// If the shape is not what we expect, this returns null and the app shows
// nothing rather than a number that might be wrong - a wrong "already on
// order" is worse than no answer, because it stops a real order being placed.
// backend/inspect-po.js prints what is there, for when that happens.
let poShape;   // undefined = not looked up yet, null = unusable

async function purchaseOrderShape() {
  if (poShape !== undefined) return poShape;
  try {
    const cols = await query(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME IN ('PO', 'PODTL')`
    );
    const of = (t) => new Set(
      cols.filter((c) => String(c.TABLE_NAME).toUpperCase() === t)
          .map((c) => String(c.COLUMN_NAME))
    );
    const master = of("PO"), detail = of("PODTL");
    const has = (set, name) => [...set].find((c) => c.toLowerCase() === name.toLowerCase());

    const dtlItem = has(detail, "ItemCode");
    const dtlDoc = has(detail, "DocKey");
    const dtlQty = has(detail, "Qty");
    const mDoc = has(master, "DocKey");
    const mNo = has(master, "DocNo");
    if (!dtlItem || !dtlDoc || !dtlQty || !mDoc || !mNo) { poShape = null; return poShape; }

    // Outstanding, in order of preference. AutoCount spells the transferred
    // column both ways depending on version, hence both spellings.
    const outstanding = has(detail, "OutstandingQty");
    const transferred = has(detail, "TransferedQty") || has(detail, "TransferredQty");
    poShape = {
      dtlItem, dtlDoc, dtlQty, mDoc, mNo,
      outstanding, transferred,
      cancelled: has(master, "Cancelled"),
      docDate: has(master, "DocDate"),
    };
  } catch (e) {
    console.error("[purchase orders] could not read the schema:", e.message);
    poShape = null;
  }
  return poShape;
}

// Outstanding quantity per item code, plus the PO numbers it sits on.
// Returns a Map, or null when Purchase Orders cannot be read.
async function getOnOrder(codes) {
  const list = [...new Set((codes || []).map((c) => String(c || "").trim()).filter(Boolean))];
  if (!list.length) return new Map();
  const shape = await purchaseOrderShape();
  if (!shape) return null;

  // What is still expected: an explicit outstanding column if the database has
  // one, otherwise ordered minus already transferred in, otherwise the ordered
  // quantity itself.
  const qtyExpr = shape.outstanding
    ? `d.[${shape.outstanding}]`
    : shape.transferred
      ? `(d.[${shape.dtlQty}] - ISNULL(d.[${shape.transferred}], 0))`
      : `d.[${shape.dtlQty}]`;
  const notCancelled = shape.cancelled ? `AND m.[${shape.cancelled}] = 'F'` : "";

  const out = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const params = {};
    chunk.forEach((c, j) => { params[`c${j}`] = c; });
    const rows = await query(
      `SELECT d.[${shape.dtlItem}] AS ItemCode,
              m.[${shape.mNo}]     AS DocNo,
              ${shape.docDate ? `m.[${shape.docDate}]` : "NULL"} AS DocDate,
              SUM(${qtyExpr})      AS OnOrder
         FROM PODtl d
         JOIN PO m ON m.[${shape.mDoc}] = d.[${shape.dtlDoc}]
        WHERE d.[${shape.dtlItem}] IN (${chunk.map((_, j) => `@c${j}`).join(",")})
          ${notCancelled}
        GROUP BY d.[${shape.dtlItem}], m.[${shape.mNo}]${shape.docDate ? `, m.[${shape.docDate}]` : ""}
       HAVING SUM(${qtyExpr}) > 0`,
      params
    );
    for (const r of rows) {
      const key = String(r.ItemCode).trim();
      if (!out.has(key)) out.set(key, { qty: 0, orders: [] });
      const entry = out.get(key);
      entry.qty += Number(r.OnOrder) || 0;
      entry.orders.push({
        doc_no: r.DocNo,
        date: r.DocDate ? String(r.DocDate).slice(0, 10) : "",
        qty: Number(r.OnOrder) || 0,
      });
    }
  }
  return out;
}

module.exports.getOnOrder = getOnOrder;
module.exports.purchaseOrderShape = purchaseOrderShape;

module.exports.getStockBalances = getStockBalances;

// ---- Every part that fits one machine ---------------------------------------
// The machines a part fits are kept on the item's SECOND description line.
// A survey of the live catalogue settled how to read it: 5,722 of 7,536 active
// items have one, they average 8 characters, 96% contain a digit, and 873
// distinct values are shared across those parts - so it is a real vocabulary of
// model codes, not free text. Only 17% carry a comma, meaning most parts list
// exactly one machine and the rest are comma-separated.
//
// Matching is done on whole entries rather than a substring, because "365"
// appearing inside "3650" is a different machine. SQL narrows the rows and the
// exact token check happens here, which keeps the query simple and the
// matching honest.
const modelKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Does this item's second line name that machine? Exported so the app, the
// route and the tests all ask the same question of the same code, rather than
// each carrying its own copy that can drift.
function fitsModel(desc2, model) {
  const wanted = modelKey(model);
  if (!wanted) return false;          // "everything" is not a machine
  return String(desc2 || "").split(",").some((entry) => modelKey(entry) === wanted);
}

async function partsForModel(model, limit = 200) {
  const wanted = modelKey(model);
  if (!wanted) return { model: "", total: 0, results: [], truncated: false };
  const cap = Math.max(1, Math.min(500, Number(limit) || 200));

  const rows = await query(
    `SELECT i.ItemCode,
            COALESCE(NULLIF(i.Description, ''), NULLIF(i.Desc2, ''), i.ItemCode) AS Descr,
            NULLIF(i.Desc2, '') AS Desc2
       FROM Item i
      WHERE i.IsActive = 'T'
        AND i.Desc2 LIKE '%' + @m + '%'
      ORDER BY i.ItemCode`,
    { m: String(model).trim() }
  );

  // The row matched somewhere in the line; keep it only if the machine is one
  // of the entries, so a part for "3650" is not returned as fitting a "365".
  const exact = rows.filter((r) => fitsModel(r.Desc2, model));

  return {
    model: String(model).trim(),
    total: exact.length,
    truncated: exact.length > cap,
    results: exact.slice(0, cap).map((r) => ({
      item_code: r.ItemCode,
      description: r.Descr,
      desc2: r.Desc2 && r.Desc2 !== r.Descr ? r.Desc2 : "",
    })),
  };
}

module.exports.partsForModel = partsForModel;
module.exports.modelKey = modelKey;
module.exports.fitsModel = fitsModel;
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
