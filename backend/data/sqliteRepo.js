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
      ? { desc: m.trim(), serial: "", remarks: "" }
      : { desc: String((m && m.desc) || "").trim(),
          serial: String((m && m.serial) || "").trim(),
          remarks: String((m && m.remarks) || "").trim().slice(0, 500) }))
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
    "INSERT INTO slip_machines (slip_id, machine_desc, serial_no, remarks) VALUES (?, ?, ?, ?)"
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
    for (const m of machineList) insertMachine.run(slipId, m.desc, m.serial, m.remarks);
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
  } else if (statusFilter === "need_quote") {
    // What the technicians have handed back for pricing. Oldest first: the one
    // waiting longest is the one the customer has been waiting on.
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'NEED_QUOTE' ORDER BY slip_number").all();
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
  const getMachines = db.prepare("SELECT id, machine_desc, quote_status FROM slip_machines WHERE slip_id = ?");
  for (const r of rows) r.machines = getMachines.all(r.id);
  return rows;
}

// Full slip detail: slip + machines, and each machine's scanned parts.
// The signature is OFF by default, and that is the whole point.
//
// It is a drawn PNG carried as a data URL - 60KB is ordinary and the cap is
// 400KB - and it was attached to every slip this function returns. That is not
// only opening a slip: it is every part scanned, every save, every status
// change, because each of those returns the slip afterwards. Eleven refresh
// points in the app, each re-sending a picture nobody was looking at, over
// workshop Wi-Fi.
//
// Exactly one thing needs it: the printed slip PDF, which fetches it on its
// own. Keeping it in its own table was the first half of this; not putting it
// on the wire is the second.
function getSlip(slipNumber, includeSignature = false) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) return null;
  const machines = db.prepare("SELECT * FROM slip_machines WHERE slip_id = ?").all(slip.id);
  const getParts = db.prepare("SELECT * FROM machine_parts WHERE machine_id = ? ORDER BY id");
  for (const m of machines) m.parts = getParts.all(m.id);
  slip.machines = machines;
  if (includeSignature) {
    const sig = db.prepare("SELECT image FROM slip_signatures WHERE slip_id = ?").get(slip.id);
    slip.signature = sig ? sig.image : "";
  }
  return slip;
}

