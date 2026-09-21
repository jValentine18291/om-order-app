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

// Is this a database that already holds work, or one being created right now?
//
// Asked HERE, before a single CREATE TABLE, because it is the only moment the
// answer is knowable. The timestamp migration at the foot of this file needs
// it: a brand-new database has nothing to convert, and its seeded rows are
// written by the current, local-time defaults - shifting those would put them
// eight hours into the future, which is exactly what the first version of that
// migration did.
const DB_IS_NEW = !db.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'service_slips'"
).get().n;

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
    created_at    TEXT    DEFAULT (datetime('now','localtime'))
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
    created_at    TEXT    DEFAULT (datetime('now','localtime'))
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
    -- What the customer asked for at the counter. All three are printed on
    -- the slip and shown to the technician; none of them constrain what the
    -- app allows. check_service and repair_only are opposites.
    check_service   INTEGER DEFAULT 0,
    repair_only     INTEGER DEFAULT 0,
    quote_first     INTEGER DEFAULT 0,
    notes          TEXT,
    status         TEXT    NOT NULL DEFAULT 'OPEN',  -- OPEN | CALL_CUSTOMER | CLOSED
    -- The staff-only Drive copy of this slip's PDF. The id is kept so a
    -- re-send REPLACES that file rather than adding a second one, which keeps
    -- a link already given to a customer pointing at the current document.
    -- A note about the slip's own parts - the ones belonging to no machine.
    -- INTERNAL. It is shown in the app and never reaches a Sales Order, a
    -- quotation or anything else the customer sees. See slipBlockLines(),
    -- which does not read it, and tools/test-slip-parts.js, which checks it
    -- does not.
    extras_note    TEXT    DEFAULT '',
    drive_file_id  TEXT    DEFAULT '',
    drive_link     TEXT    DEFAULT '',
    closing_ref    TEXT,                       -- DO/CS/INV number, recorded at the invoice step
    -- Who took the machine in. Slips written before this existed have '',
    -- which the app shows as nothing rather than guessing at a name.
    created_by     TEXT    DEFAULT '',
    created_at     TEXT    DEFAULT (datetime('now','localtime')),
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
    -- What AutoCount calls this kind of machine - its ItemCategory, looked up
    -- once when the slip is registered. Only used to NAME the machine on the
    -- documents that leave the building, and only for models that are not on
    -- the list in machine-types.js. Resolved here rather than when a document
    -- is built so a quotation still prints with AutoCount unreachable.
    machine_type   TEXT    DEFAULT '',
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

  -- Parts scanned against a slip. Records who scanned and the price at time of
  -- scan (so later catalogue price changes don't rewrite history).
  --
  -- MOST parts belong to a machine. Some belong to the SLIP and to no machine
  -- at all - something sold alongside the repair rather than fitted to it, a
  -- spare the customer is taking with them. The workshop asked for those in
  -- Sep 2026; before that there was nowhere to put one but on a machine it was
  -- never fitted to, which then billed it under that machine's block.
  --
  -- Exactly ONE of machine_id and slip_id is set on any row. Which one it is
  -- is the whole difference between the two kinds of line, and every query
  -- that wants one kind says so - see partsForSlip() and getSlip().
  CREATE TABLE IF NOT EXISTS machine_parts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id     INTEGER,
    item_code      TEXT    NOT NULL,
    description    TEXT    NOT NULL,
    uom            TEXT    DEFAULT 'UNIT',
    unit_price     REAL    DEFAULT 0,
    -- Declared INTEGER, but SQLite keeps a fraction as-is rather than losing
    -- it, and the PulsFOG tubes need that: they are cut from a roll, so a
    -- repair uses 0.265 of a stock unit, not 1 of anything.
    quantity       INTEGER NOT NULL DEFAULT 1,
    -- Which variant of the item this line is, where one item code covers
    -- several. Only the fogger tubes use it so far: Z00126.03 is four
    -- different tube types at four different prices, and without this the
    -- merge below would fold them into one wrong line.
    variant        TEXT    DEFAULT '',
    technician     TEXT,                        -- WJ / XL / KM / R
    free_text      INTEGER DEFAULT 0,           -- 1 = staff name this line themselves
    created_at     TEXT    DEFAULT (datetime('now','localtime')),
    -- SLIP-LEVEL PARTS ONLY. A machine records where it went on its own row;
    -- these lines have no machine to record it for them, and they must not be
    -- billed twice when a slip is converted a few machines at a time.
    slip_id        INTEGER,
    converted_at   TEXT,
    so_number      TEXT    DEFAULT '',
    FOREIGN KEY (machine_id) REFERENCES slip_machines(id) ON DELETE CASCADE,
    FOREIGN KEY (slip_id)    REFERENCES service_slips(id) ON DELETE CASCADE
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
    updated_at       TEXT    DEFAULT (datetime('now','localtime')),
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
    signed_at  TEXT    DEFAULT (datetime('now','localtime')),
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
  -- Every Repair Quotation that has actually gone out, so the next one for the
  -- same slip can be numbered after it: QT-00040, then QT-00040-2, -3 ...
  --
  -- A row is written only when the quotation DIFFERS from the last one issued.
  -- Technicians add a part they forgot and Sales re-send; that is a revision
  -- and earns a number. Pressing the button twice on the same figures is not,
  -- and must not, or the customer gets two numbers for one quotation and has to
  -- ask which one stands. "fingerprint" is what that comparison is made on.
  CREATE TABLE IF NOT EXISTS slip_quotations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_number TEXT NOT NULL,
    seq         INTEGER NOT NULL,      -- 1, 2, 3 ... ; 1 prints without a suffix
    ref         TEXT NOT NULL,         -- "QT-00040", "QT-00040-2"
    fingerprint TEXT NOT NULL,         -- the lines and terms this quoted
    payment_term  TEXT DEFAULT '',
    delivery_term TEXT DEFAULT '',
    total       REAL DEFAULT 0,
    issued_by   TEXT DEFAULT '',
    issued_at   TEXT DEFAULT (datetime('now','localtime')),
    -- The copy filed in the staff Drive folder. Kept so re-sending the same
    -- quotation replaces its file instead of leaving two.
    drive_file_id TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_slip_quotations_slip ON slip_quotations(slip_number, seq);

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

// Migration: machine_type on slip_machines, for slips registered before the
// documents started saying what kind of machine it is.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  if (cols.length && !cols.some((c) => c.name === "machine_type")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN machine_type TEXT DEFAULT ''");
    console.log("[db] migrated: added machine_type to slip_machines");
  }
} catch (e) {
  console.error("[db] slip_machines.machine_type migration failed:", e.message);
}

