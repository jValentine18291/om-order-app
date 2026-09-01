// db.js — SQLite database setup + schema (Phase 1, local dev only)
//
// Uses better-sqlite3 when available (recommended; installs cleanly on Windows).
// Falls back to Node's built-in node:sqlite if the native module isn't present,
// so the app still runs without a compile step. Both expose the same tiny
// interface used by server.js: db.exec(), db.prepare(sql).{run,get,all}(),
// and db.transaction(fn).

const path = require("path");
// The live database, unless something deliberately points elsewhere. The
// override exists so a change can be tried against a COPY of real data before
// it is let anywhere near the real thing; the service sets no such variable,
// so on the server this is exactly the path it always was.
const DB_PATH = process.env.OM_DB_PATH || path.join(__dirname, "om_orders.db");

let db;

try {
  // ---- Preferred: better-sqlite3 -----------------------------------------
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  console.log("[db] using better-sqlite3");
} catch (err) {
  // ---- Fallback: node:sqlite (built into Node 22+) -----------------------
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(DB_PATH);
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");

  // Adapter so server.js code is identical for both drivers.
  db = {
    exec: (sql) => raw.exec(sql),
    pragma: (p) => raw.exec("PRAGMA " + p + ";"),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...args) => {
          const r = stmt.run(...args);
          return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
        },
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      };
    },
    transaction: (fn) => {
      return (...args) => {
        raw.exec("BEGIN");
        try {
          const result = fn(...args);
          raw.exec("COMMIT");
          return result;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      };
    },
  };
  console.log("[db] using built-in node:sqlite (fallback)");
}