// The signature on its own, for the one caller that draws it.
function getSlipSignature(slipNumber) {
  const slip = db.prepare("SELECT id FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  const sig = db.prepare("SELECT image FROM slip_signatures WHERE slip_id = ?").get(slip.id);
  return { signature: sig ? sig.image : "" };
}

// Add a scanned part to a specific machine (or bump qty if same part+technician).
function addPartToMachine(machineId, { item_code, description, uom = "UNIT", unit_price = 0, quantity = 1, technician = "", free_text } = {}) {
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
      `INSERT INTO machine_parts (machine_id, item_code, description, uom, unit_price, quantity, technician, free_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(machineId, item_code, description || item_code, uom, Number(unit_price) || 0, Number(quantity) || 1, technician,
          // The caller has seen the CATALOGUE description; by the time the row
          // is written, the staff-typed name has replaced it, so the fact
          // cannot be worked out here. Trust the flag, and still check the
          // code ourselves so an old client that sends nothing still works.
          (free_text || isFreeTextPart(item_code, description)) ? 1 : 0);
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

// Some catalogue entries stand in for something that is not really a catalogue
// part - the A5 to A8 service and sundry codes, and the MISC placeholders. The
// code is right for the accounts; the description is whatever the part
// actually was, and only the person holding it knows that.
//
// The marker can sit in EITHER field. "MISC - INDENT UNIT_PARTS" is one entry;
// whether AutoCount carries that as the code or as the description of a code
// like IU-001, it is the same kind of line and needs naming either way.
function isFreeTextPart(itemCode, description = "") {
  const norm = (v) => String(v || "").trim().toUpperCase();
  const code = norm(itemCode);
  if (/^A[5-8]\b/.test(code) || code.startsWith("MISC")) return true;
  // Deliberately "starts with", not "contains": a real part whose description
  // merely mentions miscellaneous something must not become free text.
  return norm(description).startsWith("MISC");
}

function setPartDescription(partId, description) {
  const row = db.prepare("SELECT id, item_code, description, free_text FROM machine_parts WHERE id = ?").get(partId);
  if (!row) { const e = new Error("Part not found."); e.status = 404; throw e; }
  // The recorded answer first. Re-deriving it would fail the SECOND edit: by
  // then the description has been replaced with the real part name and no
  // longer looks like a placeholder. Older rows have no flag, so fall back.
  const editable = row.free_text ? true : isFreeTextPart(row.item_code, row.description);
  if (!editable) {
    const e = new Error(
      `${row.item_code} takes its description from AutoCount. Only the A5-A8 and MISC lines can be described by hand.`
    );
    e.status = 400; throw e;
  }
  const text = String(description || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  if (!text) { const e = new Error("A description is required."); e.status = 400; throw e; }
  db.prepare("UPDATE machine_parts SET description = ? WHERE id = ?").run(text, partId);
  return { ok: true, description: text };
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
    // Drop the "- 1/2" the app adds when several of the same machine come in
    // together. On the slip it tells one unit from another; on the Sales Order
    // it collides with the position, so a line would read "525BX - 1/2 ... -
    // 1/3". Only the position on the slip belongs here.
    const model = String(m.machine_desc || "").replace(/\s-\s\d+\/\d+$/, "").trim();
    lines.push({
      note: true,
      description:
        `${model}` +
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

// Take AutoCount's number as the app's own, so staff see one number rather
// than two for the same order. AutoCount is the authority here: it allocates
// the number, and a slip that never reaches AutoCount simply keeps the
// provisional one, which is honest about what has and has not been written.
function renameOrder(oldSoNumber, newSoNumber) {
  const from = String(oldSoNumber || "").trim();
  const to = String(newSoNumber || "").trim();
  if (!from || !to || from === to) return { ok: true, so_number: from };

  const clash = db.prepare("SELECT id FROM orders WHERE so_number = ?").get(to);
  if (clash) {
    // Vanishingly unlikely, but renaming onto an existing number would lose an
    // order. Keep the provisional number rather than destroy anything.
    return { ok: false, so_number: from, reason: `${to} is already used by another order in the app.` };
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE orders SET so_number = ? WHERE so_number = ?").run(to, from);
    // The machines point at the order by number, so they move with it.
    db.prepare("UPDATE slip_machines SET so_number = ? WHERE so_number = ?").run(to, from);
    db.prepare("UPDATE orders SET notes = notes WHERE so_number = ?").run(to);
  });
  tx();
  return { ok: true, so_number: to };
}

// Record which AutoCount Sales Order an app order became, clearing any earlier
// failure - it has arrived, so the old reason is history.
function setOrderAutocountDocNo(soNumber, docNo) {
  db.prepare("UPDATE orders SET autocount_doc_no = ?, autocount_error = '' WHERE so_number = ?")
    .run(String(docNo || ""), soNumber);
}

// Why the last attempt failed, kept so it can be read long after the toast has
// gone.
function setOrderAutocountError(soNumber, reason) {
  db.prepare("UPDATE orders SET autocount_error = ? WHERE so_number = ?")
    .run(String(reason || "").slice(0, 500), soNumber);
}

// Orders the app has raised that are not in AutoCount. Newest first, because
// the one that just failed is the one someone is looking for.
function ordersAwaitingAutoCount() {
  return db.prepare(
    `SELECT so_number, notes, total_amount, autocount_error, created_at
       FROM orders
      WHERE autocount_doc_no IS NULL OR autocount_doc_no = ''
      ORDER BY id DESC`
  ).all();
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

  // Keep the machines in step, so the slip-level buttons mean "all of them"
  // and the per-machine marks below never disagree with the slip's own status.
  //   Need to Quote   -> every machine is waiting
  //   Mark as Quoted  -> everything that was waiting has now been quoted; a
  //                      machine still being repaired is left alone, so it can
  //                      be sent for quoting on its own later
  //   Close w/o Quote -> nothing is waiting any more
  if (s === "NEED_QUOTE") {
    db.prepare("UPDATE slip_machines SET quote_status = 'NEED_QUOTE' WHERE slip_id = ?").run(slip.id);
  } else if (s === "QUOTED") {
    db.prepare("UPDATE slip_machines SET quote_status = 'QUOTED' WHERE slip_id = ? AND quote_status = 'NEED_QUOTE'").run(slip.id);
  } else if (s === "IN_PROGRESS") {
    db.prepare("UPDATE slip_machines SET quote_status = '' WHERE slip_id = ?").run(slip.id);
  }
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

  const getMachines = db.prepare("SELECT id, machine_desc, quote_status FROM slip_machines WHERE slip_id = ?");
  for (const r of trimmed) r.machines = getMachines.all(r.id);

  return { results: trimmed, hasMore };
}

// ---- Editing a slip's registration details ----------------------------------
// What was written down at the counter: company, contacts, notes, and each
// machine's name, serial and intake remarks. Parts, labour, comments and
// status are the WORK and live in Open Service - not touched here. A closed
// slip is a finished record and is refused.
function updateSlipDetails(slipNumber, { company, contact_name, contact_number, whatsapp_number, notes, machines } = {}) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is closed and can no longer be edited."); e.status = 409; throw e; }

  const newCompany = company === undefined ? slip.company : String(company || "").trim();
  if (!newCompany) { const e = new Error("Company cannot be empty."); e.status = 400; throw e; }

  const own = db.prepare("SELECT id FROM slip_machines WHERE slip_id = ?").all(slip.id).map((r) => r.id);
  const ownSet = new Set(own);
  const mEdits = (Array.isArray(machines) ? machines : []).map((m) => {
    const id = Number((m || {}).id);
    if (!ownSet.has(id)) { const e = new Error("A machine in the edit does not belong to this slip."); e.status = 400; throw e; }
    const desc = String((m || {}).machine_desc || "").trim();
    if (!desc) { const e = new Error("A machine's description cannot be empty."); e.status = 400; throw e; }
    return {
      id,
      desc,
      serial: String((m || {}).serial_no || "").trim(),
      remarks: String((m || {}).remarks || "").trim().slice(0, 500),
    };
  });

  const updSlip = db.prepare(
    `UPDATE service_slips SET company = ?, contact_name = ?, contact_number = ?, whatsapp_number = ?, notes = ?
      WHERE id = ?`
  );
  const updMachine = db.prepare(
    "UPDATE slip_machines SET machine_desc = ?, serial_no = ?, remarks = ? WHERE id = ?"
  );
  const tx = db.transaction(() => {
    updSlip.run(
      newCompany,
      contact_name === undefined ? slip.contact_name : String(contact_name || "").trim(),
      contact_number === undefined ? slip.contact_number : String(contact_number || "").trim(),
      whatsapp_number === undefined ? slip.whatsapp_number : String(whatsapp_number || "").trim(),
      notes === undefined ? slip.notes : String(notes || "").trim(),
      slip.id
    );
    for (const m of mEdits) updMachine.run(m.desc, m.serial, m.remarks, m.id);
  });
  tx();
  return getSlip(slipNumber);
}

// ---- Quoting, per machine ---------------------------------------------------
// A slip with two machines is routinely half finished: one repaired and ready
// to price, one still in pieces. Marking the whole slip was the only thing on
// offer, so sales either quoted work that was not done or waited for a machine
// that had nothing to do with the one they could have priced.
//
// The slip's own status is still kept in step, because everything else reads it
// - the sales list, the push, Open Service. It follows the machines rather than
// being set directly: NEED_QUOTE while any machine wants a quote, and settling
// afterwards to QUOTED if any were, or back to IN_PROGRESS if the marks were
// simply cleared.
const MACHINE_QUOTE_STATES = new Set(["NEED_QUOTE", "QUOTED", ""]);

function setMachineQuoteStatus(slipNumber, machineId, status) {
  const s = String(status === undefined || status === null ? "" : status).toUpperCase();
  if (!MACHINE_QUOTE_STATES.has(s)) { const e = new Error("Invalid quote status."); e.status = 400; throw e; }

  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }

  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ? AND slip_id = ?").get(machineId, slip.id);
  if (!machine) { const e = new Error("Machine not found on this slip."); e.status = 404; throw e; }

  db.prepare("UPDATE slip_machines SET quote_status = ? WHERE id = ?").run(s, machine.id);
  syncSlipQuoteStatus(slip.id);
  return getSlip(slipNumber);
}

// ---- What the customer decided ---------------------------------------------
// Sales ring the customer about a machine that is waiting to be quoted, and
// come back with one of two answers. Recording it here is what lets the
// technician be told: before this, the answer lived in whoever took the call.
//
// Deciding also settles the quote for that machine - it is no longer waiting -
// so the slip falls out of the sales list on its own once every machine has an
// answer.
const MACHINE_DECISIONS = new Set(["REPAIR", "CONDEMN", ""]);

function setMachineDecision(slipNumber, machineId, decision, by = "") {
  const d = String(decision === undefined || decision === null ? "" : decision).toUpperCase();
  if (!MACHINE_DECISIONS.has(d)) {
    const e = new Error("Invalid decision."); e.status = 400; throw e;
  }

  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }

  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ? AND slip_id = ?")
    .get(machineId, slip.id);
  if (!machine) { const e = new Error("Machine not found on this slip."); e.status = 404; throw e; }

  if (d === "") {
    // Undoing a decision puts the machine back where it was: waiting to be
    // quoted, so it returns to the sales list rather than disappearing.
    db.prepare(
      `UPDATE slip_machines
          SET work_decision = '', decided_by = '', decided_at = '',
              quote_status = CASE WHEN quote_status = 'QUOTED' THEN 'NEED_QUOTE' ELSE quote_status END
        WHERE id = ?`
    ).run(machine.id);
  } else {
    db.prepare(
      `UPDATE slip_machines
          SET work_decision = ?, decided_by = ?, decided_at = datetime('now','localtime'),
              quote_status = 'QUOTED'
        WHERE id = ?`
    ).run(d, String(by || ""), machine.id);
  }
  syncSlipQuoteStatus(slip.id);
  return getSlip(slipNumber);
}

// Which technicians worked on a machine, by the initials on their part rows -
// the only record of who touched it. A machine with nothing scanned yet has
// none, and the caller decides what to do about that.
function techniciansForMachine(machineId) {
  return db.prepare(
    `SELECT DISTINCT technician FROM machine_parts
      WHERE machine_id = ? AND TRIM(IFNULL(technician, '')) != ''`
  ).all(machineId).map((r) => String(r.technician).trim());
}

function syncSlipQuoteStatus(slipId) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE id = ?").get(slipId);
  // A slip that is finished, converted or closed has left quoting behind; its
  // status means something else now and must not be rewritten.
  if (!slip || ["ALL_REPAIRED", "CONVERTED", "CLOSED"].includes(slip.status)) return;

  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN quote_status = 'NEED_QUOTE' THEN 1 ELSE 0 END) AS needing,
       SUM(CASE WHEN quote_status = 'QUOTED'     THEN 1 ELSE 0 END) AS quoted
     FROM slip_machines WHERE slip_id = ?`
  ).get(slipId);

  // With nothing waiting, the slip falls back to how far the work has actually
  // got. Undoing a mark on a slip nobody has touched must leave it OPEN: "In
  // Progress" would claim work has started, which nothing here establishes.
  let settled = "IN_PROGRESS";
  if (!counts.needing && !counts.quoted) {
    const work = db.prepare(
      `SELECT COUNT(*) AS n FROM slip_machines m
        WHERE m.slip_id = ?
          AND (IFNULL(m.labour_charge, 0) > 0
               OR TRIM(IFNULL(m.repair_comment, '')) != ''
               OR EXISTS (SELECT 1 FROM machine_parts p WHERE p.machine_id = m.id))`
    ).get(slipId).n;
    if (!work) settled = "OPEN";
  }

  const next = counts.needing > 0 ? "NEED_QUOTE"
             : counts.quoted  > 0 ? "QUOTED"
             : settled;
  if (next !== slip.status) {
    db.prepare("UPDATE service_slips SET status = ? WHERE id = ?").run(next, slipId);
  }
}

