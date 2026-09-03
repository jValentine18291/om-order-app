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

// Everything the customer could read on the slip they signed. The comparison
// later is against THIS, not against a guess at what mattered - every field
// here is printed on the PDF, so every one of them is material.
function signedShape(slip, machines) {
  return {
    company: slip.company || "",
    contact_name: slip.contact_name || "",
    contact_number: slip.contact_number || "",
    whatsapp_number: slip.whatsapp_number || "",
    notes: slip.notes || "",
    machines: (machines || []).map((m) => ({
      machine_desc: m.machine_desc || "",
      serial_no: m.serial_no || "",
      remarks: m.remarks || "",
    })),
  };
}

function createSlip({ company, debtor_code = "", contact_name = "", contact_number = "", whatsapp_number = "", check_service = false, repair_only = false, quote_first = false, notes = "", machines = [], signature = "", created_by = "" } = {}) {
  const newCompanyName = String(company || "").trim();
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
          remarks: String((m && m.remarks) || "").trim().slice(0, 500),
          // Phones run a cached copy of the app for a shift after a deploy, so
          // this per-machine tick still arrives from the counter. It is folded
          // into the slip-wide flag below rather than honoured per machine.
          quote: !!(m && m.quote) }))
    .filter((m) => m.desc);
  if (machineList.length === 0) {
    const e = new Error("At least one machine is required.");
    e.status = 400; throw e;
  }

  // A quotation is agreed for the job, not for one machine in it - so it is a
  // property of the slip. An older app that ticked it per machine still counts:
  // if any machine was ticked, the customer asked for a quote.
  const wantsQuote = !!quote_first || machineList.some((m) => m.quote);

  // Opposites, and the form clears one when the other is ticked. Belt and
  // braces here, because an old or hand-rolled client could send both and
  // "service everything but do not service anything" is not a request.
  const checkService = !!check_service && !repair_only;

  const insertSlip = db.prepare(
    `INSERT INTO service_slips (slip_number, company, debtor_code, contact_name, contact_number, whatsapp_number, check_service, repair_only, quote_first, notes, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`
  );
  const insertMachine = db.prepare(
    "INSERT INTO slip_machines (slip_id, machine_desc, serial_no, remarks, state) VALUES (?, ?, ?, ?, ?)"
  );
  const insertSignature = db.prepare(
    "INSERT INTO slip_signatures (slip_id, image, signed_content) VALUES (?, ?, ?)"
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
    const info = insertSlip.run(slipNumber, String(company).trim(), String(debtor_code || "").trim(), contact_name, contact_number, whatsapp_number, checkService ? 1 : 0, repair_only ? 1 : 0, wantsQuote ? 1 : 0, notes, String(created_by || "").trim().slice(0, 60));
    const slipId = info.lastInsertRowid;
    // Every machine starts RECEIVED, even when the customer asked for a quote.
    // Marking them AWAITING_QUOTE here used to put the slip on Sales' Need to
    // Quote list the moment it was written - before a technician had opened
    // anything, with no parts and no labour to quote. A machine reaches that
    // list when a technician sends it, which is when there is a figure to give.
    for (const m of machineList) {
      insertMachine.run(slipId, m.desc, m.serial, m.remarks, "RECEIVED");
    }
    if (sig) {
      // Written inside the same transaction as the slip, so a signature can
      // never exist without a record of what it was given for.
      insertSignature.run(slipId, sig, JSON.stringify(signedShape(
        { company: newCompanyName, contact_name, contact_number, whatsapp_number, notes },
        machineList.map((m) => ({ machine_desc: m.desc, serial_no: m.serial, remarks: m.remarks }))
      )));
    }
    return { slipNumber, slipId };
  });

  const { slipNumber, slipId } = tx();
  deriveSlipStatus(slipId);
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
    rows = db.prepare(`SELECT * FROM service_slips WHERE (
       status IN ('ALL_REPAIRED', 'CONVERTED')
       OR (
         -- Everything on it is either billed or condemned: nothing left to do
         -- in the workshop, even if a condemned machine still has to be
         -- accounted for. Closing refuses in that case, and says so.
         status != 'CLOSED'
         AND EXISTS (SELECT 1 FROM slip_machines m WHERE m.slip_id = service_slips.id)
         AND NOT EXISTS (
           SELECT 1 FROM slip_machines m
            WHERE m.slip_id = service_slips.id
              AND m.state != 'CONDEMNED'
              AND (m.converted_at IS NULL OR m.converted_at = '')
         )
       )
     ) ORDER BY slip_number`).all();
  } else if (statusFilter === "closed") {
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'CLOSED' ORDER BY slip_number DESC").all();
  } else if (statusFilter === "all") {
    rows = db.prepare("SELECT * FROM service_slips ORDER BY slip_number DESC").all();
  } else {
    // 'active': anything not yet closed
    rows = db.prepare("SELECT * FROM service_slips WHERE status != 'CLOSED' ORDER BY slip_number").all();
  }
  // Attach machine list (lightweight — descriptions only) for dropdown display.
  const getMachines = db.prepare("SELECT id, machine_desc, state, disposal, converted_at FROM slip_machines WHERE slip_id = ?");
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
  // Small and always present: whatever displays a slip needs to know it was
  // changed after signing, and a flag nobody fetched is a flag nobody sees.
  slip.amendments = db.prepare(
    "SELECT field, before, after, changed_by, changed_at FROM slip_amendments WHERE slip_id = ? ORDER BY id"
  ).all(slip.id);
  // Whether it was signed, without the image itself - the image is hundreds of
  // kilobytes and is fetched only by what draws it. Anything warning that an
  // edit gets recorded on a signed slip needs the fact, not the picture.
  slip.has_signature = !!db.prepare(
    "SELECT 1 FROM slip_signatures WHERE slip_id = ?"
  ).get(slip.id);
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
  const sig = db.prepare(
    "SELECT image, signed_at, signed_content FROM slip_signatures WHERE slip_id = ?"
  ).get(slip.id);
  if (!sig) return { signature: "", signed_at: "", signed_content: null };
  let content = null;
  try { content = sig.signed_content ? JSON.parse(sig.signed_content) : null; } catch (_) {}
  return { signature: sig.image || "", signed_at: sig.signed_at || "", signed_content: content };
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
  deriveSlipStatus(machine.slip_id);      // work recorded: OPEN -> IN_PROGRESS
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
    return left;
  });
  const remaining = finish();
  deriveSlipStatus(slip.id);

  return {
    ...so,
    slip_number: slip.slip_number,
    ss_line: `S/S: ${slip.slip_number}`,
    machines_converted: wanted.map((m) => ({ id: m.id, machine_desc: m.machine_desc })),
    machines_remaining: remaining,
    slip_status: db.prepare("SELECT status FROM service_slips WHERE id = ?").get(slip.id).status,
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
  deriveSlipStatus(machine.slip_id);
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

// Where this slip's PDF sits in Drive. Written after an upload, so the next
// send replaces that file instead of leaving a second copy of the same slip.
function setSlipDrive(slipNumber, fileId, link) {
  const slip = db.prepare("SELECT id FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  db.prepare("UPDATE service_slips SET drive_file_id = ?, drive_link = ? WHERE id = ?")
    .run(String(fileId || ""), String(link || ""), slip.id);
  return { ok: true };
}

// Close a slip: record the DO/CS/INV reference, set status CLOSED.
function closeSlip(slipNumber, closingRef) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }
  if (!closingRef || !String(closingRef).trim()) {
    const e = new Error("A DO/CS/INV reference is required to close."); e.status = 400; throw e;
  }
  // A condemned machine is not billed, so nothing else would ever ask about it
  // - and it is sitting in the workshop. Closing the slip is the last moment
  // anyone looks, so it is the right place to insist on an answer.
  const stranded = db.prepare(
    `SELECT machine_desc FROM slip_machines
      WHERE slip_id = ? AND state = 'CONDEMNED' AND TRIM(IFNULL(disposal, '')) = ''`
  ).all(slip.id);
  if (stranded.length) {
    const e = new Error(
      `Condemned but not yet accounted for: ${stranded.map((m) => m.machine_desc).join(", ")}. ` +
      "Record whether the customer collected it or we disposed of it."
    );
    e.status = 400; throw e;
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
  deriveSlipStatus(machine.slip_id);
  return { ok: true };
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
    scope === "repaired" ? `(
       status IN ('ALL_REPAIRED', 'CONVERTED')
       OR (
         -- Everything on it is either billed or condemned: nothing left to do
         -- in the workshop, even if a condemned machine still has to be
         -- accounted for. Closing refuses in that case, and says so.
         status != 'CLOSED'
         AND EXISTS (SELECT 1 FROM slip_machines m WHERE m.slip_id = service_slips.id)
         AND NOT EXISTS (
           SELECT 1 FROM slip_machines m
            WHERE m.slip_id = service_slips.id
              AND m.state != 'CONDEMNED'
              AND (m.converted_at IS NULL OR m.converted_at = '')
         )
       )
     )` :
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

  const getMachines = db.prepare("SELECT id, machine_desc, state, disposal, converted_at FROM slip_machines WHERE slip_id = ?");
  for (const r of trimmed) r.machines = getMachines.all(r.id);

  return { results: trimmed, hasMore };
}

// ---- Editing a slip's registration details ----------------------------------
// What was written down at the counter: company, contacts, notes, and each
// machine's name, serial and intake remarks. Parts, labour, comments and
// status are the WORK and live in Open Service - not touched here. A closed
// slip is a finished record and is refused.
function updateSlipDetails(slipNumber, { company, contact_name, contact_number, whatsapp_number, notes, machines, who = "" } = {}) {
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

  // What is about to change, in the customer's terms. Recorded against the
  // slip as it stands now rather than against the signature, so a field
  // corrected twice reads as two corrections instead of one confusing jump.
  const before = signedShape(slip, db.prepare(
    "SELECT machine_desc, serial_no, remarks FROM slip_machines WHERE slip_id = ? ORDER BY id"
  ).all(slip.id));
  const machineById = new Map(db.prepare(
    "SELECT id, machine_desc, serial_no, remarks FROM slip_machines WHERE slip_id = ?"
  ).all(slip.id).map((m) => [m.id, m]));

  const changes = [];
  const note = (field, was, now) => {
    if (String(was || "").trim() !== String(now || "").trim()) {
      changes.push({ field, before: was || "", after: now || "" });
    }
  };
  note("Company", before.company, newCompany);
  note("Contact name", before.contact_name, contact_name === undefined ? before.contact_name : contact_name);
  note("Contact number", before.contact_number, contact_number === undefined ? before.contact_number : contact_number);
  note("WhatsApp number", before.whatsapp_number, whatsapp_number === undefined ? before.whatsapp_number : whatsapp_number);
  note("Notes", before.notes, notes === undefined ? before.notes : notes);
  for (const m of mEdits) {
    const was = machineById.get(m.id) || {};
    note(`Machine "${was.machine_desc || ""}"`, was.machine_desc, m.desc);
    note(`${was.machine_desc || "Machine"} — serial`, was.serial_no, m.serial);
    note(`${was.machine_desc || "Machine"} — remarks`, was.remarks, m.remarks);
  }

  const insertAmendment = db.prepare(
    `INSERT INTO slip_amendments (slip_id, field, before, after, changed_by)
     VALUES (?, ?, ?, ?, ?)`
  );
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
    // Only where the slip carries a signature. An unsigned slip - which the
    // app does not allow, but old data might - has nothing to be amended
    // against, and logging changes to it would say something untrue.
    const signed = db.prepare("SELECT slip_id FROM slip_signatures WHERE slip_id = ?").get(slip.id);
    if (signed) {
      for (const c of changes) {
        insertAmendment.run(slip.id, c.field, c.before, c.after, String(who || "").trim());
      }
    }
  });
  tx();
  return getSlip(slipNumber);
}