// ---- Schema ----------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code     TEXT    NOT NULL UNIQUE,
    barcode       TEXT    UNIQUE,
    description   TEXT    NOT NULL,
    brand         TEXT,
    uom           TEXT    DEFAULT 'UNIT',
    unit_price    REAL    DEFAULT 0,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    so_number     TEXT    NOT NULL UNIQUE,
    status        TEXT    NOT NULL DEFAULT 'SUBMITTED',
    notes         TEXT,
    total_qty     INTEGER NOT NULL DEFAULT 0,
    total_amount  REAL    NOT NULL DEFAULT 0,
    autocount_doc_no TEXT DEFAULT '',   -- the Sales Order written into AutoCount
    autocount_error  TEXT DEFAULT '',   -- why the last attempt to write it failed
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL,
    item_code     TEXT    NOT NULL,
    description   TEXT    NOT NULL,
    uom           TEXT    DEFAULT 'UNIT',
    unit_price    REAL    DEFAULT 0,
    quantity      INTEGER NOT NULL,
    line_amount   REAL    NOT NULL DEFAULT 0,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS counters (
    name          TEXT    PRIMARY KEY,
    value         INTEGER NOT NULL
  );

  -- ===== Service slip workflow =====
  -- A service slip is created when a customer brings machines in. Parts are
  -- later scanned against each machine; submitting creates a Sales Order.
  -- Status flow: OPEN -> CALL_CUSTOMER (SO created) -> CLOSED (paid/invoiced).
  CREATE TABLE IF NOT EXISTS service_slips (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_number    TEXT    NOT NULL UNIQUE,   -- 5-digit sequential, e.g. '00001'
    company        TEXT    NOT NULL,
    debtor_code    TEXT    DEFAULT '',      -- AutoCount DebtorCode; '' means walk-in
    contact_name   TEXT,
    contact_number TEXT,
    whatsapp_number TEXT DEFAULT '',
    check_service   INTEGER DEFAULT 0,
    quote_first     INTEGER DEFAULT 0,
    notes          TEXT,
    status         TEXT    NOT NULL DEFAULT 'OPEN',  -- OPEN | CALL_CUSTOMER | CLOSED
    closing_ref    TEXT,                       -- DO/CS/INV number entered at close
    created_at     TEXT    DEFAULT (datetime('now')),
    closed_at      TEXT
  );

  -- Machines tagged to a slip (free text — may be non-brand / very old units).
  CREATE TABLE IF NOT EXISTS slip_machines (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_id        INTEGER NOT NULL,
    machine_desc   TEXT    NOT NULL,
    serial_no      TEXT    DEFAULT '',     -- as given by the customer; often blank
    remarks        TEXT    DEFAULT '',     -- what the customer reported at registration
    converted_at   TEXT,                    -- when this machine went onto a Sales Order
    so_number      TEXT    DEFAULT '',      -- which Sales Order it went onto
    repair_comment TEXT    DEFAULT '',
    labour_charge  REAL    DEFAULT 0,     -- technician labour billed for this machine
    -- WHERE THIS MACHINE IS, and the only thing that says so. The slip's own
    -- status is worked out from these; nothing sets it directly except closing.
    --   RECEIVED       in the workshop, nothing decided
    --   AWAITING_QUOTE needs a quotation - Sales to call the customer
    --   QUOTED         quoted, waiting on the customer's answer
    --   TO_REPAIR      go ahead: approved, or no quotation needed
    --   CONDEMNED      the customer does not want it repaired
    state          TEXT    DEFAULT 'RECEIVED',
    -- A condemned machine is still physically here. It is not finished with
    -- until it has gone back to the customer or been scrapped, and a slip
    -- cannot close while one is unaccounted for.
    disposal       TEXT    DEFAULT '',    -- '' | COLLECTED | DISPOSED
    disposal_at    TEXT    DEFAULT '',
    disposal_by    TEXT    DEFAULT '',
    -- Legacy, kept so nothing is lost: these two were the state before it was
    -- one field. Mapped into "state" once, at migration, and never written
    -- again. Read "state".
    quote_status   TEXT    DEFAULT '',
    work_decision  TEXT    DEFAULT '',
    decided_by     TEXT    DEFAULT '',    -- who took the call
    decided_at     TEXT    DEFAULT '',    -- when they took it
    FOREIGN KEY (slip_id) REFERENCES service_slips(id) ON DELETE CASCADE
  );

  -- Parts scanned against a specific machine on a slip. Records who scanned and
  -- the price at time of scan (so later catalogue price changes don't rewrite history).
  CREATE TABLE IF NOT EXISTS machine_parts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id     INTEGER NOT NULL,
    item_code      TEXT    NOT NULL,
    description    TEXT    NOT NULL,
    uom            TEXT    DEFAULT 'UNIT',
    unit_price     REAL    DEFAULT 0,
    quantity       INTEGER NOT NULL DEFAULT 1,
    technician     TEXT,                        -- WJ / XL / KM / R
    free_text      INTEGER DEFAULT 0,           -- 1 = staff name this line themselves
    created_at     TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (machine_id) REFERENCES slip_machines(id) ON DELETE CASCADE
  );

  -- NOTE: part_prices is retired. The three tiers turned out to be in
  -- AutoCount after all (ItemUOM.Price1 = Contractor, Price6 = List), so the
  -- app reads them from there and no longer stores or edits prices. The table
  -- is left in place so no existing database loses rows on upgrade; nothing
  -- reads it, and it can be dropped once you are happy.
  CREATE TABLE IF NOT EXISTS part_prices (
    item_code        TEXT    PRIMARY KEY,
    list_price       REAL,
    contractor_price REAL,
    reseller_price   REAL,
    updated_at       TEXT    DEFAULT (datetime('now')),
    updated_by       TEXT    DEFAULT ''
  );

  -- Customer signature captured on the phone at registration, stored as a PNG
  -- data URL and drawn onto the service-slip PDF.
  --
  -- Deliberately a separate table rather than a column on service_slips: the
  -- slip list and search queries all use SELECT *, so a column here would ship
  -- every signature image in every list response. Kept apart, only getSlip
  -- pays for it.
  CREATE TABLE IF NOT EXISTS slip_signatures (
    slip_id    INTEGER PRIMARY KEY,
    image      TEXT    NOT NULL,
    signed_at  TEXT    DEFAULT (datetime('now')),
    -- What the customer was actually looking at when they signed, as JSON.
    -- Without it there is no way to say whether a slip still matches its
    -- signature, only that it might not.
    signed_content TEXT DEFAULT '',
    FOREIGN KEY (slip_id) REFERENCES service_slips(id) ON DELETE CASCADE
  );

  -- Every change made to a slip after the customer signed it. The signature
  -- attests to what was on the page at the time; anything altered afterwards
  -- has to travel with the document, or the signature starts covering things
  -- nobody agreed to.
  CREATE TABLE IF NOT EXISTS slip_amendments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_id    INTEGER NOT NULL,
    field      TEXT NOT NULL,          -- "Company", "Zenoah G3800 serial", ...
    before     TEXT DEFAULT '',
    after      TEXT DEFAULT '',
    changed_by TEXT DEFAULT '',
    changed_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (slip_id) REFERENCES service_slips(id) ON DELETE CASCADE
  );