const slips = {
  createSlip, listSlips, searchSlips, getSlip, getSlipSignature, addPartToMachine, setPartQuantity, setPartPrice, setPartDescription, isFreeTextPart, setMachineComment, setMachineLabour, setSlipStatus, updateSlipDetails, setMachineQuoteStatus, setMachineDecision, techniciansForMachine, createSlipOrder, getSlipOrder, getSlipOrders, setOrderAutocountDocNo, setOrderAutocountError, ordersAwaitingAutoCount, renameOrder, closeSlip,
};

module.exports = { findItem, listItems, createOrder, getOrder, slips };

// ---- Part reorder requests ("Order more" / "Bulk Order" -> Orders list) -----
// Every request belongs to a batch: a bulk order is several parts submitted
// together and reviewed as ONE order, and a part ordered on its own is simply a
// batch of one. The purchaser's list groups by it, and "ordered" is marked per
// batch - which is how she works: one request, one Purchase Order.
function nextBatchId() {
  // Readable and unique: the highest id the table has seen, plus one. Two
  // people submitting at the same instant still differ, because the id is read
  // inside the same transaction that inserts the rows.
  const row = db.prepare("SELECT IFNULL(MAX(id), 0) + 1 AS n FROM part_requests").get();
  return "B" + row.n;
}