// ---- Where a machine is, and what that makes the slip -----------------------
//
// John's workflow, drawn out:
//
//   Open slip -> does this machine need a quotation?
//                  no  -> repair it
//                  yes -> call the customer -> repair it, or condemn it
//
// One field says where a machine is. The slip's status is WORKED OUT from its
// machines and never set directly, except closing, which is a deliberate act
// with a document reference. Before this, the slip's status was written in
// eight places and derived in others, so a slip could disagree with the
// machines on it and nobody could say which was right.
const MACHINE_STATES = new Set([
  "RECEIVED", "AWAITING_QUOTE", "QUOTED", "TO_REPAIR", "CONDEMNED",
]);
const DISPOSALS = new Set(["", "COLLECTED", "DISPOSED"]);

function machineOnSlip(slipNumber, machineId) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }
  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ? AND slip_id = ?")
    .get(machineId, slip.id);
  if (!machine) { const e = new Error("Machine not found on this slip."); e.status = 404; throw e; }
  return { slip, machine };
}

// A machine is finished with when it has been billed, or condemned and got out
// of the building. "Condemned" on its own is not finished: it is still here.
function machineSettled(m) {
  if (m.state === "CONDEMNED") return !!String(m.disposal || "").trim();
  return !!String(m.converted_at || "").trim();
}