`);

// Migration: signed_content on slips that predate it.
//
// Backfilled from the slip AS IT STANDS NOW. That is an assumption, and it is
// stated rather than hidden: slip editing shipped days before this, so any
// slip here has almost certainly never been edited. Where it has, the
// snapshot records the edited state as the signed one - which is why the
// amendment log starts from this point rather than pretending to be complete.
try {
  const cols = db.prepare("PRAGMA table_info(slip_signatures)").all().map((c) => c.name);
  if (!cols.includes("signed_content")) {
    db.exec("ALTER TABLE slip_signatures ADD COLUMN signed_content TEXT DEFAULT ''");
    const slips = db.prepare(
      "SELECT s.id, s.company, s.contact_name, s.contact_number, s.whatsapp_number, s.notes " +
      "FROM service_slips s JOIN slip_signatures g ON g.slip_id = s.id"
    ).all();
    const machinesOf = db.prepare(
      "SELECT machine_desc, serial_no, remarks FROM slip_machines WHERE slip_id = ? ORDER BY id"
    );
    const upd = db.prepare("UPDATE slip_signatures SET signed_content = ? WHERE slip_id = ?");
    for (const s of slips) {
      upd.run(JSON.stringify({
        company: s.company || "", contact_name: s.contact_name || "",
        contact_number: s.contact_number || "", whatsapp_number: s.whatsapp_number || "",
        notes: s.notes || "",
        machines: machinesOf.all(s.id).map((m) => ({
          machine_desc: m.machine_desc || "", serial_no: m.serial_no || "", remarks: m.remarks || "",
        })),
        backfilled: true,
      }), s.id);
    }
    if (slips.length) {
      console.log(`[db] migrated: recorded what was signed for ${slips.length} existing slip(s)`);
    }
  }
} catch (e) {
  console.error("[db] signed_content migration check failed:", e.message);
}

db.prepare(
  "INSERT OR IGNORE INTO counters (name, value) VALUES ('slip_number', 0)"
).run();

// Migration: add repair_comment to slip_machines if an older DB lacks it.
// (CREATE TABLE IF NOT EXISTS won't alter an existing table, so do it explicitly.)
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  const hasComment = cols.some((c) => c.name === "repair_comment");
  if (!hasComment) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN repair_comment TEXT DEFAULT ''");
    console.log("[db] migrated: added repair_comment to slip_machines");
  }
} catch (e) {
  console.error("[db] repair_comment migration check failed:", e.message);
}

// Migration: why an order failed to reach AutoCount. A transient toast is no
// way to report a failed write to the accounts - the reason has to survive.
try {
  const cols = db.prepare("PRAGMA table_info(orders)").all();
  if (!cols.some((c) => c.name === "autocount_error")) {
    db.exec("ALTER TABLE orders ADD COLUMN autocount_error TEXT DEFAULT ''");
    console.log("[db] migrated: added autocount_error to orders");
  }
} catch (e) {
  console.error("[db] autocount_error migration check failed:", e.message);
}

// Migration: which AutoCount Sales Order an app order was written to. Blank
// means it has not reached AutoCount yet, which is what a retry looks for.
try {
  const cols = db.prepare("PRAGMA table_info(orders)").all();
  if (!cols.some((c) => c.name === "autocount_doc_no")) {
    db.exec("ALTER TABLE orders ADD COLUMN autocount_doc_no TEXT DEFAULT ''");
    console.log("[db] migrated: added autocount_doc_no to orders");
  }
} catch (e) {
  console.error("[db] autocount_doc_no migration check failed:", e.message);
}

// Migration: the AutoCount debtor code behind the company name. A Sales Order
// header cannot be written without it, and the name alone is not enough - two
// customers can share a trading name, and staff can type anything.
try {
  const cols = db.prepare("PRAGMA table_info(service_slips)").all();
  if (!cols.some((c) => c.name === "debtor_code")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN debtor_code TEXT DEFAULT ''");
    console.log("[db] migrated: added debtor_code to service_slips");
  }
} catch (e) {
  console.error("[db] debtor_code migration check failed:", e.message);
}

// Migration: per-machine Sales Order tracking. A slip is converted one machine
// at a time, so each row records when it went onto an order and which order.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  if (!cols.some((c) => c.name === "converted_at")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN converted_at TEXT");
    console.log("[db] migrated: added converted_at to slip_machines");
  }
  if (!cols.some((c) => c.name === "so_number")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN so_number TEXT DEFAULT ''");
    console.log("[db] migrated: added so_number to slip_machines");
  }
} catch (e) {
  console.error("[db] machine conversion migration check failed:", e.message);
}

// Migration: add serial_no to slip_machines if an older DB lacks it. Existing
// machines simply have no serial, which is also the everyday case for the ones
// that never had one stamped.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  if (!cols.some((c) => c.name === "serial_no")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN serial_no TEXT DEFAULT ''");
    console.log("[db] migrated: added serial_no to slip_machines");
  }
} catch (e) {
  console.error("[db] serial_no migration check failed:", e.message);
}

// Migration: quoting is per machine, not per slip. A slip with two machines is
// routinely half finished - one repaired and ready to price, one still in
// pieces - and the slip-level status could not say so.
// Blank means "no quote needed"; the two values otherwise are NEED_QUOTE and
// QUOTED.
//
// Slips already waiting for a quote have their machines filled in to match. A
// slip marked before this existed meant every machine on it, so leaving them
// blank would show a slip waiting to be quoted with nothing on it waiting.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  if (!cols.some((c) => c.name === "quote_status")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN quote_status TEXT DEFAULT ''");
    const back = db.prepare(
      `UPDATE slip_machines SET quote_status = (
         SELECT status FROM service_slips WHERE id = slip_machines.slip_id
       )
       WHERE slip_id IN (SELECT id FROM service_slips WHERE status IN ('NEED_QUOTE','QUOTED'))`
    ).run();
    console.log(`[db] migrated: added quote_status to slip_machines (${back.changes} existing machine(s) filled in)`);
  }
} catch (e) {
  console.error("[db] quote_status migration check failed:", e.message);
}

// Migration: whether a part line is one staff describe themselves.
//
// It is RECORDED rather than worked out each time, because the answer can
// depend on the description - and the first thing someone does is replace that
// description with what the part really was. Deriving it live would make the
// line stop being editable the moment it was edited.
try {
  const cols = db.prepare("PRAGMA table_info(machine_parts)").all().map((c) => c.name);
  if (!cols.includes("free_text")) {
    db.exec("ALTER TABLE machine_parts ADD COLUMN free_text INTEGER DEFAULT 0");
    // Existing rows: judged by their code, which is how they were judged when
    // they were entered.
    const n = db.prepare(
      `UPDATE machine_parts SET free_text = 1
        WHERE UPPER(TRIM(item_code)) LIKE 'MISC%'
           OR UPPER(TRIM(item_code)) LIKE 'A5 %' OR UPPER(TRIM(item_code)) = 'A5'
           OR UPPER(TRIM(item_code)) LIKE 'A6 %' OR UPPER(TRIM(item_code)) = 'A6'
           OR UPPER(TRIM(item_code)) LIKE 'A7 %' OR UPPER(TRIM(item_code)) = 'A7'
           OR UPPER(TRIM(item_code)) LIKE 'A8 %' OR UPPER(TRIM(item_code)) = 'A8'`
    ).run();
    console.log(`[db] migrated: added free_text to machine_parts (${n.changes} existing line(s) marked)`);
  }
} catch (e) {
  console.error("[db] machine_parts free_text migration check failed:", e.message);
}

// Migration: fold quote_status and work_decision into one state.
//
// Two fields describing one thing is how a machine ends up quoted AND awaiting
// a quote at the same time. The mapping is faithful - a decision outranks a
// quoting step, because it came later - and the old columns are left in place
// so nothing is thrown away.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all().map((c) => c.name);
  const add = (name, type) => { if (!cols.includes(name)) db.exec(`ALTER TABLE slip_machines ADD COLUMN ${name} ${type}`); };
  if (!cols.includes("state")) {
    add("state", "TEXT DEFAULT 'RECEIVED'");
    add("disposal", "TEXT DEFAULT ''");
    add("disposal_at", "TEXT DEFAULT ''");
    add("disposal_by", "TEXT DEFAULT ''");
    const n = db.prepare(
      `UPDATE slip_machines SET state = CASE
         WHEN work_decision = 'CONDEMN'    THEN 'CONDEMNED'
         WHEN work_decision = 'REPAIR'     THEN 'TO_REPAIR'
         WHEN quote_status  = 'NEED_QUOTE' THEN 'AWAITING_QUOTE'
         WHEN quote_status  = 'QUOTED'     THEN 'QUOTED'
         ELSE 'RECEIVED' END`
    ).run();
    console.log(`[db] migrated: one state per machine (${n.changes} machine(s) mapped)`);
  } else {
    add("disposal", "TEXT DEFAULT ''");
    add("disposal_at", "TEXT DEFAULT ''");
    add("disposal_by", "TEXT DEFAULT ''");
  }
} catch (e) {
  console.error("[db] machine state migration check failed:", e.message);
}

// Migration: what the customer reported about each machine at registration
// ("won't start", "chain keeps slipping"). Distinct from repair_comment, which
// is the technician's account of what was done.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all().map((c) => c.name);
  if (!cols.includes("remarks")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN remarks TEXT DEFAULT ''");
    console.log("[db] migrated: added remarks to slip_machines");
  }
} catch (e) {
  console.error("[db] slip_machines remarks migration check failed:", e.message);
}

// Migration: what the customer decided once Sales rang them about a quote.
// Kept separate from quote_status, which says where the machine is in the
// quoting process; this says what the answer was. A machine can be QUOTED with
// no decision yet - Sales have priced it and are waiting for the customer.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all().map((c) => c.name);
  const adds = [
    ["work_decision", "TEXT DEFAULT ''"],
    ["decided_by", "TEXT DEFAULT ''"],
    ["decided_at", "TEXT DEFAULT ''"],
  ].filter(([name]) => !cols.includes(name));
  for (const [name, type] of adds) {
    db.exec(`ALTER TABLE slip_machines ADD COLUMN ${name} ${type}`);
  }
  if (adds.length) {
    console.log(`[db] migrated: added ${adds.map(([n]) => n).join(", ")} to slip_machines`);
  }
} catch (e) {
  console.error("[db] work_decision migration check failed:", e.message);
}

// Migration: add labour_charge to slip_machines if an older DB lacks it.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  if (!cols.some((c) => c.name === "labour_charge")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN labour_charge REAL DEFAULT 0");
    console.log("[db] migrated: added labour_charge to slip_machines");
  }
} catch (e) {
  console.error("[db] labour_charge migration check failed:", e.message);
}

// Migration: add whatsapp_number to service_slips if an older DB lacks it.
try {
  const cols = db.prepare("PRAGMA table_info(service_slips)").all();
  const hasWa = cols.some((c) => c.name === "whatsapp_number");
  if (!hasWa) {
    db.exec("ALTER TABLE service_slips ADD COLUMN whatsapp_number TEXT DEFAULT ''");
    console.log("[db] migrated: added whatsapp_number to service_slips");
  }
} catch (e) {
  console.error("[db] whatsapp_number migration check failed:", e.message);
}

// Migration: add check_service / quote_first request flags if an older DB lacks them.
try {
  const cols = db.prepare("PRAGMA table_info(service_slips)").all();
  if (!cols.some((c) => c.name === "check_service")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN check_service INTEGER DEFAULT 0");
    console.log("[db] migrated: added check_service to service_slips");
  }
  if (!cols.some((c) => c.name === "quote_first")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN quote_first INTEGER DEFAULT 0");
    console.log("[db] migrated: added quote_first to service_slips");
  }
} catch (e) {
  console.error("[db] request-flags migration check failed:", e.message);
}

// Migration: rename legacy CALL_CUSTOMER status to ALL_REPAIRED (status model v2).
try {
  const n = db.prepare("UPDATE service_slips SET status = 'ALL_REPAIRED' WHERE status = 'CALL_CUSTOMER'").run();
  if (n.changes > 0) console.log("[db] migrated: " + n.changes + " slip(s) CALL_CUSTOMER -> ALL_REPAIRED");
} catch (e) {
  console.error("[db] status migration failed:", e.message);
}

// Reconciliation: ALL_REPAIRED must mean every machine has work recorded.
// Any slip marked ALL_REPAIRED that still has an untouched machine (no parts
// and no repair comment) is knocked back to IN_PROGRESS. Runs at every start,
// so historical inconsistencies self-correct.
try {
  const n = db.prepare(`
    UPDATE service_slips SET status = 'IN_PROGRESS'
    WHERE status = 'ALL_REPAIRED'
      AND id IN (
        SELECT sm.slip_id
        FROM slip_machines sm
        LEFT JOIN machine_parts mp ON mp.machine_id = sm.id
        GROUP BY sm.id
        HAVING COUNT(mp.id) = 0
           AND (sm.repair_comment IS NULL OR TRIM(sm.repair_comment) = '')
      )`).run();
  if (n.changes > 0) console.log("[db] reconciled: " + n.changes + " slip(s) ALL_REPAIRED -> IN_PROGRESS (untouched machines)");
} catch (e) {
  console.error("[db] all-repaired reconciliation failed:", e.message);
}

db.prepare(
  "INSERT OR IGNORE INTO counters (name, value) VALUES ('so_number', 0)"
).run();

// Auto-seed the parts catalogue if it's empty. This matters on cloud hosts
// (e.g. Render free tier) where the filesystem resets — the app re-seeds
// itself on startup so the parts list is always present without a manual step.
const partCount = db.prepare("SELECT COUNT(*) AS n FROM items").get().n;
if (partCount === 0) {
  const parts = [
    ["SZEN 140051111", "140051111", "Shoe Clutch",   "Zenoah", "PCS", 9.50],
    ["SZEN 165151220", "165151220", "Clutch Spring", "Zenoah", "PCS", 2.50],
    ["SZEN 591443601", "591443601", "Clutch Drum",   "Zenoah", "PCS", 19.90],
  ];
  const ins = db.prepare(
    "INSERT INTO items (item_code, barcode, description, brand, uom, unit_price) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const p of parts) ins.run(...p);
  console.log(`[db] auto-seeded ${parts.length} parts`);
}

// Reorder requests raised from the Find Part screen ("Order more"), consumed
// by the Purchaser screen.
db.exec(`
  CREATE TABLE IF NOT EXISTS part_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code     TEXT NOT NULL,
    description   TEXT DEFAULT '',
    qty_requested INTEGER NOT NULL,
    requester     TEXT DEFAULT '',
    status        TEXT DEFAULT 'PENDING',
    remarks       TEXT DEFAULT '',       -- optional note from the requester, per part
    batch_remarks TEXT DEFAULT '',       -- optional note for the whole order (same on every row)
    batch_id      TEXT DEFAULT '',       -- one order = one batch; single parts are a batch of one
    free_text     INTEGER DEFAULT 0,     -- 1 = a placeholder code, named by staff
    stock_at_request REAL,               -- AutoCount balance when the order was made; NULL if unknown
    created_at    TEXT DEFAULT (datetime('now', 'localtime')),
    ordered_at    TEXT
  )
