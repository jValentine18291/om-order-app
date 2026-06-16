// data/sqliteRepo.js
// ============================================================================
// SQLite implementation of the data repository contract (see repository.contract.js).
// This is the Phase 1 / local data source. All SQL lives here — server.js no
// longer touches the database directly.
//
// When AutoCount arrives, create data/autocountRepo.js exporting the same four
// functions, and switch DATA_SOURCE in dataSource.js. Nothing else changes.
// ============================================================================

const db = require("../db");

// ---- SO number generation --------------------------------------------------
function nextSoNumber() {
  const tx = db.transaction(() => {
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'so_number'").run();
    const { value } = db.prepare("SELECT value FROM counters WHERE name = 'so_number'").get();
    const year = new Date().getFullYear();
    return `SO-${year}-${String(value).padStart(5, "0")}`;
  });
  return tx();
}

// ---- findItem: tolerant lookup ---------------------------------------------
// "SZEN 140051111", "SZEN140051111", and "140051111" all resolve to one item.
function findItem(code) {
  const raw = String(code || "").trim();
  if (!raw) return null;
  const norm = raw.replace(/\s+/g, "").toUpperCase();

  const item = db
    .prepare(
      `SELECT item_code, barcode, description, brand, uom, unit_price
         FROM items
        WHERE REPLACE(UPPER(item_code), ' ', '') = ?
           OR REPLACE(UPPER(barcode),   ' ', '') = ?
           OR REPLACE(UPPER(item_code), ' ', '') LIKE '%' || ?
        LIMIT 1`
    )
    .get(norm, norm, norm);

  return item || null;
}

// ---- listItems: full catalogue ---------------------------------------------
function listItems() {
  return db
    .prepare(
      `SELECT item_code, barcode, description, brand, uom, unit_price
         FROM items ORDER BY description`
    )
    .all();
}

// ---- createOrder -----------------------------------------------------------
function createOrder({ notes = "", lines } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    const e = new Error("Order must contain at least one line.");
    e.status = 400;
    throw e;
  }
  for (const l of lines) {
    if (!l.item_code || !Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0) {
      const e = new Error("Each line needs an item_code and quantity > 0.");
      e.status = 400;
      throw e;
    }
  }

  const soNumber = nextSoNumber();
  let totalQty = 0;
  let totalAmount = 0;

  const insertOrder = db.prepare(
    `INSERT INTO orders (so_number, status, notes, total_qty, total_amount)
     VALUES (?, 'SUBMITTED', ?, 0, 0)`
  );
  const insertLine = db.prepare(
    `INSERT INTO order_lines
       (order_id, item_code, description, uom, unit_price, quantity, line_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const updateOrder = db.prepare(
    `UPDATE orders SET total_qty = ?, total_amount = ? WHERE id = ?`
  );

  const tx = db.transaction(() => {
    const info = insertOrder.run(soNumber, notes);
    const orderId = info.lastInsertRowid;

    for (const l of lines) {
      const qty = Number(l.quantity);
      const price = Number(l.unit_price) || 0;
      const amount = qty * price;
      totalQty += qty;
      totalAmount += amount;
      insertLine.run(
        orderId,
        l.item_code,
        l.description || l.item_code,
        l.uom || "UNIT",
        price,
        qty,
        amount
      );
    }
    updateOrder.run(totalQty, totalAmount, orderId);
    return orderId;
  });

  const orderId = tx();
  return {
    id: orderId,
    so_number: soNumber,
    status: "SUBMITTED",
    total_qty: totalQty,
    total_amount: Number(totalAmount.toFixed(2)),
  };
}

// ---- getOrder --------------------------------------------------------------
function getOrder(soNumber) {
  const order = db.prepare("SELECT * FROM orders WHERE so_number = ?").get(soNumber);
  if (!order) return null;
  order.lines = db.prepare("SELECT * FROM order_lines WHERE order_id = ?").all(order.id);
  return order;
}

module.exports = { findItem, listItems, createOrder, getOrder };