// THE one place a slip's status comes from.
function deriveSlipStatus(slipId) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE id = ?").get(slipId);
  if (!slip || slip.status === "CLOSED") return;      // closing is deliberate
  const ms = db.prepare("SELECT * FROM slip_machines WHERE slip_id = ?").all(slipId);
  if (!ms.length) return;

  const any = (f) => ms.some(f);
  let next;
  if (any((m) => m.state === "AWAITING_QUOTE")) {
    // Sales have to act, and that outranks anything already done elsewhere on
    // the slip - otherwise a part-finished slip hides a machine nobody rang about.
    next = "NEED_QUOTE";
  } else if (any((m) => m.state === "QUOTED")) {
    next = "QUOTED";                                   // waiting on the customer
  } else if (any((m) => m.state === "CONDEMNED" && !String(m.disposal || "").trim())) {
    // A condemned machine nobody has accounted for is still in the workshop and
    // still someone's job, whatever has been billed around it. Calling that
    // slip "All Repaired" is how it gets forgotten about.
    next = "IN_PROGRESS";
  } else if (ms.every(machineSettled)) {
    next = "CONVERTED";                                // everything dealt with
  } else if (any((m) => m.converted_at) ) {
    next = "ALL_REPAIRED";                             // some billed, some not
  } else if (any((m) => m.state !== "RECEIVED") || slipHasWork(slipId)) {
    next = "IN_PROGRESS";
  } else {
    next = "OPEN";
  }
  if (next !== slip.status) {
    db.prepare("UPDATE service_slips SET status = ? WHERE id = ?").run(next, slipId);
  }
}

