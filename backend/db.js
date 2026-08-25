// db.js — SQLite database setup + schema (Phase 1, local dev only)
//
// Uses better-sqlite3 when available (recommended; installs cleanly on Windows).
// Falls back to Node's built-in node:sqlite if the native module isn't present,
// so the app still runs without a compile step. Both expose the same tiny
// interface used by server.js: db.exec(), db.prepare(sql).{run,get,all}(),
// and db.transaction(fn).

const path = require("path");
const DB_PATH = path.join(__dirname, "om_orders.db");

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
    converted_at   TEXT,                    -- when this machine went onto a Sales Order
    so_number      TEXT    DEFAULT '',      -- which Sales Order it went onto
    repair_comment TEXT    DEFAULT '',
    labour_charge  REAL    DEFAULT 0,     -- technician labour billed for this machine
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
    FOREIGN KEY (slip_id) REFERENCES service_slips(id) ON DELETE CASCADE
  );
`);

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
    created_at    TEXT DEFAULT (datetime('now', 'localtime')),
    ordered_at    TEXT
  )
`);

module.exports = db;
