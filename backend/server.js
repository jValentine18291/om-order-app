// server.js — Express API + static frontend host
// Phase 1: mock lookups, local SQLite storage, mock SO generation.

const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the PWA frontend from ../frontend
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---- Helpers ----
function nextSoNumber() {
    const tx = db.transaction(() => {
          db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'so_number'").run();
          const { value } = db.prepare("SELECT value FROM counters WHERE name = 'so_number'").get();
          const year = new Date().getFullYear();
          return `SO-${year}-${String(value).padStart(5, "0")}`;
    });
    return tx();
}

// ---- API: item lookup ----
// Tolerant matching: a scanned "SZEN 140051111" also matches "SZEN140051111" or "140051111".
app.get("/api/items/:code", (req, res) => {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "Missing code" });

          const norm = code.replace(/\s+/g, "").toUpperCase();

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

          if (!item) {
                return res.status(404).json({ error: `No item found for "${code}"` });
          }
    res.json(item);
});

// GET /api/items -> full catalogue
app.get("/api/items", (_req, res) => {
    const rows = db
      .prepare(
              `SELECT item_code, barcode, description, brand, uom, unit_price
                     FROM items ORDER BY description`
            )
      .all();
    res.json(rows);
});

// ---- API: submit order ----
app.post("/api/orders", (req, res) => {
    const { notes = "", lines } = req.body || {};

           if (!Array.isArray(lines) || lines.length === 0) {
                 return res.status(400).json({ error: "Order must contain at least one line." });
           }

           for (const l of lines) {
                 if (!l.item_code || !Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0) {
                         return res.status(400).json({ error: "Each line needs an item_code and quantity > 0." });
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
    res.status(201).json({
          id: orderId,
          so_number: soNumber,
          status: "SUBMITTED",
          total_qty: totalQty,
          total_amount: Number(totalAmount.toFixed(2)),
    });
});

// GET /api/orders/:so -> retrieve a submitted order
app.get("/api/orders/:so", (req, res) => {
    const order = db
      .prepare("SELECT * FROM orders WHERE so_number = ?")
      .get(req.params.so);
    if (!order) return res.status(404).json({ error: "Order not found" });

          order.lines = db
      .prepare("SELECT * FROM order_lines WHERE order_id = ?")
      .all(order.id);
    res.json(order);
});

app.listen(PORT, () => {
    console.log(`OM Order App (Phase 1) running at http://localhost:${PORT}`);
});