`);

// Migration: remarks and batch_id on part_requests. A bulk order is several
// parts submitted together and reviewed as ONE order, so rows share a batch id;
// a part ordered on its own gets a batch of its own. Existing rows are each
// their own batch, which is what they were.
try {
  const cols = db.prepare("PRAGMA table_info(part_requests)").all().map((c) => c.name);
  if (!cols.includes("remarks")) db.exec("ALTER TABLE part_requests ADD COLUMN remarks TEXT DEFAULT ''");
  if (!cols.includes("batch_remarks")) db.exec("ALTER TABLE part_requests ADD COLUMN batch_remarks TEXT DEFAULT ''");
  // Same reasoning as machine_parts.free_text: the description is the thing
  // staff replace, so a rule derived from it erases its own evidence. Recorded
  // when the line is made; existing rows judged by their code, as they were.
  if (!cols.includes("free_text")) {
    db.exec("ALTER TABLE part_requests ADD COLUMN free_text INTEGER DEFAULT 0");
    db.prepare(
      `UPDATE part_requests SET free_text = 1
        WHERE UPPER(TRIM(item_code)) LIKE 'MISC%'
           OR UPPER(TRIM(item_code)) LIKE 'A5 %' OR UPPER(TRIM(item_code)) = 'A5'
           OR UPPER(TRIM(item_code)) LIKE 'A6 %' OR UPPER(TRIM(item_code)) = 'A6'
           OR UPPER(TRIM(item_code)) LIKE 'A7 %' OR UPPER(TRIM(item_code)) = 'A7'
           OR UPPER(TRIM(item_code)) LIKE 'A8 %' OR UPPER(TRIM(item_code)) = 'A8'`
    ).run();
  }
  // The balance at the moment of ordering. John decided the list should show
  // what the stock WAS when the order was made, not what it is now - the
  // snapshot is the decision's context, and it never needs AutoCount again.
  if (!cols.includes("stock_at_request")) db.exec("ALTER TABLE part_requests ADD COLUMN stock_at_request REAL");
  if (!cols.includes("batch_id")) {
    db.exec("ALTER TABLE part_requests ADD COLUMN batch_id TEXT DEFAULT ''");
    db.exec("UPDATE part_requests SET batch_id = 'R' || id WHERE batch_id = ''");
    console.log("[db] migrated: added remarks and batch_id to part_requests");
  }
} catch (e) {
  console.error("[db] part_requests migration check failed:", e.message);
}

// ---- Notes kept against a part ---------------------------------------------
// Mostly supersessions: "replaced by SZEN 123456789". The knowledge exists in
// people's heads and gets discovered at the worst moment - when the part is
// already on order, or already on a slip.
//
// Keyed on the EXACT AutoCount item code, never a diagram number. A printed
// number does not identify one item: 848BE058B2 matches both SZEN 848BE058B2
// and SZEN 848BE058B2R, which are different parts. The IPL resolves that to a
// single item before anything is shown, and the note hangs off the result.
//
// This is the app's own reference material, so it lives here and NOT in
// AutoCount - no write-back, no permissions to worry about, and it travels
// with the nightly backup like everything else in this file.
db.exec(`
  CREATE TABLE IF NOT EXISTS part_notes (
    item_code  TEXT PRIMARY KEY,        -- exact AutoCount ItemCode
    note       TEXT NOT NULL,
    updated_by TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

module.exports = db;
