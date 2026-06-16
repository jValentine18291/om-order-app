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

// ============================================================================
// SERVICE SLIP OPERATIONS
// ============================================================================
function nextSlipNumber() {
  const tx = db.transaction(() => {
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'slip_number'").run();
    const { value } = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get();
    return String(value).padStart(5, "0");
  });
  return tx();
}

// Create a new service slip with its machines. Returns the created slip (with machines).
function createSlip({ company, contact_name = "", contact_number = "", notes = "", machines = [] } = {}) {
  if (!company || !String(company).trim()) {
    const e = new Error("Company is required to register a service slip.");
    e.status = 400; throw e;
  }
  const machineList = (Array.isArray(machines) ? machines : [])
    .map((m) => String(m || "").trim())
    .filter(Boolean);
  if (machineList.length === 0) {
    const e = new Error("At least one machine is required.");
    e.status = 400; throw e;
  }

  const insertSlip = db.prepare(
    `INSERT INTO service_slips (slip_number, company, contact_name, contact_number, notes, status)
     VALUES (?, ?, ?, ?, ?, 'OPEN')`
  );
  const insertMachine = db.prepare(
    "INSERT INTO slip_machines (slip_id, machine_desc) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    // Inline the counter bump here (calling nextSlipNumber() would open a
    // nested transaction, which SQLite forbids).
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'slip_number'").run();
    const { value } = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get();
    const slipNumber = String(value).padStart(5, "0");
    const info = insertSlip.run(slipNumber, String(company).trim(), contact_name, contact_number, notes);
    const slipId = info.lastInsertRowid;
    for (const m of machineList) insertMachine.run(slipId, m);
    return slipNumber;
  });

  const slipNumber = tx();
  return getSlip(slipNumber);
}

// List slips filtered by status group. 'active' = OPEN + CALL_CUSTOMER.
function listSlips(statusFilter = "active") {
  let rows;
  if (statusFilter === "open") {
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'OPEN' ORDER BY slip_number").all();
  } else if (statusFilter === "call_customer") {
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'CALL_CUSTOMER' ORDER BY slip_number").all();
  } else if (statusFilter === "closed") {
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'CLOSED' ORDER BY slip_number DESC").all();
  } else if (statusFilter === "all") {
    rows = db.prepare("SELECT * FROM service_slips ORDER BY slip_number DESC").all();
  } else {
    // 'active': anything not yet closed
    rows = db.prepare("SELECT * FROM service_slips WHERE status != 'CLOSED' ORDER BY slip_number").all();
  }
  // Attach machine list (lightweight — descriptions only) for dropdown display.
  const getMachines = db.prepare("SELECT id, machine_desc FROM slip_machines WHERE slip_id = ?");
  for (const r of rows) r.machines = getMachines.all(r.id);
  return rows;
}

// Full slip detail: slip + machines, and each machine's scanned parts.
function getSlip(slipNumber) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) return null;
  const machines = db.prepare("SELECT * FROM slip_machines WHERE slip_id = ?").all(slip.id);
  const getParts = db.prepare("SELECT * FROM machine_parts WHERE machine_id = ? ORDER BY id");
  for (const m of machines) m.parts = getParts.all(m.id);
  slip.machines = machines;
  return slip;
}

// Add a scanned part to a specific machine (or bump qty if same part+technician).
function addPartToMachine(machineId, { item_code, description, uom = "UNIT", unit_price = 0, quantity = 1, technician = "" } = {}) {
  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ?").get(machineId);
  if (!machine) { const e = new Error("Machine not found on any slip."); e.status = 404; throw e; }
  if (!item_code) { const e = new Error("item_code is required."); e.status = 400; throw e; }

  // If the same part was already scanned for this machine by the same tech, bump qty.
  const existing = db.prepare(
    "SELECT * FROM machine_parts WHERE machine_id = ? AND item_code = ? AND technician = ?"
  ).get(machineId, item_code, technician);

  if (existing) {
    db.prepare("UPDATE machine_parts SET quantity = quantity + ? WHERE id = ?")
      .run(Number(quantity) || 1, existing.id);
  } else {
    db.prepare(
      `INSERT INTO machine_parts (machine_id, item_code, description, uom, unit_price, quantity, technician)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(machineId, item_code, description || item_code, uom, Number(unit_price) || 0, Number(quantity) || 1, technician);
  }
  return db.prepare("SELECT * FROM machine_parts WHERE machine_id = ? ORDER BY id").all(machineId);
}

// Update a part line's quantity (0 removes it).
function setPartQuantity(partId, quantity) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q < 0) { const e = new Error("Invalid quantity."); e.status = 400; throw e; }
  if (q === 0) {
    db.prepare("DELETE FROM machine_parts WHERE id = ?").run(partId);
    return { removed: true };
  }
  db.prepare("UPDATE machine_parts SET quantity = ? WHERE id = ?").run(q, partId);
  return { removed: false, quantity: q };
}

// Create the Sales Order for a slip (all machines' parts), flip status to CALL_CUSTOMER.
// Mock SO for now — same shape as createOrder — but tagged with the slip number.
function createSlipOrder(slipNumber) {
  const slip = getSlip(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }

  // Flatten every machine's parts into order lines.
  const lines = [];
  for (const m of slip.machines) {
    for (const p of (m.parts || [])) {
      lines.push({
        item_code: p.item_code, description: p.description, uom: p.uom,
        unit_price: p.unit_price, quantity: p.quantity,
      });
    }
  }
  if (lines.length === 0) { const e = new Error("No parts scanned on this slip yet."); e.status = 400; throw e; }

  // Reuse the existing order creation (mock SO + persistence).
  const so = createOrder({ notes: `S/S: ${slip.slip_number}`, lines });

  // Mark slip as awaiting customer call.
  db.prepare("UPDATE service_slips SET status = 'CALL_CUSTOMER' WHERE id = ?").run(slip.id);

  return { ...so, slip_number: slip.slip_number, ss_line: `S/S: ${slip.slip_number}` };
}

// Close a slip: record the DO/CS/INV reference, set status CLOSED.
function closeSlip(slipNumber, closingRef) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }
  if (!closingRef || !String(closingRef).trim()) {
    const e = new Error("A DO/CS/INV reference is required to close."); e.status = 400; throw e;
  }
  db.prepare(
    "UPDATE service_slips SET status = 'CLOSED', closing_ref = ?, closed_at = datetime('now') WHERE id = ?"
  ).run(String(closingRef).trim(), slip.id);
  return getSlip(slipNumber);
}

const slips = {
  createSlip, listSlips, getSlip, addPartToMachine, setPartQuantity, createSlipOrder, closeSlip,
};

module.exports = { findItem, listItems, createOrder, getOrder, slips };