// Migration: drive_file_id on slip_quotations. The table shipped a version
// before the Drive folder existed, so a server that has already run it has the
// table without the column.
try {
  const cols = db.prepare("PRAGMA table_info(slip_quotations)").all();
  if (cols.length && !cols.some((c) => c.name === "drive_file_id")) {
    db.exec("ALTER TABLE slip_quotations ADD COLUMN drive_file_id TEXT DEFAULT ''");
    console.log("[db] migrated: added drive_file_id to slip_quotations");
  }
} catch (e) {
  console.error("[db] slip_quotations.drive_file_id migration failed:", e.message);
}

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

// Migration: a note against the slip's own parts.
//
// ONE note for the whole group, the way a machine has one repair comment, and
// INTERNAL - it is never put on a Sales Order or a quotation. Asked for by the
// office: the note they wanted to write is the kind that is for each other
// ("Ah Seng to confirm price"), not for the customer.
try {
  const cols = db.prepare("PRAGMA table_info(service_slips)").all().map((c) => c.name);
  if (cols.length && !cols.includes("extras_note")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN extras_note TEXT DEFAULT ''");
    console.log("[db] migrated: added extras_note to service_slips");
  }
} catch (e) {
  console.error("[db] extras_note migration check failed:", e.message);
}

// Migration: let a part belong to the SLIP rather than to a machine.
//
// This one REBUILDS machine_parts, because machine_id was declared NOT NULL
// and SQLite cannot relax that with ALTER TABLE. Rebuilding is the documented
// way round it and it is done here the documented way: foreign keys off, the
// whole thing in one transaction, keys back on, then asked whether the keys
// still hold. Every existing row is carried across unchanged and comes out
// with slip_id NULL - still a machine's part, exactly as it was.
//
// If anything here throws, the transaction rolls back and the old table is
// still the live one. Take a backup first all the same: backend/backup-db.js.
try {
  const cols = db.prepare("PRAGMA table_info(machine_parts)").all().map((c) => c.name);
  if (cols.length && !cols.includes("slip_id")) {
    const before = db.prepare("SELECT COUNT(*) AS n FROM machine_parts").get().n;

    // Pragmas cannot run inside a transaction, so this sits outside it.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE machine_parts_rebuild (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id     INTEGER,
            item_code      TEXT    NOT NULL,
            description    TEXT    NOT NULL,
            uom            TEXT    DEFAULT 'UNIT',
            unit_price     REAL    DEFAULT 0,
            quantity       INTEGER NOT NULL DEFAULT 1,
            variant        TEXT    DEFAULT '',
            technician     TEXT,
            free_text      INTEGER DEFAULT 0,
            created_at     TEXT    DEFAULT (datetime('now','localtime')),
            slip_id        INTEGER,
            converted_at   TEXT,
            so_number      TEXT    DEFAULT '',
            FOREIGN KEY (machine_id) REFERENCES slip_machines(id) ON DELETE CASCADE,
            FOREIGN KEY (slip_id)    REFERENCES service_slips(id) ON DELETE CASCADE
          );
        `);
        // Columns named rather than SELECT *, so the copy does not depend on
        // the order they happen to be in.
        db.exec(`
          INSERT INTO machine_parts_rebuild
            (id, machine_id, item_code, description, uom, unit_price, quantity,
             variant, technician, free_text, created_at)
          SELECT id, machine_id, item_code, description, uom, unit_price, quantity,
                 variant, technician, free_text, created_at
            FROM machine_parts;
        `);
        db.exec("DROP TABLE machine_parts;");
        db.exec("ALTER TABLE machine_parts_rebuild RENAME TO machine_parts;");
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }

    const after = db.prepare("SELECT COUNT(*) AS n FROM machine_parts").get().n;
    // Said out loud rather than assumed. A rebuild that silently lost rows is
    // a repair history nobody can get back.
    if (after !== before) {
      console.error(`[db] machine_parts rebuild MOVED ${before} rows but found ${after} - tell somebody`);
    } else {
      console.log(`[db] migrated: machine_parts can hold slip-level parts (${after} row(s) carried across)`);
    }
    const broken = db.prepare("PRAGMA foreign_key_check(machine_parts)").all();
    if (broken.length) {
      console.error(`[db] machine_parts rebuild left ${broken.length} broken reference(s) - tell somebody`);
    }
  }
} catch (e) {
  console.error("[db] machine_parts slip_id migration failed:", e.message);
}

// Migration: remember where each slip's PDF lives in Drive.
try {
  const cols = db.prepare("PRAGMA table_info(service_slips)").all().map((c) => c.name);
  if (!cols.includes("drive_file_id")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN drive_file_id TEXT DEFAULT ''");
    db.exec("ALTER TABLE service_slips ADD COLUMN drive_link TEXT DEFAULT ''");
    console.log("[db] migrated: added drive_file_id / drive_link to service_slips");
  }
} catch (e) {
  console.error("[db] drive column check failed:", e.message);
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
  // "Repair only" - fix what is broken, do not service the machine. The
  // counterpart to check_service, and like it, an instruction printed for the
  // technician rather than a rule the app enforces.
  if (!cols.some((c) => c.name === "repair_only")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN repair_only INTEGER DEFAULT 0");
    console.log("[db] migrated: added repair_only to service_slips");
  }
  if (!cols.some((c) => c.name === "created_by")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN created_by TEXT DEFAULT ''");
    console.log("[db] migrated: added created_by to service_slips");
  }
} catch (e) {
  console.error("[db] request-flags migration check failed:", e.message);
}

// The DO/CS/INV number now belongs to the SALES ORDER, not the slip.
//
// A slip is converted a machine at a time, so it can carry several orders -
// the customer collects two machines now and two next week - and each order
// becomes its own document in AutoCount. One field on the slip could only hold
// one of them, and recording the second silently overwrote the first.
//
// Existing slips are carried across: where a slip has exactly one order, its
// number moves onto that order, so nothing recorded before today is lost. The
// slip keeps its own column for those and for slips whose orders cannot be
// told apart.
try {
  const cols = db.prepare("PRAGMA table_info(orders)").all();
  if (cols.length && !cols.some((c) => c.name === "closing_ref")) {
    db.exec("ALTER TABLE orders ADD COLUMN closing_ref TEXT DEFAULT ''");
    db.exec("ALTER TABLE orders ADD COLUMN invoiced_at TEXT");
    db.exec("ALTER TABLE orders ADD COLUMN invoiced_by TEXT DEFAULT ''");
    console.log("[db] migrated: added closing_ref/invoiced_at/invoiced_by to orders");

    // Move what is already recorded onto the one order it can only have meant.
    //
    // Only when the slip columns it reads are there. On a fresh database this
    // block runs before the migration that adds them, and there is nothing to
    // carry across anyway - it is the servers with history that need it.
    const slipCols = db.prepare("PRAGMA table_info(service_slips)").all().map((c) => c.name);
    const moved = !slipCols.includes("invoiced_at") ? { changes: 0 } : db.prepare(
      `UPDATE orders SET
         closing_ref = (SELECT s.closing_ref FROM service_slips s
                         WHERE 'S/S: ' || s.slip_number = orders.notes),
         invoiced_at = (SELECT s.invoiced_at FROM service_slips s
                         WHERE 'S/S: ' || s.slip_number = orders.notes),
         invoiced_by = (SELECT s.invoiced_by FROM service_slips s
                         WHERE 'S/S: ' || s.slip_number = orders.notes)
       WHERE EXISTS (SELECT 1 FROM service_slips s
                      WHERE 'S/S: ' || s.slip_number = orders.notes
                        AND TRIM(IFNULL(s.closing_ref, '')) != '')
         AND (SELECT COUNT(*) FROM orders o2 WHERE o2.notes = orders.notes) = 1`
    ).run();
    if (moved.changes) console.log(`[db] migrated: ${moved.changes} invoice reference(s) moved onto their Sales Order`);
  }
} catch (e) {
  console.error("[db] orders invoice migration check failed:", e.message);
}

// When sales recorded the DO/CS/INV against a slip, and who did.
//
// The slip's own lifecycle now has a step between "on a sales order" and
// "collected": sales convert the SO to a DO/INV/CS in AutoCount, and only
// after that does anyone ring the customer to come and collect. The reference
// itself still lives in closing_ref - it is the same number, recorded earlier
// than it used to be, and two columns for one number is two that disagree.
try {
  const cols = db.prepare("PRAGMA table_info(service_slips)").all();
  if (cols.length && !cols.some((c) => c.name === "invoiced_at")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN invoiced_at TEXT");
    db.exec("ALTER TABLE service_slips ADD COLUMN invoiced_by TEXT DEFAULT ''");
    console.log("[db] migrated: added invoiced_at/invoiced_by to service_slips");
  }
  if (cols.length && !cols.some((c) => c.name === "closed_by")) {
    db.exec("ALTER TABLE service_slips ADD COLUMN closed_by TEXT DEFAULT ''");
    console.log("[db] migrated: added closed_by to service_slips");
  }
} catch (e) {
  console.error("[db] service_slips invoice migration check failed:", e.message);
}

// Who a shipment is from. Shipments entered before this simply have none.
try {
  const cols = db.prepare("PRAGMA table_info(shipments)").all();
  if (cols.length && !cols.some((c) => c.name === "supplier_code")) {
    db.exec("ALTER TABLE shipments ADD COLUMN supplier_code TEXT DEFAULT ''");
    db.exec("ALTER TABLE shipments ADD COLUMN supplier_name TEXT DEFAULT ''");
    console.log("[db] migrated: added supplier to shipments");
  }
} catch (e) {
  console.error("[db] shipments supplier migration check failed:", e.message);
}

// The ordered quantity behind a shipment line, so it can read "1/2". Lines
// written before this simply have none and show the plain figure.
try {
  const cols = db.prepare("PRAGMA table_info(shipment_lines)").all();
  if (cols.length && !cols.some((c) => c.name === "po_qty")) {
    db.exec("ALTER TABLE shipment_lines ADD COLUMN po_qty REAL");
    console.log("[db] migrated: added po_qty to shipment_lines");
  }
} catch (e) {
  console.error("[db] shipment_lines po_qty migration check failed:", e.message);
}

// Which variant of an item a part line is - the PulsFOG tube type. Existing
// lines get '', which is what every non-tube part uses too, so the merge
// behaves exactly as it did before for everything already recorded.
try {
  const cols = db.prepare("PRAGMA table_info(machine_parts)").all();
  if (!cols.some((c) => c.name === "variant")) {
    db.exec("ALTER TABLE machine_parts ADD COLUMN variant TEXT DEFAULT ''");
    console.log("[db] migrated: added variant to machine_parts");
  }
} catch (e) {
  console.error("[db] machine_parts variant migration check failed:", e.message);
}

// The AutoCount item this machine is, when it was picked from the catalogue
// rather than typed. Machine units are the U-prefixed codes - UHUQ, UZEN,
// UPUL. Blank for anything typed by hand, which stays perfectly valid: plenty
// of machines through the workshop are not ours to begin with.
try {
  const cols = db.prepare("PRAGMA table_info(slip_machines)").all();
  if (!cols.some((c) => c.name === "machine_code")) {
    db.exec("ALTER TABLE slip_machines ADD COLUMN machine_code TEXT DEFAULT ''");
    console.log("[db] migrated: added machine_code to slip_machines");
  }
} catch (e) {
  console.error("[db] slip_machines machine_code migration check failed:", e.message);
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
  -- Whether a Purchase Order has actually been SENT to the supplier.
  --
  -- AutoCount has no idea: Iris raises the PO there, consolidates it, and then
  -- emails it herself, and nothing about that email reaches the accounts. So
  -- the one fact nobody else holds is kept here, against AutoCount's own
  -- document number.
  --
  -- A PO with no row here is "not ordered yet". That way the table only ever
  -- holds the ones something has happened to, and a PO raised in AutoCount
  -- this afternoon needs nothing doing to appear correctly.
  CREATE TABLE IF NOT EXISTS po_tracking (
    doc_no     TEXT PRIMARY KEY,        -- AutoCount's PO number, exactly
    status     TEXT NOT NULL DEFAULT 'NOT_ORDERED',
    ordered_at TEXT,                    -- when Iris said she had sent it
    updated_by TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- A shipment: the thing that actually travels, and the only thing with a
  -- date on it.
  --
  -- Goods do not arrive by purchase order. One shipment carries parts of
  -- several POs, and one PO arrives across several shipments, so hanging an
  -- ETA on a PO would be hanging it on the wrong noun. Everything about where
  -- goods are lives here; the PO keeps only whether it was sent.
  --
  -- Known by the SUPPLIER'S INVOICE NUMBER, which is what people say out loud.
  -- It is not the key, though: two suppliers can both send an INV-001, and a
  -- mistyped one has to be correctable without orphaning the lines already
  -- attached to it. Hence an id nobody ever sees.
  CREATE TABLE IF NOT EXISTS shipments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no   TEXT NOT NULL,
    -- Who it is from. A shipment is one invoice from one supplier, so this is
    -- what narrows the purchase orders down when the lines are picked. Both
    -- the code and the readable name are kept: the code is what matches a PO,
    -- the name is what anyone reading the screen recognises.
    supplier_code TEXT DEFAULT '',
    supplier_name TEXT DEFAULT '',
    bl_no        TEXT DEFAULT '',       -- sea freight; air has none
    container_no TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'SHIPPED',
    destination  TEXT DEFAULT '',       -- JOO_SENG | EUNOS, never both
    eta_sg       TEXT,                  -- yyyy-mm-dd, or null when not known yet
    eta_dest     TEXT,
    notes        TEXT DEFAULT '',
    created_by   TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now','localtime')),
    updated_by   TEXT DEFAULT '',
    updated_at   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Which PO lines are on board, and how many of each.
  --
  -- po_seq is AutoCount's own line sequence and is what makes this precise: a
  -- PO can carry the same item twice, at two prices, and "40 of SZEN 848BE058B2
  -- from PO-0418" would not say which.
  --
  -- The item code and description are copied rather than looked up each time.
  -- That is deliberate: this is a record of what was PUT ON A SHIP, and it has
  -- to still read correctly years later when the PO line has been received,
  -- the description reworded, or the item retired from the catalogue.
  CREATE TABLE IF NOT EXISTS shipment_lines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL,
    po_no       TEXT NOT NULL,
    po_seq      INTEGER,
    item_code   TEXT NOT NULL,
    description TEXT DEFAULT '',
    uom         TEXT DEFAULT '',
    qty         REAL NOT NULL,          -- how many are on THIS shipment
    -- How many that PO line ordered, so the line can read "1/2" - one of the
    -- two ordered. Copied for the same reason as the description: the PO line
    -- will be received and its outstanding figure will fall to nothing, and
    -- this record still has to say what was on the ship.
    po_qty      REAL,
    FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON shipment_lines(shipment_id);
  -- The question asked on every PO screen: what of this order is on a ship?
  CREATE INDEX IF NOT EXISTS idx_shipment_lines_po ON shipment_lines(po_no);

  CREATE TABLE IF NOT EXISTS part_notes (
    item_code  TEXT PRIMARY KEY,        -- exact AutoCount ItemCode
    note       TEXT NOT NULL,
    updated_by TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- What we fit when the part the book names cannot be had.
  --
  -- SEPARATE FROM part_notes on purpose. A note is prose and can say anything -
  -- "not sold separately, order the assembly" - and that freedom is why it
  -- cannot be trusted to name a part: nothing checks the code, so a typo points
  -- nowhere and nobody finds out until someone orders it. A replacement is the
  -- narrow case where the answer IS a part, so it is stored as one, and the
  -- server refuses any item_code AutoCount does not hold. The two coexist: a
  -- part with no substitute at all still wants the note.
  CREATE TABLE IF NOT EXISTS part_replacements (
    id          INTEGER PRIMARY KEY,
    -- What is being replaced. The AutoCount item code where the original
    -- resolves - the stabler identity, shared with Find Part - and otherwise
    -- the book's own IPL:BRAND:NUMBER key, exactly as part_notes does it.
    part_key    TEXT NOT NULL,
    -- The book's key, recorded WHENEVER it is known even if part_key is an
    -- item code. A diagram lists up to forty parts and marking the ones with a
    -- replacement must not cost forty AutoCount lookups; this key is computed
    -- from the book alone, so one query marks the whole figure.
    ipl_key     TEXT NOT NULL DEFAULT '',
    item_code   TEXT NOT NULL,          -- the replacement: exact AutoCount ItemCode
    -- Description as it read when recorded. AutoCount stays the source of
    -- truth and is re-read on open; this is so an old row still says what it
    -- meant if the item is ever renamed or retired.
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Several alternatives for one part are allowed and useful; the same one
  -- twice is a double tap, not a second opinion.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_part_replacements_pair
    ON part_replacements(part_key, item_code);
  CREATE INDEX IF NOT EXISTS idx_part_replacements_ipl ON part_replacements(ipl_key);

  -- One-off jobs that must run exactly once, recorded by name.
  --
  -- Every other migration in this file is safe to re-run because it asks a
  -- question first - does this column exist, is there a row like this. A
  -- migration that SHIFTS existing values cannot ask that question: shifted
  -- data looks exactly like data that was always right, so running it twice
  -- would shift it twice and there would be no way to tell. Hence a marker.
  CREATE TABLE IF NOT EXISTS schema_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT DEFAULT '',
    applied_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// ---- One-off: put every timestamp in local time ------------------------------
//
// Half this schema stored UTC and half stored local time, which nobody noticed
// until a Sales Order's created_at was compared with its slip's and came out
// eight hours apart. Worse, `formatDate` in app.js reads the date straight off
// the stored string without converting, so a UTC timestamp DISPLAYS its UTC
// date: anything recorded before 08:00 Singapore time would have shown the day
// before. Live data was checked at the time and no slip had crossed that line -
// the earliest was 09:25 - but the margin was under an hour and a half, and
// the same fault dated the customer's quotation.
//
// Local time is the target because it is what the majority already used, what
// every screen displays, and what the price-updates log has always written.
//
// SHIFTED, because they were UTC:
//   items.created_at              orders.created_at
//   service_slips.created_at      service_slips.closed_at
//   machine_parts.created_at      slip_signatures.signed_at
//   slip_machines.converted_at    part_prices.updated_at  (retired, for tidiness)
//
// NOT SHIFTED, because they were already local and shifting them would break
// what is currently right: invoiced_at on slips and orders, decided_at and
// disposal_at on machines, and everything in slip_quotations, slip_amendments,
// part_requests, po_tracking, shipments and part_notes.
//
// The offset is taken from the server rather than assumed, and Singapore has no
// daylight saving, so one offset is right for every row ever written here. On a
// server that observed DST this would need to be per-row and this comment is
// the warning.
try {
  const KEY = "timestamps-to-localtime";
  const done = db.prepare("SELECT 1 FROM schema_meta WHERE key = ?").get(KEY);
  if (!done && DB_IS_NEW) {
    // Nothing here predates the local-time defaults, so there is nothing to
    // convert - but the marker still goes in, or the next start would find an
    // unmarked database full of local timestamps and shift them.
    db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
      .run(KEY, "new database - created with local-time defaults, nothing to convert");
  } else if (!done) {
    const { hours } = db.prepare(
      "SELECT (julianday(datetime('now','localtime')) - julianday(datetime('now'))) * 24 AS hours"
    ).get();
    const offset = Math.round(hours * 60);          // minutes, to survive half-hour zones
    const modifier = `${offset >= 0 ? "+" : ""}${offset} minutes`;

    const targets = [
      ["items", "created_at"],
      ["orders", "created_at"],
      ["service_slips", "created_at"],
      ["service_slips", "closed_at"],
      ["machine_parts", "created_at"],
      ["slip_signatures", "signed_at"],
      ["slip_machines", "converted_at"],
      ["part_prices", "updated_at"],
    ];
    let moved = 0;
    const tx = db.transaction(() => {
      for (const [table, col] of targets) {
        // A table or column that never existed on this server is not an error:
        // the schema has grown over time and old installs differ.
        let cols;
        try { cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
        catch (_) { continue; }
        if (!cols.includes(col)) continue;
        // datetime() returns NULL for anything it cannot read, so a blank or a
        // hand-typed value is left exactly as it is rather than becoming NULL.
        const r = db.prepare(
          `UPDATE ${table} SET ${col} = datetime(${col}, ?)
            WHERE ${col} IS NOT NULL AND ${col} != '' AND datetime(${col}) IS NOT NULL`
        ).run(modifier);
        moved += r.changes;
      }
      db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
        .run(KEY, `${moved} timestamp(s) shifted by ${modifier}`);
    });
    tx();
    if (moved) console.log(`[db] migrated: ${moved} UTC timestamp(s) shifted ${modifier} to local time`);
  }
} catch (e) {
  console.error("[db] timestamp localtime migration failed:", e.message);
}

module.exports = db;
