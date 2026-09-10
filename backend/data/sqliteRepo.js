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
          // The AutoCount item, when one was chosen from the list. Trimmed and
          // kept as sent: it is written, not searched, so it must be the exact
          // code the catalogue holds.
          code: String((m && m.machine_code) || "").trim(),
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
    "INSERT INTO slip_machines (slip_id, machine_desc, machine_code, serial_no, remarks, state) VALUES (?, ?, ?, ?, ?, ?)"
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
      insertMachine.run(slipId, m.desc, m.code, m.serial, m.remarks, "RECEIVED");
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
    // PART_SO is deliberately NOT excluded: some of the slip is billed, but a
    // machine is still on the bench and it is still the workshop's.
    rows = db.prepare("SELECT * FROM service_slips WHERE status NOT IN ('ALL_REPAIRED', 'CONVERTED', 'INVOICED', 'CLOSED') ORDER BY slip_number").all();
  } else if (statusFilter === "need_quote") {
    // What the technicians have handed back for pricing. Oldest first: the one
    // waiting longest is the one the customer has been waiting on.
    rows = db.prepare("SELECT * FROM service_slips WHERE status = 'NEED_QUOTE' ORDER BY slip_number").all();
  } else if (statusFilter === "repaired" || statusFilter === "call_customer") {
    rows = db.prepare(`SELECT * FROM service_slips WHERE (
       status IN ('ALL_REPAIRED', 'CONVERTED', 'INVOICED', 'PART_SO')
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
  // The Sales Orders raised for it and the DO/CS/INV recorded against each.
  // Carried with the slip because every screen that shows one shows the other:
  // "SO-2026-00001 -> DO-2609-0101" is one fact, not two.
  slip.orders = slipOrderRefs(slip.slip_number);
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
//
// variant tells two lines apart that share an item code. It exists for the
// PulsFOG tubes, where Z00126.03 is four tube types at four different prices:
// merging 222 into 311 because both are Z00126.03 would quietly produce a
// figure that is neither. Everything else passes '' and merges as before.
function addPartToMachine(machineId, { item_code, description, uom = "UNIT", unit_price = 0, quantity = 1, technician = "", free_text, variant = "" } = {}) {
  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ?").get(machineId);
  if (!machine) { const e = new Error("Machine not found on any slip."); e.status = 404; throw e; }
  if (!item_code) { const e = new Error("item_code is required."); e.status = 400; throw e; }

  // If the same part was already scanned for this machine by the same tech, bump qty.
  // Same variant too: a second cut of tube 142 adds to the first, but tube 311
  // off the same roll starts a line of its own.
  const variantKey = String(variant || "");
  const existing = db.prepare(
    "SELECT * FROM machine_parts WHERE machine_id = ? AND item_code = ? AND technician = ? AND IFNULL(variant, '') = ?"
  ).get(machineId, item_code, technician, variantKey);

  if (existing) {
    db.prepare("UPDATE machine_parts SET quantity = quantity + ? WHERE id = ?")
      .run(Number(quantity) || 1, existing.id);
  } else {
    db.prepare(
      `INSERT INTO machine_parts (machine_id, item_code, description, uom, unit_price, quantity, technician, variant, free_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(machineId, item_code, description || item_code, uom, Number(unit_price) || 0, Number(quantity) || 1, technician,
          variantKey,
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

// A condemned machine still goes on the order. The customer is collecting it
// along with the repaired ones, and a machine that leaves the building with no
// paperwork is one nobody can account for afterwards - so it gets its usual
// block, at nothing, saying why.
const CONDEMNED_NOTE = "*Condemned - beyond repair";

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
  //
  // Condemned machines are exempt. Being condemned IS the fact the block
  // records, and it is often the whole of it: a machine written off on sight
  // has no parts, no labour and nothing anyone typed.
  const untouched = wanted
    .filter((m) => m.state !== "CONDEMNED")
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
    // A condemned machine is charged for nothing, whatever was scanned against
    // it before the customer said no. Its parts were never fitted and its
    // labour was never spent, so neither is billed and neither is listed -
    // a priced line on a block that has to total nothing is a line somebody
    // will one day add up.
    const condemned = m.state === "CONDEMNED";
    const labour = condemned ? 0 : Number(m.labour_charge) || 0;
    const parts = condemned ? [] : (m.parts || []);

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

    // What the technician wrote, then - for a condemned machine - why it is
    // here at nothing. Both, because the technician's line says what was wrong
    // with it and this one says what was decided about it.
    const comment = String(m.repair_comment || "").trim();
    if (comment) lines.push({ note: true, description: `*${comment}` });
    if (condemned) lines.push({ note: true, description: CONDEMNED_NOTE });

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

// The Sales Orders on a slip, with the DO/CS/INV recorded against each - what
// the screens need to show "SO-2026-00001 -> DO-2609-0101" without reading
// every order in full.
function slipOrderRefs(slipNumber) {
  return db.prepare(
    `SELECT so_number, autocount_doc_no, closing_ref, invoiced_at, invoiced_by
       FROM orders WHERE notes = ? ORDER BY id`
  ).all(`S/S: ${slipNumber}`).map((o) => ({
    so_number: o.so_number,
    autocount_doc_no: o.autocount_doc_no || "",
    closing_ref: o.closing_ref || "",
    invoiced_at: o.invoiced_at || "",
    invoiced_by: o.invoiced_by || "",
  }));
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
// A condemned machine is not billed, so nothing else would ever ask about it -
// and it is sitting in the workshop taking up space. The end of the slip is
// the last moment anyone looks, so it is where an answer is insisted on.
function strandedCondemned(slipId) {
  return db.prepare(
    `SELECT machine_desc FROM slip_machines
      WHERE slip_id = ? AND state = 'CONDEMNED' AND TRIM(IFNULL(disposal, '')) = ''`
  ).all(slipId).map((m) => m.machine_desc);
}

// Step one of two: sales have keyed the Sales Order into AutoCount as a
// DO/INV/CS, and this records the number it came back with.
//
// Nothing in this app can see that happen - AutoCount is where the document is
// created - so this is a person saying it did. Only after this does anyone
// ring the customer to come and collect, which is why it is its own step and
// not folded into closing.
function setSlipInvoiced(slipNumber, ref, who = "", soNumber = "") {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }
  if (!ref || !String(ref).trim()) {
    const e = new Error("A DO/CS/INV number is required."); e.status = 400; throw e;
  }
  // Which order this number belongs to.
  //
  // Named by the caller where there is a choice; where the slip has only one
  // order there is nothing to choose and the screen need not ask.
  const orders = db.prepare(
    "SELECT * FROM orders WHERE notes = ? ORDER BY id"
  ).all(`S/S: ${slipNumber}`);
  if (!orders.length) {
    const e = new Error("Create the Sales Order first - there is nothing on an order to invoice yet.");
    e.status = 400; throw e;
  }
  const wanted = String(soNumber || "").trim();
  const order = wanted
    ? orders.find((o) => o.so_number === wanted)
    : (orders.length === 1 ? orders[0] : null);
  if (wanted && !order) {
    const e = new Error(`${wanted} is not a Sales Order on this slip.`); e.status = 400; throw e;
  }
  if (!order) {
    const e = new Error(
      `This slip has ${orders.length} Sales Orders - say which one this number is for.`
    );
    e.status = 400; throw e;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE orders SET closing_ref = ?, invoiced_by = ?,
                        invoiced_at = datetime('now','localtime')
        WHERE id = ?`
    ).run(String(ref).trim(), String(who || "").trim(), order.id);

    // The slip says Invoice Created as soon as ONE order has its number - the
    // customer is being called about that batch - and the count on screen says
    // how far along it is. Closing is what insists on all of them.
    //
    // The slip's own closing_ref keeps the most recent, so every screen and
    // document that reads one number still reads a true one.
    db.prepare(
      `UPDATE service_slips
          SET status = 'INVOICED', closing_ref = ?, invoiced_by = ?,
              invoiced_at = datetime('now','localtime')
        WHERE id = ?`
    ).run(String(ref).trim(), String(who || "").trim(), slip.id);
  });
  tx();
  return getSlip(slipNumber);
}

// Step two: the customer has been, collected the machines and paid.
//
// The DO/CS/INV number was recorded at the step above and is not asked for
// again - passing one here only corrects it, for the case where sales notice
// the wrong number after the fact.
function closeSlip(slipNumber, closingRef, who = "") {
  const slip = db.prepare("SELECT * FROM service_slips WHERE slip_number = ?").get(slipNumber);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }
  if (slip.status === "CLOSED") { const e = new Error("Slip is already closed."); e.status = 400; throw e; }

  // The order John asked for: SO created, then invoiced, then collected. A slip
  // that skipped the middle step has work nobody has billed for, and closing
  // it is how that gets forgotten. Checked before the number, so there is one
  // message for one situation rather than two that nearly agree.
  if (slip.status !== "INVOICED") {
    const e = new Error(
      "Record the DO/CS/INV number first - a slip is only collected after it has been invoiced."
    );
    e.status = 400; throw e;
  }
  // EVERY order, not just the last one recorded.
  //
  // The slip reads Invoice Created as soon as one batch has its number, which
  // is right - somebody is ringing that customer. Closing is the step that has
  // to be sure nothing was left behind, and a slip converted in two goes with
  // only the first invoiced is exactly the case this catches.
  const missing = db.prepare(
    `SELECT so_number FROM orders
      WHERE notes = ? AND TRIM(IFNULL(closing_ref, '')) = ''
      ORDER BY id`
  ).all(`S/S: ${slipNumber}`).map((o) => o.so_number);
  if (missing.length) {
    const e = new Error(
      `No DO/CS/INV recorded for ${missing.join(", ")}. Record it before closing the slip.`
    );
    e.status = 400; throw e;
  }

  const ref = String(closingRef || slip.closing_ref || "").trim();
  if (!ref) {
    const e = new Error("Record the DO/CS/INV number first."); e.status = 400; throw e;
  }
  const stranded = strandedCondemned(slip.id);
  if (stranded.length) {
    const e = new Error(
      `Condemned but not yet accounted for: ${stranded.join(", ")}. ` +
      "Record whether the customer collected it or we disposed of it."
    );
    e.status = 400; throw e;
  }

  // And nothing still sitting on the bench.
  //
  // Found by walking a half-collected slip: two machines of three billed and
  // invoiced, and the slip closed - taking the third with it, unbilled, off
  // every list anyone looks at. Closing is the last moment anybody reads a
  // slip, so it is where every machine has to be accounted for: billed, or
  // condemned and gone.
  const unfinished = db.prepare(
    "SELECT machine_desc, state, disposal, converted_at FROM slip_machines WHERE slip_id = ?"
  ).all(slip.id).filter((m) => !machineSettled(m)).map((m) => m.machine_desc);
  if (unfinished.length) {
    const e = new Error(
      `Not on a Sales Order yet: ${unfinished.join(", ")}. ` +
      "Every machine has to be billed or accounted for before the slip closes."
    );
    e.status = 400; throw e;
  }
  db.prepare(
    `UPDATE service_slips
        SET status = 'CLOSED', closing_ref = ?, closed_by = ?, closed_at = datetime('now')
      WHERE id = ?`
  ).run(ref, String(who || "").trim(), slip.id);
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
    scope === "working" ? "status NOT IN ('ALL_REPAIRED', 'CONVERTED', 'INVOICED', 'CLOSED')" :
    scope === "repaired" ? `(
       status IN ('ALL_REPAIRED', 'CONVERTED', 'INVOICED', 'PART_SO')
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
    // undefined means "the client did not send this field", which is NOT the
    // same as "clear it". Phones run a cached copy of the app for a shift
    // after a deploy, so an edit saved from an older one arrives with no
    // machine_code at all - and wiping the catalogue item because of that
    // would undo the very corrections this screen exists to make.
    const rawCode = (m || {}).machine_code;
    return {
      id,
      desc,
      code: rawCode === undefined ? undefined : String(rawCode || "").trim(),
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
  const updMachineWithCode = db.prepare(
    "UPDATE slip_machines SET machine_desc = ?, serial_no = ?, remarks = ?, machine_code = ? WHERE id = ?"
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
    for (const m of mEdits) {
      if (m.code === undefined) updMachine.run(m.desc, m.serial, m.remarks, m.id);
      else updMachineWithCode.run(m.desc, m.serial, m.remarks, m.code, m.id);
    }
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

// ---- Purchase orders: the part AutoCount does not know ----------------------
// Only one fact so far - whether the PO has been sent to the supplier. The
// order itself, its lines and quantities are AutoCount's and are never copied
// here: two copies of the same list is two lists that disagree.
const PO_STATUSES = new Set(["NOT_ORDERED", "ORDERED"]);

// Absent means NOT_ORDERED. A PO raised in AutoCount an hour ago has no row
// here and reads correctly anyway, which is what stops this table needing to
// be kept in step with theirs.
function poTracking(docNos) {
  const list = [...new Set((docNos || []).map((d) => String(d || "").trim()).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const rows = db.prepare(
      `SELECT * FROM po_tracking WHERE doc_no IN (${chunk.map(() => "?").join(",")})`
    ).all(...chunk);
    for (const r of rows) out.set(r.doc_no, r);
  }
  return out;
}

function poStatus(docNo) {
  const row = db.prepare("SELECT * FROM po_tracking WHERE doc_no = ?").get(String(docNo || "").trim());
  return row || { doc_no: String(docNo || "").trim(), status: "NOT_ORDERED", ordered_at: null,
                  updated_by: "", updated_at: null };
}

function setPoStatus(docNo, status, who = "") {
  const no = String(docNo || "").trim();
  if (!no) { const e = new Error("Which purchase order?"); e.status = 400; throw e; }
  const st = String(status || "").toUpperCase();
  if (!PO_STATUSES.has(st)) { const e = new Error("Invalid purchase order status."); e.status = 400; throw e; }
  if (!String(who || "").trim()) {
    const e = new Error("Missing initials, so the change could not be traced."); e.status = 400; throw e;
  }
  // The date it was SENT is worth keeping even if the status is later put
  // back: "when did we order this" is asked of a PO long after anyone
  // remembers, and re-ticking it should not invent a new date.
  const existing = db.prepare("SELECT ordered_at FROM po_tracking WHERE doc_no = ?").get(no);
  const orderedAt = st === "ORDERED"
    ? (existing && existing.ordered_at) || new Date().toISOString().slice(0, 10)
    : (existing && existing.ordered_at) || null;
  db.prepare(
    `INSERT INTO po_tracking (doc_no, status, ordered_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(doc_no) DO UPDATE SET
       status = excluded.status,
       ordered_at = excluded.ordered_at,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(no, st, orderedAt, String(who).trim());
  return poStatus(no);
}

// ---- Shipments --------------------------------------------------------------
// Goods do not arrive by purchase order, so the tracking hangs here.
//
// A shipment is entirely the app's: AutoCount knows nothing about a container
// or an ETA. What it borrows from AutoCount is only the identity of the lines
// on board - the PO number and AutoCount's own line sequence.
const SHIPMENT_STATUSES = new Set(["SHIPPED", "ARRIVED_SG", "RECEIVED", "CANCELLED"]);
const DESTINATIONS = new Set(["", "JOO_SENG", "EUNOS"]);

// A shipment is finished with when its goods are in, or it never sailed.
// Anything else is still worth watching, and that is what the default list
// shows.
const SHIPMENT_LIVE = ["SHIPPED", "ARRIVED_SG"];

function shipmentRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    invoice_no: r.invoice_no,
    supplier_code: r.supplier_code || "",
    supplier_name: r.supplier_name || "",
    bl_no: r.bl_no || "",
    container_no: r.container_no || "",
    status: r.status,
    destination: r.destination || "",
    eta_sg: r.eta_sg || "",
    eta_dest: r.eta_dest || "",
    notes: r.notes || "",
    created_by: r.created_by || "",
    created_at: r.created_at || "",
    updated_by: r.updated_by || "",
    updated_at: r.updated_at || "",
  };
}

// A date, or nothing. Anything that is not a plain yyyy-mm-dd is refused
// rather than stored: a date this cannot read is a date no screen can sort by,
// and it would sit there looking fine.
function cleanDate(v, label) {
  const d = String(v == null ? "" : v).trim();
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const e = new Error(`${label} must be a date.`); e.status = 400; throw e;
  }
  return d;
}

function listShipments({ scope = "live" } = {}) {
  const rows = scope === "all"
    ? db.prepare("SELECT * FROM shipments ORDER BY id DESC").all()
    : db.prepare(
        `SELECT * FROM shipments
          WHERE status IN (${SHIPMENT_LIVE.map(() => "?").join(",")})
          -- Soonest first: the list is read to find out what lands next, and a
          -- shipment with no ETA yet has not been promised anything, so it
          -- waits at the bottom rather than jumping the queue.
          ORDER BY CASE WHEN IFNULL(eta_sg, '') = '' THEN 1 ELSE 0 END, eta_sg, id DESC`
      ).all(...SHIPMENT_LIVE);
  const counts = db.prepare(
    `SELECT shipment_id, COUNT(*) AS lines, COUNT(DISTINCT po_no) AS pos
       FROM shipment_lines GROUP BY shipment_id`
  ).all();
  const byId = new Map(counts.map((c) => [c.shipment_id, c]));
  return rows.map((r) => {
    const c = byId.get(r.id) || { lines: 0, pos: 0 };
    return { ...shipmentRow(r), lines: c.lines, purchase_orders: c.pos };
  });
}

function getShipment(id) {
  const row = db.prepare("SELECT * FROM shipments WHERE id = ?").get(Number(id));
  if (!row) return null;
  const lines = db.prepare(
    "SELECT * FROM shipment_lines WHERE shipment_id = ? ORDER BY po_no, po_seq, id"
  ).all(row.id);
  return {
    ...shipmentRow(row),
    lines: lines.map((l) => ({
      id: l.id, po_no: l.po_no, po_seq: l.po_seq,
      item_code: l.item_code, description: l.description || "",
      uom: l.uom || "", qty: Number(l.qty) || 0,
      // Null on lines written before this was kept; the screen then shows the
      // plain figure rather than a fraction over nothing.
      po_qty: l.po_qty === null || l.po_qty === undefined ? null : Number(l.po_qty),
    })),
  };
}

// What is already spoken for, per PO line, across the shipments that have not
// arrived yet.
//
// RECEIVED and CANCELLED are excluded on purpose. Once goods are received
// AutoCount's own outstanding figure drops to match, so counting them here as
// well would subtract them twice - and a cancelled shipment never carried
// anything.
//
// exceptShipmentId leaves one shipment out of the sum. That is for the screen
// that is editing that very shipment: its own lines are in front of you on the
// form, and counting them here as well would make a line you put on yourself
// look like a line somebody else had already claimed.
function allocatedByPo(docNos, exceptShipmentId) {
  return sumShipmentLines(docNos, SHIPMENT_LIVE, exceptShipmentId);
}

// What a shipment says has ARRIVED, per PO line.
//
// Iris marks a container received the day it reaches the workshop; the stock
// is keyed into AutoCount afterwards, sometimes days afterwards. In between,
// AutoCount still shows the whole line outstanding and the shipment has left
// the in-transit figure - so without this the goods sitting on the floor read
// as never having been ordered.
//
// This is a physical observation by the person who took delivery, and the
// status uses it as one, alongside AutoCount's.
function receivedByPo(docNos) {
  return sumShipmentLines(docNos, ["RECEIVED"], null);
}

function sumShipmentLines(docNos, statuses, exceptShipmentId) {
  const list = [...new Set((docNos || []).map((d) => String(d || "").trim()).filter(Boolean))];
  const out = new Map();
  if (!list.length || !statuses.length) return out;
  const except = Number(exceptShipmentId);
  const skip = Number.isFinite(except) && except > 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const rows = db.prepare(
      `SELECT l.po_no, l.po_seq, l.item_code, SUM(l.qty) AS qty
         FROM shipment_lines l
         JOIN shipments s ON s.id = l.shipment_id
        WHERE l.po_no IN (${chunk.map(() => "?").join(",")})
          AND s.status IN (${statuses.map(() => "?").join(",")})
          ${skip ? "AND s.id <> ?" : ""}
        GROUP BY l.po_no, l.po_seq, l.item_code`
    ).all(...chunk, ...statuses, ...(skip ? [except] : []));
    for (const r of rows) {
      // Keyed on the LINE, not the item: the same part can sit on two lines of
      // one PO and they are allocated separately.
      out.set(`${r.po_no}#${r.po_seq == null ? "" : r.po_seq}`, Number(r.qty) || 0);
    }
  }
  return out;
}

// Which shipments a PO's goods are on, for the PO screen.
function shipmentsForPo(docNo) {
  return db.prepare(
    `SELECT DISTINCT s.id, s.invoice_no, s.status, s.destination, s.eta_sg, s.eta_dest
       FROM shipment_lines l
       JOIN shipments s ON s.id = l.shipment_id
      WHERE l.po_no = ?
      ORDER BY s.id DESC`
  ).all(String(docNo || "").trim());
}

function normaliseShipment(input = {}) {
  const invoice = String(input.invoice_no || "").trim();
  if (!invoice) { const e = new Error("A shipment needs its supplier invoice number."); e.status = 400; throw e; }
  const status = String(input.status || "SHIPPED").toUpperCase();
  if (!SHIPMENT_STATUSES.has(status)) { const e = new Error("Invalid shipment status."); e.status = 400; throw e; }
  const destination = String(input.destination || "").toUpperCase();
  if (!DESTINATIONS.has(destination)) { const e = new Error("A shipment goes to Joo Seng or Eunos."); e.status = 400; throw e; }
  return {
    invoice_no: invoice.slice(0, 60),
    supplier_code: String(input.supplier_code || "").trim().slice(0, 40),
    supplier_name: String(input.supplier_name || "").trim().slice(0, 120),
    bl_no: String(input.bl_no || "").trim().slice(0, 60),
    container_no: String(input.container_no || "").trim().slice(0, 60),
    status,
    destination,
    eta_sg: cleanDate(input.eta_sg, "ETA Singapore"),
    eta_dest: cleanDate(input.eta_dest, "ETA destination"),
    notes: String(input.notes || "").trim().slice(0, 500),
  };
}

// The lines going on board. A line with no quantity is not on the shipment -
// it is the picker's way of saying "not this one" - so it is dropped rather
// than stored as a zero.
function normaliseLines(lines) {
  const out = [];
  for (const l of (Array.isArray(lines) ? lines : [])) {
    const qty = Number((l || {}).qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const po = String((l || {}).po_no || "").trim();
    const code = String((l || {}).item_code || "").trim();
    if (!po || !code) {
      const e = new Error("Every line needs a purchase order and an item."); e.status = 400; throw e;
    }
    const seq = (l || {}).po_seq;
    const poQty = Number((l || {}).po_qty);
    out.push({
      po_no: po,
      po_seq: seq === null || seq === undefined || seq === "" ? null : Number(seq),
      item_code: code,
      description: String((l || {}).description || "").trim().slice(0, 200),
      uom: String((l || {}).uom || "").trim().slice(0, 20),
      qty,
      po_qty: Number.isFinite(poQty) && poQty > 0 ? poQty : null,
    });
  }
  return out;
}

function writeLines(shipmentId, lines) {
  db.prepare("DELETE FROM shipment_lines WHERE shipment_id = ?").run(shipmentId);
  const ins = db.prepare(
    `INSERT INTO shipment_lines (shipment_id, po_no, po_seq, item_code, description, uom, qty, po_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const l of lines) {
    ins.run(shipmentId, l.po_no, l.po_seq, l.item_code, l.description, l.uom, l.qty, l.po_qty);
  }
}

function createShipment(input = {}, who = "") {
  if (!String(who || "").trim()) { const e = new Error("Missing initials, so the change could not be traced."); e.status = 400; throw e; }
  const v = normaliseShipment(input);
  const lines = normaliseLines(input.lines);
  if (!lines.length) { const e = new Error("A shipment needs at least one line on it."); e.status = 400; throw e; }
  const tx = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO shipments (invoice_no, supplier_code, supplier_name, bl_no, container_no,
                              status, destination, eta_sg, eta_dest, notes, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(v.invoice_no, v.supplier_code, v.supplier_name, v.bl_no, v.container_no,
          v.status, v.destination, v.eta_sg, v.eta_dest, v.notes,
          String(who).trim(), String(who).trim());
    writeLines(r.lastInsertRowid, lines);
    return r.lastInsertRowid;
  });
  return getShipment(tx());
}

// Lines are only replaced when the caller actually sends them. An update that
// is just "it has arrived" must not empty the shipment, and a phone running a
// cached copy of the app is exactly the caller that would send no lines.
function updateShipment(id, input = {}, who = "") {
  const row = db.prepare("SELECT * FROM shipments WHERE id = ?").get(Number(id));
  if (!row) { const e = new Error("Shipment not found."); e.status = 404; throw e; }
  if (!String(who || "").trim()) { const e = new Error("Missing initials, so the change could not be traced."); e.status = 400; throw e; }
  const v = normaliseShipment({ ...shipmentRow(row), ...input });
  const lines = input.lines === undefined ? null : normaliseLines(input.lines);
  if (lines && !lines.length) { const e = new Error("A shipment needs at least one line on it."); e.status = 400; throw e; }
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE shipments SET invoice_no = ?, supplier_code = ?, supplier_name = ?,
                            bl_no = ?, container_no = ?, status = ?,
                            destination = ?, eta_sg = ?, eta_dest = ?, notes = ?,
                            updated_by = ?, updated_at = datetime('now','localtime')
        WHERE id = ?`
    ).run(v.invoice_no, v.supplier_code, v.supplier_name, v.bl_no, v.container_no,
          v.status, v.destination, v.eta_sg, v.eta_dest, v.notes,
          String(who).trim(), row.id);
    if (lines) writeLines(row.id, lines);
  });
  tx();
  return getShipment(row.id);
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
  "RECEIVED", "AWAITING_QUOTE", "QUOTED", "TO_REPAIR", "REPAIRED", "CONDEMNED",
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
// The two statuses a PERSON sets, at the end of the slip's life. Everything
// before them is worked out from the machines; these are not, because nothing
// in this app can see AutoCount's invoice or the customer's car.
const MANUAL_SLIP_STATUSES = new Set(["INVOICED", "CLOSED"]);

function deriveSlipStatus(slipId) {
  const slip = db.prepare("SELECT * FROM service_slips WHERE id = ?").get(slipId);
  // Both of these are deliberate acts by sales, and a later edit to a machine
  // must not quietly undo one. A slip that has been invoiced stays invoiced
  // even if somebody corrects a part on it afterwards.
  if (!slip || MANUAL_SLIP_STATUSES.has(slip.status)) return;
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
  } else if (ms.every(machineSettled)) {
    next = "CONVERTED";                                // everything dealt with
  } else if (any((m) => m.converted_at)) {
    // Some of it is on a Sales Order. Which of the two this is depends on
    // whether the workshop still has something to do:
    //
    //   All Repaired   every machine is finished or gone, and some are billed.
    //                  Nothing left for a technician; sales are mid-way through
    //                  raising the orders.
    //   Partial SO     a machine is still on the bench. Technicians keep the
    //                  slip on their list, and sales can still find it to
    //                  record the document for the batch that HAS gone out.
    //
    // Both of these sit ABOVE the condemned check below. Slip 00007 is why: it
    // had four machines on an order and two condemned ones nobody had signed
    // off, so it read "In Progress" and sales could not find it to invoice the
    // order they had already raised. A condemned machine still in the building
    // is not forgotten by this - closing refuses until it is accounted for.
    next = ms.every((m) => m.state === "REPAIRED" || machineSettled(m))
      ? "ALL_REPAIRED"
      : "PART_SO";
  } else if (any((m) => m.state === "CONDEMNED" && !String(m.disposal || "").trim())) {
    // A condemned machine nobody has accounted for is still in the workshop and
    // still someone's job. With nothing billed there is no order to chase, so
    // the honest answer is that work is outstanding.
    next = "IN_PROGRESS";
  } else if (ms.every((m) => m.state === "REPAIRED" || machineSettled(m))) {
    // The workshop is finished and nothing has been billed yet. Its own status
    // rather than ALL_REPAIRED, which means "some of it is already on an
    // order" and is filtered out of the technicians' working list - a slip
    // that vanished the moment the last machine was ticked would leave a
    // mis-tick with no way back.
    next = "REPAIRED";
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

// A technician has pressed Save on a machine. If that machine was simply being
// worked on, it is now repaired.
//
// The states this WILL move: RECEIVED (came in, nobody has decided anything)
// and TO_REPAIR (the customer said go ahead). Those are the two that mean "in
// the workshop, being worked on", and finishing them is what Save means.
//
// The states it deliberately leaves alone, because moving them would lose a
// fact somebody else is waiting on:
//
//   AWAITING_QUOTE  sales have to ring the customer. Marking it repaired takes
//                   the slip off their Need to Quote list and nobody rings.
//   QUOTED          the customer has not said yes yet. Work may be recorded
//                   against it - a technician stripping it down to price the
//                   job - and that is not the same as the job being done.
//   CONDEMNED       the machine is beyond repair. Saving a note on it does not
//                   change that.
//   REPAIRED        already there.
//
// And it will not move a machine with NOTHING recorded on it. Opening a
// machine, pressing Save and walking away is not a repair, and a machine
// marked repaired with no parts, no labour and no note is a machine nobody
// can account for later.
//
// Returns { slip, moved } - moved says whether to tell the technician
// anything, since Save is pressed far more often than a machine is finished.
const AUTO_REPAIR_FROM = new Set(["RECEIVED", "TO_REPAIR"]);

function finishRepair(machineId, who = "") {
  const machine = db.prepare("SELECT * FROM slip_machines WHERE id = ?").get(machineId);
  if (!machine) { const e = new Error("Machine not found."); e.status = 404; throw e; }
  const slip = db.prepare("SELECT * FROM service_slips WHERE id = ?").get(machine.slip_id);
  if (!slip) { const e = new Error("Service slip not found."); e.status = 404; throw e; }

  const blocked =
    slip.status === "CLOSED" ||
    !!String(machine.converted_at || "").trim() ||
    !AUTO_REPAIR_FROM.has(machine.state) ||
    !machineHasWork(machine.id);
  if (blocked) return { slip: getSlip(slip.slip_number), moved: false };

  return { slip: setMachineState(slip.slip_number, machine.id, "REPAIRED", who), moved: true };
}

// Something to show for the visit: a part, a labour charge, or a note. Same
// three things slipHasWork asks about, for one machine.
function machineHasWork(machineId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM slip_machines m
      WHERE m.id = ?
        AND (IFNULL(m.labour_charge, 0) > 0
             OR TRIM(IFNULL(m.repair_comment, '')) != ''
             OR EXISTS (SELECT 1 FROM machine_parts p WHERE p.machine_id = m.id))`
  ).get(machineId).n > 0;
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
  poTracking, poStatus, setPoStatus, PO_STATUSES,
  listShipments, getShipment, createShipment, updateShipment,
  allocatedByPo, receivedByPo, shipmentsForPo, SHIPMENT_STATUSES, DESTINATIONS,
  createSlip, listSlips, searchSlips, getSlip, getSlipSignature, addPartToMachine, setPartQuantity, setPartPrice, setPartDescription, isFreeTextPart, setMachineComment, setMachineLabour, updateSlipDetails, setMachineState, setAllMachineStates, finishRepair, setMachineDisposal, deriveSlipStatus, techniciansForMachine, setSlipInvoiced, slipOrderRefs, createSlipOrder, getSlipOrder, getSlipOrders, setOrderAutocountDocNo, setOrderAutocountError, ordersAwaitingAutoCount, renameOrder, setSlipDrive, closeSlip,
};

// ---- One-off: read the status of every open slip again ---------------------
//
// "Partial SO" is new, and a slip only re-derives its status when something on
// it changes. Without this, slip 00007 would go on saying "In Progress" until
// somebody touched a machine on it, and sales still could not find it to
// invoice the order they had already raised.
//
// Here rather than in db.js, which is where it was first written: db.js is
// required BY this file, so requiring this file back from there hands it a
// half-built module and the call quietly does nothing. Node says so - "
// Accessing non-existent property 'slips' of module exports inside circular
// dependency" - and it is the kind of warning that scrolls past. It ran, it
// changed nothing, and the slip stayed lost.
//
// Guarded on there being no PART_SO row yet, so it happens once. CLOSED and
// INVOICED are never recomputed: those are a person's word about something
// outside this app.
try {
  const already = db.prepare("SELECT 1 FROM service_slips WHERE status = 'PART_SO' LIMIT 1").get();
  if (!already) {
    const open = db.prepare(
      "SELECT id FROM service_slips WHERE status NOT IN ('CLOSED', 'INVOICED')"
    ).all();
    let moved = 0;
    for (const r of open) {
      const before = db.prepare("SELECT status FROM service_slips WHERE id = ?").get(r.id).status;
      deriveSlipStatus(r.id);
      const after = db.prepare("SELECT status FROM service_slips WHERE id = ?").get(r.id).status;
      if (before !== after) moved++;
    }
    if (moved) console.log(`[db] re-read the status of ${moved} open slip(s)`);
  }
} catch (e) {
  console.error("[db] slip status re-read failed:", e.message);
}

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