// The open request a part clashes with, if any. Shared by the single and bulk
// paths so the guard cannot drift between them.
function openRequestFor(code) {
  const norm = String(code).replace(/\s+/g, "").toUpperCase();
  return db.prepare(
    `SELECT * FROM part_requests
      WHERE status = 'PENDING'
        AND REPLACE(UPPER(item_code), ' ', '') = ?`
  ).get(norm);
}

// A5-A8 and MISC codes stand for something not in the catalogue, so on an
// order the typed description is the ONLY thing that says what to buy. An
// order reading "MISC - INDENT UNIT_PARTS x 2" tells the purchaser nothing.
//
// "Real" means: present, and not still the placeholder it came with - if it
// starts with MISC or is just the code back again, nobody has said anything.
function isPlaceholderLine(itemCode, flag) {
  // The flag comes from the client, which saw the CATALOGUE description before
  // staff replaced it - the only moment that fact is visible. The code test
  // stands on its own so an old app, or a direct API call, is still judged.
  return !!flag || isFreeTextPart(itemCode, "");
}

function describedEnough(itemCode, description, flag) {
  const text = String(description || "").trim();
  if (!isPlaceholderLine(itemCode, flag)) return true;  // ordinary part: catalogue name is fine
  if (!text) return false;
  const norm = (v) => String(v || "").trim().toUpperCase();
  if (norm(text) === norm(itemCode)) return false;
  return !norm(text).startsWith("MISC");
}