function slipHasWork(slipId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM slip_machines m
      WHERE m.slip_id = ?
        AND (IFNULL(m.labour_charge, 0) > 0
             OR TRIM(IFNULL(m.repair_comment, '')) != ''
             OR EXISTS (SELECT 1 FROM machine_parts p WHERE p.machine_id = m.id))`
  ).get(slipId).n > 0;
}

// Move one machine along. Every step in the drawing is this function.
function setMachineState(slipNumber, machineId, state, who = "") {
  const st = String(state || "").toUpperCase();
  if (!MACHINE_STATES.has(st)) { const e = new Error("Invalid machine state."); e.status = 400; throw e; }
  const { slip, machine } = machineOnSlip(slipNumber, machineId);

  // Leaving CONDEMNED clears the disposal with it: the machine is staying
  // after all, so how it was going to leave no longer means anything.
  const clearDisposal = machine.state === "CONDEMNED" && st !== "CONDEMNED";
  db.prepare(
    `UPDATE slip_machines
        SET state = ?, decided_by = ?, decided_at = datetime('now','localtime')
            ${clearDisposal ? ", disposal = '', disposal_at = '', disposal_by = ''" : ""}
      WHERE id = ?`
  ).run(st, String(who || "").trim(), machine.id);
  deriveSlipStatus(slip.id);
  return getSlip(slipNumber);
}

// Every machine at once - "quote all of them", "none of these need quoting".
function setAllMachineStates(slipNumber, state, who = "") {
  const st = String(state || "").toUpperCase();
  if (!MACHINE_STATES.has(st)) { const e = new Error("Invalid machine state."); e.status = 400; throw e; }
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }
  // Machines already dealt with are left alone: a machine on a Sales Order is
  // not sent back to be quoted because somebody pressed "quote all".
  const rows = db.prepare("SELECT * FROM slip_machines WHERE slip_id = ?").all(slip.id);
  const upd = db.prepare(
    "UPDATE slip_machines SET state = ?, decided_by = ?, decided_at = datetime('now','localtime') WHERE id = ?"
  );
  const tx = db.transaction(() => {
    for (const m of rows) if (!machineSettled(m)) upd.run(st, String(who || "").trim(), m.id);
  });
  tx();
  deriveSlipStatus(slip.id);
  return getSlip(slipNumber);
}

// What happened to a condemned machine: back to the customer, or scrapped.
function setMachineDisposal(slipNumber, machineId, disposal, who = "") {
  const d = String(disposal || "").toUpperCase();
  if (!DISPOSALS.has(d)) { const e = new Error("Invalid disposal."); e.status = 400; throw e; }
  const { slip, machine } = machineOnSlip(slipNumber, machineId);
  if (machine.state !== "CONDEMNED") {
    const e = new Error("Only a condemned machine is collected or disposed of.");
    e.status = 400; throw e;
  }
  db.prepare(
    `UPDATE slip_machines
        SET disposal = ?, disposal_by = ?,
            disposal_at = CASE WHEN ? = '' THEN '' ELSE datetime('now','localtime') END
      WHERE id = ?`
  ).run(d, d ? String(who || "").trim() : "", d, machine.id);
  deriveSlipStatus(slip.id);
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

const slips = {
  createSlip, listSlips, searchSlips, getSlip, getSlipSignature, addPartToMachine, setPartQuantity, setPartPrice, setPartDescription, isFreeTextPart, setMachineComment, setMachineLabour, updateSlipDetails, setMachineState, setAllMachineStates, setMachineDisposal, deriveSlipStatus, techniciansForMachine, createSlipOrder, getSlipOrder, getSlipOrders, setOrderAutocountDocNo, setOrderAutocountError, ordersAwaitingAutoCount, renameOrder, setSlipDrive, closeSlip,
};

module.exports = { findItem, listItems, createOrder, getOrder, slips };

// ---- Notes kept against a part ---------------------------------------------
// Read by everyone, written by Sales, Purchaser and Admin. Lookups are exact:
// a note on the wrong variant of a part is worse than no note.
function getPartNotes(codes) {
  const list = [...new Set((codes || []).map((c) => String(c || "").trim()).filter(Boolean))];
  if (!list.length) return {};
  const marks = list.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT item_code, note, updated_by, updated_at FROM part_notes WHERE item_code IN (${marks})`
  ).all(...list);
  const out = {};
  for (const r of rows) out[r.item_code] = r;
  return out;
}

