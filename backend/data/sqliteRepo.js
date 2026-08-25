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
  // Note lines carry no item code or quantity: they are the machine heading,
  // the repair comment and the sub-total rows that make a Sales Order readable
  // as the AutoCount block it will be keyed into. Priced lines still validate.
  for (const l of lines) {
    if (l.note) continue;
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
      if (l.note) {
        // Stored so the order reads back as a block; contributes nothing to the
        // totals. A sub-total row carries its amount for display only — adding
        // it to totalAmount would count that machine twice.
        insertLine.run(orderId, "", l.description || "", "", 0, 0, Number(l.line_amount) || 0);
        continue;
      }
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
// A signature is a PNG data URL drawn on the phone. Cap it so a malformed or
// oversized payload can't bloat the database — a trimmed signature is a few KB,
// so this is generous while still being a limit.
const MAX_SIGNATURE_CHARS = 400_000;

function cleanSignature(sig) {
  if (!sig || typeof sig !== "string") return "";
  if (!sig.startsWith("data:image/png;base64,")) return "";
  if (sig.length > MAX_SIGNATURE_CHARS) return "";
  return sig;
}

function createSlip({ company, debtor_code = "", contact_name = "", contact_number = "", whatsapp_number = "", check_service = false, quote_first = false, notes = "", machines = [], signature = "" } = {}) {
  if (!company || !String(company).trim()) {
    const e = new Error("Company is required to register a service slip.");
    e.status = 400; throw e;
  }
  // Machines arrive either as plain strings (what the app sent before serial
  // numbers existed, and what any phone running a cached copy still sends) or
  // as { desc, serial }. Both are accepted so an old app cannot fail to
  // register a slip just because it predates the field.
  const machineList = (Array.isArray(machines) ? machines : [])
    .map((m) => (typeof m === "string"
      ? { desc: m.trim(), serial: "" }
      : { desc: String((m && m.desc) || "").trim(), serial: String((m && m.serial) || "").trim() }))
    .filter((m) => m.desc);
  if (machineList.length === 0) {
    const e = new Error("At least one machine is required.");
    e.status = 400; throw e;
  }

  const insertSlip = db.prepare(
    `INSERT INTO service_slips (slip_number, company, debtor_code, contact_name, contact_number, whatsapp_number, check_service, quote_first, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`
  );
  const insertMachine = db.prepare(
    "INSERT INTO slip_machines (slip_id, machine_desc, serial_no) VALUES (?, ?, ?)"
  );
  const insertSignature = db.prepare(
    "INSERT INTO slip_signatures (slip_id, image) VALUES (?, ?)"
  );

  // The signature is the customer accepting the printed terms, so it is
  // required. The message names the fix for the one case that isn't a missing
  // signature: a phone still running a cached copy of the app from before this
  // field existed, which would otherwise post without one and get a bare 400.
  const sig = cleanSignature(signature);
  if (!sig) {
    const e = new Error(
      "Customer signature is required. If you don't see a signature box, close and reopen the app to update it."
    );
    e.status = 400; throw e;
  }

  const tx = db.transaction(() => {
    // Inline the counter bump here (calling nextSlipNumber() would open a
    // nested transaction, which SQLite forbids).
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'slip_number'").run();
    const { value } = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get();
    const slipNumber = String(value).padStart(5, "0");
    const info = insertSlip.run(slipNumber, String(company).trim(), String(debtor_code || "").trim(), contact_name, contact_number, whatsapp_number, check_service ? 1 : 0, quote_first ? 1 : 0, notes);
    const slipId = info.lastInsertRowid;
    for (const m of machineList) insertMachine.run(slipId, m.desc, m.serial);
    if (sig) insertSignature.run(slipId, sig);
    return slipNumber;
  });

  const slipNumber = tx();
  return getSlip(slipNumber);
}

// List slips filtered by status group. 'active' = everything not CLOSED.
function listSlips(statusFilter = "active") {
  let rows;
  if (statusFilter === "open") {
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'OPEN' ORDER BY slip_number").all();
  } else if (statusFilter === "working") {
    // Open Service scope: still being worked on (not repaired, not closed)
    rows = db.prepare("SELECT * FROM service_slips WHERE status NOT IN ('ALL_REPAIRED', 'CONVERTED', 'CLOSED') ORDER BY slip_number").all();
  } else if (statusFilter === "repaired" || statusFilter === "call_customer") {
    rows = db.prepare("SELECT * FROM service_slips WHERE status IN ('ALL_REPAIRED', 'CONVERTED') ORDER BY slip_number").all();
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
  // Signature lives in its own table so it never rides along on list queries.
  const sig = db.prepare("SELECT image FROM slip_signatures WHERE slip_id = ?").get(slip.id);
  slip.signature = sig ? sig.image : "";
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
  // Work has started on this slip: auto-bump OPEN -> IN_PROGRESS.
  db.prepare("UPDATE service_slips SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'OPEN'")
    .run(machine.slip_id);
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

// Update a part line's unit price (used when AutoCount has no price for a part
// and staff key it in manually on the slip).
function setPartPrice(partId, price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) { const e = new Error("Invalid price."); e.status = 400; throw e; }
  const row = db.prepare("SELECT id FROM machine_parts WHERE id = ?").get(partId);
  if (!row) { const e = new Error("Part not found."); e.status = 404; throw e; }
  db.prepare("UPDATE machine_parts SET unit_price = ? WHERE id = ?").run(p, partId);
  return { ok: true, unit_price: p };
}

// Create the Sales Order for chosen machines on a slip. The slip only reaches
// CONVERTED once every one of its machines has been put on an order.
// Mock SO for now — same shape as createOrder — but tagged with the slip number.
// Labour is billed through AutoCount's service item. This code also marks the
// start of a machine's block on the Sales Order, so each machine with labour
// contributes one of these lines ahead of its parts.
const LABOUR_ITEM_CODE = "A1 SVR LANDSCAPE";
const LABOUR_DESCRIPTION = "Being repair & replacement of part :-";

function createSlipOrder(slipNumber, machineIds) {
  const slip = getSlip(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }

  // A slip is converted a machine at a time. With no selection, take every
  // machine that has not already gone onto an order.
  const all = slip.machines || [];
  const wanted = Array.isArray(machineIds) && machineIds.length
    ? all.filter((m) => machineIds.map(Number).includes(Number(m.id)))
    : all.filter((m) => !m.converted_at);

  if (!wanted.length) {
    const e = new Error("No machines selected for the Sales Order.");
    e.status = 400; throw e;
  }
  const already = wanted.filter((m) => m.converted_at);
  if (already.length) {
    const e = new Error(
      `Already on a Sales Order: ${already.map((m) => m.machine_desc).join(", ")}. Each machine can only be converted once.`
    );
    e.status = 400; throw e;
  }

  // Refuse a machine with no work recorded at all, naming it - an empty block
  // in AutoCount is worse than a clear refusal here.
  const untouched = wanted
    .filter((m) => (m.parts || []).length === 0 && !String(m.repair_comment || "").trim() && !(Number(m.labour_charge) > 0))
    .map((m) => m.machine_desc);
  if (untouched.length) {
    const e = new Error(`No work recorded on: ${untouched.join(", ")}. Add parts, a labour charge or a repair comment before converting.`);
    e.status = 400; throw e;
  }

  // Build the block exactly as it is keyed into AutoCount, one block per
  // machine:
  //
  //   A1 SVR LANDSCAPE  "Being repair & replacement of part :-"   qty 1, labour
  //   (no code)         "525BX Handheld Blower, S/N: 2025280, S/S: 00042 (R) - 1/6"
  //   <parts>
  //   (no code)         "*Too much 2T Oil"          <- repair comment
  //   (no code)         "SubTotal"                  <- machine total
  //   (blank)
  //
  // and the customer's contact on the last line. The un-coded rows are note
  // lines: no price, no quantity, no effect on the order total.
  //
  // The A1 line opens EVERY block, including at 0.00. In AutoCount it marks
  // where a machine's parts begin, so a block without it cannot be read.
  const lines = [];
  const total = all.length;

  wanted.forEach((m, n) => {
    const labour = Number(m.labour_charge) || 0;
    const parts = m.parts || [];

    lines.push({
      item_code: LABOUR_ITEM_CODE,
      description: LABOUR_DESCRIPTION,
      uom: "NOS",
      unit_price: labour,
      quantity: 1,
    });

    // Position is the machine's place on the SLIP, not in this order - so a
    // slip of six converted in two goes still reads 1/6 ... 6/6.
    const pos = all.findIndex((x) => Number(x.id) === Number(m.id)) + 1;
    const techs = [...new Set(parts.map((p) => p.technician).filter(Boolean))];
    const who = techs.length ? ` (${techs.join("/")})` : "";
    const serial = String(m.serial_no || "").trim();
    lines.push({
      note: true,
      description:
        `${m.machine_desc}` +
        (serial ? `, S/N: ${serial}` : "") +
        `, S/S: ${slip.slip_number}${who} - ${pos}/${total}`,
    });

    let machineTotal = labour;
    for (const p of parts) {
      lines.push({
        item_code: p.item_code, description: p.description, uom: p.uom,
        unit_price: p.unit_price, quantity: p.quantity,
      });
      machineTotal += p.unit_price * p.quantity;
    }

    const comment = String(m.repair_comment || "").trim();
    if (comment) lines.push({ note: true, description: `*${comment}` });

    lines.push({ note: true, description: "SubTotal", line_amount: machineTotal });
    // Blank row between machines, as the keyed block has.
    if (n < wanted.length - 1) lines.push({ note: true, description: "" });
  });

  // Customer contact, as the last line of the block.
  const contact = [slip.contact_name, slip.contact_number].filter(Boolean).join(" ").trim();
  if (contact) lines.push({ note: true, description: contact });

  const so = createOrder({ notes: `S/S: ${slip.slip_number}`, lines });

  // Record which machines this order covered, then move the slip on only when
  // every machine has been converted - a partly converted slip is still work
  // in progress as far as the sales desk is concerned.
  const stamp = db.prepare(
    "UPDATE slip_machines SET converted_at = datetime('now'), so_number = ? WHERE id = ?"
  );
  const finish = db.transaction(() => {
    for (const m of wanted) stamp.run(so.so_number, m.id);
    const left = db.prepare(
      "SELECT COUNT(*) AS n FROM slip_machines WHERE slip_id = ? AND (converted_at IS NULL OR converted_at = '')"
    ).get(slip.id).n;
    if (left === 0) {
      db.prepare("UPDATE service_slips SET status = 'CONVERTED' WHERE id = ?").run(slip.id);
    } else if (slip.status !== "ALL_REPAIRED") {
      db.prepare("UPDATE service_slips SET status = 'ALL_REPAIRED' WHERE id = ?").run(slip.id);
    }
    return left;
  });
  const remaining = finish();

  return {
    ...so,
    slip_number: slip.slip_number,
    ss_line: `S/S: ${slip.slip_number}`,
    machines_converted: wanted.map((m) => ({ id: m.id, machine_desc: m.machine_desc })),
    machines_remaining: remaining,
    slip_status: remaining === 0 ? "CONVERTED" : "ALL_REPAIRED",
  };
}

// Labour billed for one machine, on top of its parts. Stored per machine so
// each unit on a multi-machine slip carries its own charge.
function setMachineLabour(machineId, amount) {
  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ?").get(machineId);
  if (!machine) { const e = new Error("Machine not found."); e.status = 404; throw e; }
  let value = Number(amount);
  if (!Number.isFinite(value) || value < 0) value = 0;
  value = Math.round(value * 100) / 100;
  db.prepare("UPDATE slip_machines SET labour_charge = ? WHERE id = ?").run(value, machineId);
  // Charging labour is work recorded, so bump OPEN -> IN_PROGRESS the same way
  // a repair comment does. Clearing it back to zero doesn't count.
  if (value > 0) {
    db.prepare("UPDATE service_slips SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'OPEN'")
      .run(machine.slip_id);
  }
  return { ok: true, labour_charge: value };
}

// The Sales Order raised for a slip, or null. There is no so_number column on
// service_slips; the link is the "S/S: <slip>" note stamped on the order when
// it was created, so it is matched on that.
function getSlipOrder(slipNumber) {
  const row = db.prepare(
    "SELECT so_number FROM orders WHERE notes = ? ORDER BY id DESC LIMIT 1"
  ).get(`S/S: ${slipNumber}`);
  return row ? getOrder(row.so_number) : null;
}

// Every Sales Order raised for a slip, oldest first. A slip converted a machine
// at a time has several, and without this the earlier ones become unreachable.
function getSlipOrders(slipNumber) {
  const rows = db.prepare(
    "SELECT so_number FROM orders WHERE notes = ? ORDER BY id"
  ).all(`S/S: ${slipNumber}`);
  return rows.map((r) => getOrder(r.so_number)).filter(Boolean);
}

// Record which AutoCount Sales Order an app order became.
function setOrderAutocountDocNo(soNumber, docNo) {
  db.prepare("UPDATE orders SET autocount_doc_no = ? WHERE so_number = ?").run(String(docNo || ""), soNumber);
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

// Save a machine's repair comment (free text).
function setMachineComment(machineId, comment) {
  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ?").get(machineId);
  if (!machine) { const e = new Error("Machine not found."); e.status = 404; throw e; }
  db.prepare("UPDATE slip_machines SET repair_comment = ? WHERE id = ?")
    .run(String(comment == null ? "" : comment), machineId);
  // Work has started on this slip: auto-bump OPEN -> IN_PROGRESS (comment must
  // be non-empty; clearing a comment doesn't count as work).
  if (String(comment || "").trim()) {
    db.prepare("UPDATE service_slips SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'OPEN'")
      .run(machine.slip_id);
  }
  return { ok: true };
}

// Manually set a slip's status. Used by the "Need to Quote" / "Mark Quoted" /
// "Close w/o Quote" buttons. Only the quoting-related statuses (plus the
// return to IN_PROGRESS) can be set this way; the rest are automatic.
const MANUAL_STATUSES = new Set(["NEED_QUOTE", "QUOTED", "IN_PROGRESS"]);
function setSlipStatus(slipNumber, status) {
  const s = String(status || "").toUpperCase();
  if (!MANUAL_STATUSES.has(s)) { const e = new Error("Invalid status."); e.status = 400; throw e; }
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }
  // From ALL_REPAIRED, only the escape hatch back to IN_PROGRESS is allowed
  // (to correct a premature "Create Sales Order"); quoting states are not.
  if ((slip.status === "ALL_REPAIRED" || slip.status === "CONVERTED") && s !== "IN_PROGRESS") {
    const e = new Error("Slip is already fully repaired."); e.status = 400; throw e;
  }
  db.prepare("UPDATE service_slips SET status = ? WHERE id = ?").run(s, slip.id);
  return getSlip(slipNumber);
}

// Search slips by slip number (partial match on the digits). Scope mirrors
// listSlips: 'active' (not closed) or 'all'. Returns lightweight rows (with
// machines) capped to `limit`, newest first.
function searchSlips(query = "", scope = "all", limit = 20) {
  const raw = String(query).trim();
  const q = raw.replace(/\s+/g, ""); // digits-style matching for slip numbers
  const cap = Math.max(1, Math.min(50, Number(limit) || 20));

  let sql, params;
  const scopeClause =
    scope === "active" ? "status != 'CLOSED'" :
    scope === "working" ? "status NOT IN ('ALL_REPAIRED', 'CONVERTED', 'CLOSED')" :
    scope === "repaired" ? "status IN ('ALL_REPAIRED', 'CONVERTED')" :
    "1=1";

  if (!q) {
    // Empty query: most recent slips in scope.
    sql = `SELECT * FROM service_slips WHERE ${scopeClause} ORDER BY slip_number DESC LIMIT ?`;
    params = [cap + 1]; // +1 to detect "more results exist"
  } else {
    // Match the slip number (spaces stripped) OR the company name (as typed,
    // case-insensitive) so "Tan Land" finds Tan Landscaping's slips.
    sql = `SELECT * FROM service_slips
             WHERE ${scopeClause} AND (slip_number LIKE ? OR company LIKE ?)
             ORDER BY slip_number DESC LIMIT ?`;
    params = [`%${q}%`, `%${raw}%`, cap + 1];
  }

  const rows = db.prepare(sql).all(...params);
  const hasMore = rows.length > cap;
  const trimmed = hasMore ? rows.slice(0, cap) : rows;

  const getMachines = db.prepare("SELECT id, machine_desc FROM slip_machines WHERE slip_id = ?");
  for (const r of trimmed) r.machines = getMachines.all(r.id);

  return { results: trimmed, hasMore };
}

const slips = {
  createSlip, listSlips, searchSlips, getSlip, addPartToMachine, setPartQuantity, setPartPrice, setMachineComment, setMachineLabour, setSlipStatus, createSlipOrder, getSlipOrder, getSlipOrders, setOrderAutocountDocNo, closeSlip,
};

module.exports = { findItem, listItems, createOrder, getOrder, slips };

// ---- Part reorder requests ("Order more" -> Purchaser list) -----------------
function createPartRequest({ item_code, description = "", qty_requested, requester = "" } = {}) {
  const code = String(item_code || "").trim();
  const qty = Number(qty_requested);
  if (!code) { const e = new Error("Part code is required."); e.status = 400; throw e; }
  if (!Number.isFinite(qty) || qty < 1) { const e = new Error("Order quantity must be at least 1."); e.status = 400; throw e; }

  // Failsafe: one open request per part. If a PENDING request already exists
  // for this part (codes compared space-stripped, case-insensitive), refuse
  // and tell the requester who already asked and for how many.
  const norm = code.replace(/\s+/g, "").toUpperCase();
  const existing = db.prepare(
    `SELECT * FROM part_requests
      WHERE status = 'PENDING'
        AND REPLACE(UPPER(item_code), ' ', '') = ?`
  ).get(norm);
  if (existing) {
    const who = existing.requester || "someone";
    const when = String(existing.created_at || "").split(" ")[0];
    const e = new Error(
      `This part already has an open request: ${existing.qty_requested} requested by ${who}${when ? " on " + when : ""}.`
    );
    e.status = 409; throw e;
  }

  const info = db.prepare(
    `INSERT INTO part_requests (item_code, description, qty_requested, requester)
     VALUES (?, ?, ?, ?)`
  ).run(code, String(description || ""), Math.floor(qty), String(requester || "").trim());
  return db.prepare("SELECT * FROM part_requests WHERE id = ?").get(info.lastInsertRowid);
}

function listPartRequests(status = "PENDING") {
  const s = String(status || "PENDING").toUpperCase();
  if (s === "ALL") {
    return db.prepare("SELECT * FROM part_requests ORDER BY id DESC").all();
  }
  return db.prepare("SELECT * FROM part_requests WHERE status = ? ORDER BY id DESC").all(s);
}

function markPartRequestOrdered(id) {
  const row = db.prepare("SELECT * FROM part_requests WHERE id = ?").get(id);
  if (!row) { const e = new Error("Request not found."); e.status = 404; throw e; }
  db.prepare("UPDATE part_requests SET status = 'ORDERED', ordered_at = datetime('now','localtime') WHERE id = ?").run(id);
  return { ok: true };
}

const partRequests = { createPartRequest, listPartRequests, markPartRequestOrdered };
module.exports.partRequests = partRequests;

// Fast count of pending reorder requests (for the Purchaser notification).
function countPendingPartRequests() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM part_requests WHERE status = 'PENDING'").get();
  return row ? Number(row.n) : 0;
}
module.exports.partRequests.countPendingPartRequests = countPendingPartRequests;