function describeError(itemCode) {
  const e = new Error(
    `${itemCode} is a placeholder code, so it needs a description saying what to order.`
  );
  e.status = 400;
  return e;
}

function clashMessage(existing) {
  const who = existing.requester || "someone";
  const when = String(existing.created_at || "").split(" ")[0];
  return `${existing.qty_requested} requested by ${who}${when ? " on " + when : ""}`;
}

function createPartRequest({ item_code, description = "", qty_requested, requester = "", remarks = "", stock_at_request = null, free_text = false } = {}) {
  const code = String(item_code || "").trim();
  const qty = Number(qty_requested);
  if (!code) { const e = new Error("Part code is required."); e.status = 400; throw e; }
  if (!Number.isFinite(qty) || qty < 1) { const e = new Error("Order quantity must be at least 1."); e.status = 400; throw e; }

  const placeholder = isPlaceholderLine(code, free_text);
  if (!describedEnough(code, description, free_text)) throw describeError(code);

  // Failsafe: one open request per part, so the purchaser never orders the same
  // part twice because two people noticed the same empty shelf.
  //
  // NOT for the placeholder codes. Every indent part shares one code, so two
  // open requests against it are two DIFFERENT things to buy - refusing the
  // second would be refusing a real order because an unrelated one exists.
  if (!placeholder) {
    const existing = openRequestFor(code);
    if (existing) {
      const e = new Error(`This part already has an open request: ${clashMessage(existing)}.`);
      e.status = 409; throw e;
    }
  }

  const snap = Number.isFinite(Number(stock_at_request)) ? Number(stock_at_request) : null;
  const info = db.prepare(
    `INSERT INTO part_requests (item_code, description, qty_requested, requester, remarks, batch_id, stock_at_request, free_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, String(description || ""), Math.floor(qty), String(requester || "").trim(),
        String(remarks || "").trim().slice(0, 500), nextBatchId(), snap, placeholder ? 1 : 0);
  return db.prepare("SELECT * FROM part_requests WHERE id = ?").get(info.lastInsertRowid);
}

// A whole order at once. All-or-nothing: if anything is wrong - a bad quantity,
// a part already requested, the same part twice in the cart - NOTHING is saved
// and every problem is reported together, so the person fixes the cart once
// rather than resubmitting to discover the next complaint.
function createPartRequestBatch({ items, requester = "", batch_remarks = "" } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) { const e = new Error("The order is empty."); e.status = 400; throw e; }
  if (list.length > 50) { const e = new Error("An order can hold at most 50 parts."); e.status = 400; throw e; }

  const problems = [];
  const seen = new Set();
  const cleaned = list.map((it, i) => {
    const code = String((it || {}).item_code || "").trim();
    const qty = Number((it || {}).qty_requested);
    const label = code || `line ${i + 1}`;
    if (!code) problems.push(`Line ${i + 1} has no part code.`);
    if (!Number.isFinite(qty) || qty < 1) problems.push(`${label}: quantity must be at least 1.`);
    const placeholder = code && isPlaceholderLine(code, (it || {}).free_text);
    if (code && !describedEnough(code, (it || {}).description, (it || {}).free_text)) {
      problems.push(`${label} is a placeholder code - type what to order.`);
    }
    // Both duplicate checks are skipped for placeholder codes: several indent
    // parts legitimately share one code, and they are told apart by their
    // descriptions, not by it.
    const norm = code.replace(/\s+/g, "").toUpperCase();
    if (norm && !placeholder && seen.has(norm)) problems.push(`${label} is in the order twice - combine the quantities.`);
    if (norm && !placeholder) seen.add(norm);
    if (code && !placeholder) {
      const existing = openRequestFor(code);
      if (existing) problems.push(`${label} already has an open request: ${clashMessage(existing)}.`);
    }
    const snap = Number((it || {}).stock_at_request);
    return {
      code,
      qty: Math.floor(qty),
      description: String((it || {}).description || ""),
      remarks: String((it || {}).remarks || "").trim().slice(0, 500),
      snap: Number.isFinite(snap) ? snap : null,
      placeholder: !!placeholder,
    };
  });
  if (problems.length) {
    const e = new Error(problems.join("\n"));
    e.status = problems.some((t) => t.includes("open request")) ? 409 : 400;
    throw e;
  }

  const orderRemarks = String(batch_remarks || "").trim().slice(0, 500);
  const insert = db.prepare(
    `INSERT INTO part_requests (item_code, description, qty_requested, requester, remarks, batch_remarks, batch_id, stock_at_request, free_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    const batch = nextBatchId();
    for (const c of cleaned) {
      insert.run(c.code, c.description, c.qty, String(requester || "").trim(), c.remarks, orderRemarks, batch, c.snap, c.placeholder ? 1 : 0);
    }
    return batch;
  });
  const batch = tx();
  return db.prepare("SELECT * FROM part_requests WHERE batch_id = ? ORDER BY id").all(batch);
}