function getPartNote(itemCode) {
  const code = String(itemCode || "").trim();
  if (!code) return null;
  return db.prepare("SELECT * FROM part_notes WHERE item_code = ?").get(code) || null;
}

function setPartNote(itemCode, note, who = "") {
  const code = String(itemCode || "").trim();
  if (!code) { const e = new Error("Missing item code."); e.status = 400; throw e; }
  const text = String(note === undefined || note === null ? "" : note)
    .replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);

  // An empty note removes it. Keeping a blank row would show an empty comment
  // box on the part for ever.
  if (!text) {
    db.prepare("DELETE FROM part_notes WHERE item_code = ?").run(code);
    return { ok: true, item_code: code, note: "", removed: true };
  }
  db.prepare(
    `INSERT INTO part_notes (item_code, note, updated_by, updated_at)
     VALUES (?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(item_code) DO UPDATE SET
       note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(code, text, String(who || "").trim());
  return getPartNote(code);
}

const partNotes = { getPartNote, getPartNotes, setPartNote };
module.exports.partNotes = partNotes;

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

// "How much was on the shelf when this was asked for", or nothing at all.
//
// Number(null) is 0, not NaN, so the obvious Number.isFinite check quietly
// turned "AutoCount has never heard of this" into "we have none left" - a real
// difference to a purchaser deciding whether to order today. Anything that is
// not actually a number stays null, and the app shows it as an em dash.
function stockSnap(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

  const snap = stockSnap(stock_at_request);
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
    const snap = stockSnap((it || {}).stock_at_request);
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