// Edit a pending order. Once marked Ordered it is the record of what was
// transferred to a Purchase Order, so editing is refused - undo does not
// exist for a document someone else has already keyed from.
function updatePartRequestBatch(batchId, { lines = [], batch_remarks } = {}) {
  const rows = db.prepare("SELECT * FROM part_requests WHERE batch_id = ?").all(String(batchId || ""));
  if (!rows.length) { const e = new Error("Order not found."); e.status = 404; throw e; }
  if (rows.some((r) => r.status !== "PENDING")) {
    const e = new Error("This order has already been marked Ordered and can no longer be edited.");
    e.status = 409; throw e;
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const edits = Array.isArray(lines) ? lines : [];
  const removals = [];
  const changes = [];
  for (const l of edits) {
    const row = byId.get(Number((l || {}).id));
    if (!row) { const e = new Error("A line in the edit does not belong to this order."); e.status = 400; throw e; }
    if (l.remove) { removals.push(row.id); continue; }
    const qty = Number(l.qty_requested);
    if (!Number.isFinite(qty) || qty < 1) {
      const e = new Error(`${row.item_code}: quantity must be at least 1.`); e.status = 400; throw e;
    }
    // Only a placeholder line's description may be changed: an ordinary part's
    // name belongs to AutoCount, and rewriting it here would put a description
    // on the Purchase Order that matches nothing in the catalogue.
    const placeholder = isPlaceholderLine(row.item_code, row.free_text);
    let description = row.description;
    if (l.description !== undefined && placeholder) {
      description = String(l.description).trim().slice(0, 200);
      if (!describedEnough(row.item_code, description, row.free_text)) throw describeError(row.item_code);
    }
    changes.push({
      id: row.id, qty: Math.floor(qty),
      remarks: String(l.remarks || "").trim().slice(0, 500),
      description,
    });
  }
  if (removals.length >= rows.length) {
    const e = new Error("An order cannot lose every part - remove the whole request instead of its last line.");
    e.status = 400; throw e;
  }

  const upd = db.prepare("UPDATE part_requests SET qty_requested = ?, remarks = ?, description = ? WHERE id = ?");
  const del = db.prepare("DELETE FROM part_requests WHERE id = ?");
  const updOrder = db.prepare("UPDATE part_requests SET batch_remarks = ? WHERE batch_id = ?");
  const tx = db.transaction(() => {
    for (const c of changes) upd.run(c.qty, c.remarks, c.description, c.id);
    for (const id of removals) del.run(id);
    if (batch_remarks !== undefined) {
      updOrder.run(String(batch_remarks || "").trim().slice(0, 500), String(batchId));
    }
  });
  tx();
  return db.prepare("SELECT * FROM part_requests WHERE batch_id = ? ORDER BY id").all(String(batchId));
}

// Delete a whole order, whatever its status. The purchaser asked for this for
// the cases a status cannot express: a duplicate, a part ordered by mistake, a
// request that was cancelled by phone. Unlike editing - which is refused once
// Ordered, because that row is the record of a Purchase Order - deleting is
// deliberate destruction, so the frontend confirms and the caller is named in
// the log. The nightly backup is the way back if one goes wrong.
function deletePartRequestBatch(batchId, who = "") {
  const rows = db.prepare("SELECT * FROM part_requests WHERE batch_id = ?").all(String(batchId || ""));
  if (!rows.length) { const e = new Error("Order not found."); e.status = 404; throw e; }
  db.prepare("DELETE FROM part_requests WHERE batch_id = ?").run(String(batchId));
  const parts = rows.map((r) => `${r.qty_requested} x ${r.item_code}`).join(", ");
  console.log(`[orders] ${who || "?"} deleted ${rows[0].status} order ${batchId}: ${parts}`);
  return { ok: true, removed: rows.length };
}

// Everything a batch holds becomes ORDERED together - the purchaser transfers
// the whole request to one Purchase Order, so its parts move as one.
function markPartRequestBatchOrdered(batchId) {
  const rows = db.prepare("SELECT * FROM part_requests WHERE batch_id = ?").all(String(batchId || ""));
  if (!rows.length) { const e = new Error("Order not found."); e.status = 404; throw e; }
  db.prepare(
    `UPDATE part_requests
        SET status = 'ORDERED', ordered_at = datetime('now','localtime')
      WHERE batch_id = ? AND status = 'PENDING'`
  ).run(String(batchId));
  return { ok: true };
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

const partRequests = { createPartRequest, createPartRequestBatch, listPartRequests, markPartRequestOrdered, markPartRequestBatchOrdered, updatePartRequestBatch, deletePartRequestBatch };
module.exports.partRequests = partRequests;

// Fast count of pending reorder requests (for the Purchaser notification).
function countPendingPartRequests() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM part_requests WHERE status = 'PENDING'").get();
  return row ? Number(row.n) : 0;
}
module.exports.partRequests.countPendingPartRequests = countPendingPartRequests;

