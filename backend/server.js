// server.js — Express API + static frontend host
//
// Routes are thin: they handle HTTP only and delegate ALL data access to the
// repository layer (./data/dataSource). This keeps the data source swappable —
// to move to AutoCount, implement data/autocountRepo.js and set DATA_SOURCE
// (see data/dataSource.js). No route changes are needed for the swap.
//
// Note: data calls are awaited so this file is identical whether the underlying
// source is synchronous (SQLite) or asynchronous (AutoCount SDK/HTTP later).

const express = require("express");
const cors = require("cors");
const path = require("path");

// Ensure the SQLite schema/seed runs on boot (harmless if another source is
// selected later; remove this require once SQLite is fully retired).
require("./db");

const data = require("./data/dataSource");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// 1mb, not the 100kb default: registration posts the customer's signature as a
// PNG data URL. A trimmed signature is a few KB, but a large tablet screen can
// produce more, and hitting the default limit fails with an opaque parse error.
app.use(express.json({ limit: "1mb" }));

// Serve the PWA frontend from ../frontend
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---- API: item lookup ------------------------------------------------------
// Tolerant matching handled in the repository: a scanned "SZEN 140051111" also
// matches "SZEN140051111" or "140051111".
app.get("/api/items/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "Missing code" });

    const item = await data.items.findItem(code);
    if (!item) {
      return res.status(404).json({ error: `No item found for "${code}"` });
    }
    res.json(item);
  } catch (err) {
    console.error("[GET /api/items/:code]", err);
    res.status(err.status || 500).json({ error: err.message || "Lookup failed" });
  }
});

// GET /api/items -> full catalogue
app.get("/api/items", async (_req, res) => {
  try {
    const rows = await data.items.listItems();
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/items]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to list items" });
  }
});

// ---- API: submit order -----------------------------------------------------
app.post("/api/orders", async (req, res) => {
  try {
    const { notes = "", lines } = req.body || {};
    const result = await data.orders.createOrder({ notes, lines });
    res.status(201).json(result);
  } catch (err) {
    // Validation errors from the repository carry status 400; anything else 500.
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error("[POST /api/orders]", err);
    res.status(err.status || 500).json({ error: err.message || "Submit failed" });
  }
});

// GET /api/orders/:so -> retrieve a submitted order
app.get("/api/orders/:so", async (req, res) => {
  try {
    const order = await data.orders.getOrder(req.params.so);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    console.error("[GET /api/orders/:so]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch order" });
  }
});

// ============================================================================
// SERVICE SLIP ROUTES
// ============================================================================

// Create a new service slip (New Service)
app.post("/api/slips", async (req, res) => {
  try {
    const { company, debtor_code, contact_name, contact_number, whatsapp_number, check_service, quote_first, notes, machines, signature } = req.body || {};
    const slip = await data.slips.createSlip({ company, debtor_code, contact_name, contact_number, whatsapp_number, check_service, quote_first, notes, machines, signature });
    res.status(201).json(slip);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[POST /api/slips]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to create slip" });
  }
});

// TEMPORARY: every constraint the Sales Order tables impose, and who counts as
// a valid AutoCount user. Read-only.
app.get("/api/_diag/so-constraints", async (req, res) => {
  res.type("text/plain");
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.send("AutoCount is not enabled on this server.");
    const sch = require("./data/autocountSchema");
    const out = [];

    out.push("== Foreign keys on SO and SODTL ==");
    const fks = await sch.foreignKeys(["SO", "SODTL"]);
    if (!fks.length) out.push("  (none)");
    for (const f of fks) {
      out.push(`  ${f.table}.${f.column}  ->  ${f.refTable}.${f.refColumn}   [${f.constraintName}]`);
    }

    out.push("");
    out.push("== Valid AutoCount users ==");
    try {
      const users = await sch.autocountUsers();
      if (!users.length) out.push("  (none)");
      for (const u of users) {
        const id = u.UserID || u.UserId || u.LoginID || "?";
        const name = u.UserName || u.Description || u.FullName || "";
        const active = u.IsActive !== undefined ? ` active=${u.IsActive}` : "";
        out.push(`  ${String(id).padEnd(12)} ${String(name).slice(0, 40)}${active}`);
      }
    } catch (e) {
      out.push("  could not read Users: " + e.message);
    }
    res.send(out.join(String.fromCharCode(10)));
  } catch (err) {
    res.send("FAILED: " + err.message);
  }
});

// Preview exactly what would be written into AutoCount for an order the app
// has already produced. Writes nothing, whatever the switch says.
app.get("/api/orders/:so/autocount-preview", async (req, res) => {
  res.type("text/plain");
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.send("AutoCount is not enabled on this server.");

    const order = await data.orders.getOrder(req.params.so);
    if (!order) return res.send("No such order in the app.");
    const slipNumber = String(order.notes || "").replace(/^S\/S:\s*/, "").trim();
    const slip = slipNumber ? await data.slips.getSlip(slipNumber) : null;
    if (!slip) return res.send(`Could not find the service slip behind ${req.params.so}.`);

    const techs = [...new Set((slip.machines || [])
      .flatMap((m) => (m.parts || []).map((p) => p.technician)).filter(Boolean))];

    const so = require("./data/autocountSalesOrder");
    const out = await so.createSalesOrder({
      slipNumber: slip.slip_number,
      debtorCode: slip.debtor_code || "C0112",
      contactName: slip.contact_name,
      contactNumber: slip.contact_number,
      salesAgent: techs.join("/"),
      lines: order.lines || [],
    }, { dryRun: true });

    const t = [];
    t.push("DRY RUN - nothing was written.");
    t.push("");
    t.push(`Would create Sales Order ${out.doc_no} with DocKey ${out.would_use_doc_key}`);
    t.push(`  debtor ${out.header.DebtorCode}  ${out.header.DebtorName}`);
    t.push(`  term ${out.header.DisplayTerm}   agent ${out.header.SalesAgent || "(none)"}`);
    t.push(`  ex-tax ${out.totals.ex_tax}   GST ${out.totals.tax}   total ${out.totals.net}`);
    t.push("");
    t.push(`== ${out.details.length} lines ==`);
    for (const d of out.details) {
      t.push(`  Seq ${String(d.Seq).padStart(4)} | ${(d.ItemCode || "(no code)").padEnd(20)}` +
             ` | ${String(d.Description || "").slice(0, 44).padEnd(44)}` +
             ` | qty ${d.Qty === undefined ? "-" : d.Qty}` +
             ` | price ${d.UnitPrice === undefined ? "-" : d.UnitPrice}` +
             ` | sub ${d.SubTotal === undefined ? "-" : d.SubTotal}`);
    }
    t.push("");
    t.push("== Header columns that would be set ==");
    for (const [k, v] of Object.entries(out.header)) t.push(`  ${k} = ${v instanceof Date ? v.toISOString().slice(0,10) : v}`);
    res.send(t.join(String.fromCharCode(10)));
  } catch (err) {
    res.send("FAILED: " + err.message);
  }
});

// ---- TEMPORARY: is the next key simply "highest anywhere, plus one"? -------
app.get("/api/_diag/keyrule", async (req, res) => {
  res.type("text/plain");
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.send("AutoCount is not enabled on this server.");
    const sch = require("./data/autocountSchema");
    const rows = await sch.topKeys();
    const out = ["== Highest key in each document table, biggest first =="];
    for (const r of rows.slice(0, 14)) out.push("  " + String(r.spot).padEnd(22) + " " + r.maxKey);

    const top = Number(rows[0].maxKey);
    const second = Number(rows[1] ? rows[1].maxKey : 0);
    out.push("");
    out.push("== Reading ==");
    out.push("  highest anywhere      : " + top + "  (" + rows[0].spot + ")");
    out.push("  next highest          : " + second + "  (" + (rows[1] ? rows[1].spot : "-") + ")");
    out.push("  gap between them      : " + (top - second));
    out.push("");
    if (top - second <= 2) {
      out.push("  The newest keys run consecutively across tables, which fits");
      out.push("  'next key = highest anywhere + 1'.");
    } else {
      out.push("  There is a gap, so the next key is NOT simply the highest plus one -");
      out.push("  AutoCount is getting it from somewhere we have not found.");
    }
    res.send(out.join(String.fromCharCode(10)));
  } catch (err) {
    res.send("FAILED: " + err.message);
  }
});

// ---- TEMPORARY: watch AutoCount allocate a key -----------------------------
// Take a reading before creating a Sales Order in AutoCount, and another
// afterwards. Whatever moved is the counter. Reading only; the snapshot is
// kept in a file beside the app so the two visits can be compared.
app.get("/api/_diag/keyprobe", async (req, res) => {
  res.type("text/plain");
  const fs = require("fs");
  const path = require("path");
  const SNAP = path.join(__dirname, "_keyprobe.json");
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.send("AutoCount is not enabled on this server.");
    const sch = require("./data/autocountSchema");

    const now = await sch.snapshot(2000);
    const count = Object.keys(now).length;

    if (!req.query.compare) {
      fs.writeFileSync(SNAP, JSON.stringify(now));
      return res.send(
        ["BEFORE reading taken: " + count + " columns.", "",
         "Now create a Sales Order in AutoCount, then open this page again with",
         "?compare=1 on the end."].join(String.fromCharCode(10))
      );
    }

    if (!fs.existsSync(SNAP)) return res.send("No BEFORE reading. Open this page without ?compare=1 first.");
    const before = JSON.parse(fs.readFileSync(SNAP, "utf8"));

    const moved = [];
    for (const [spot, val] of Object.entries(now)) {
      if (before[spot] === undefined) moved.push(`${spot}: (new) -> ${val}`);
      else if (before[spot] !== val) moved.push(`${spot}: ${before[spot]} -> ${val}`);
    }

    const out = [`AFTER reading: ${count} columns, ${moved.length} moved.`, ""];
    if (!moved.length) {
      out.push("Nothing moved. Either no order was created, or the counter lives");
      out.push("in a table larger than 2000 rows, or it is not a number.");
    } else {
      out.push("== What changed while the Sales Order was created ==");
      for (const m of moved.sort()) out.push("  " + m);
    }
    res.send(out.join(String.fromCharCode(10)));
  } catch (err) {
    res.send("FAILED: " + err.message);
  }
});

// ---- TEMPORARY: read-only look at AutoCount's Sales Order schema -----------
// Here so the Sales Order insert can be built from the real tables rather than
// a guess. Every query behind it is a SELECT. REMOVE once the insert is built.
// Returns plain text because the output is meant to be read and pasted.
app.get("/api/_diag/so-schema", async (req, res) => {
  res.type("text/plain");
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.send("AutoCount is not enabled on this server.");
    const sch = require("./data/autocountSchema");

    const header = String(req.query.header || "SO");
    const detail = String(req.query.detail || "SODTL");
    const key = String(req.query.key || "DocKey");
    const out = [];

    out.push("== Tables that look like sales orders or numbering ==");
    for (const t of await sch.findTables()) out.push("  " + t.name);

    for (const [label, table] of [["HEADER", header], ["DETAIL", detail]]) {
      const cols = await sch.columns(table);
      out.push("", `== ${label}: ${table} - ${cols.length} columns ==`);
      if (!cols.length) { out.push("  (no such table - tell me the right name)"); continue; }
      out.push("  -- required (NOT NULL, no default) --");
      for (const c of cols.filter((c) => c.nullable === "NO" && c.default === null)) {
        out.push(`    ${c.name}  ${c.type}${c.len ? "(" + c.len + ")" : ""}`);
      }
      out.push("  -- all columns --");
      out.push("    " + cols.map((c) => c.name).join(", "));
    }

    try {
      const s = await sch.sampleOrder(header, detail, key);
      out.push("", "== Most recent Sales Order: columns that are actually filled in ==");
      if (!s.header) {
        out.push("  (no sales orders found)");
      } else {
        out.push("  -- header --");
        for (const line of sch.usedColumns(s.header)) out.push("    " + line);
        out.push(`  -- ${s.lines.length} line(s), first three --`);
        s.lines.slice(0, 3).forEach((l, i) => {
          out.push(`    [line ${i + 1}]`);
          for (const line of sch.usedColumns(l)) out.push("      " + line);
        });
      }
    } catch (e) {
      out.push("", "Sample order failed: " + e.message + "  (wrong key column? try ?key=DocKey or ?key=DocNo)");
    }

        // ---- round two: the things that decide how the insert is written ----
    try {
      out.push("", "== Are the keys auto-generated? ==");
      const ids = await sch.identityColumns([header, detail]);
      if (!ids.length) {
        out.push("  NO identity columns - DocKey and DtlKey must be allocated by us.");
      } else {
        for (const i of ids) out.push(`  ${i.table}.${i.column} IS an identity (last = ${i.last})`);
      }

      const ver = await sch.serverVersion();
      out.push("", "== SQL Server ==");
      out.push("  " + String(ver[0].version).split(String.fromCharCode(10))[0] + "  (product " + ver[0].product + ")");

      out.push("", "== Columns that look like a next-number holder ==");
      const ncols = await sch.numberingColumns();
      if (!ncols.length) out.push("  (none)");
      for (const c of ncols.slice(0, 60)) out.push(`  ${c.table}.${c.column}  ${c.type}`);

      out.push("", "== Stored procedures / functions that may allocate keys ==");
      const rts = await sch.keyRoutines();
      if (!rts.length) out.push("  (none)");
      for (const r of rts.slice(0, 60)) out.push(`  ${r.type}  ${r.name}`);

      out.push("", "== Highest DocKey across the document system ==");
      const gmax = await sch.globalMaxDocKey();
      for (const g of gmax.slice(0, 8)) out.push(`  ${g.table}: ${g.maxKey}`);
      const highest = Number(gmax.length ? gmax[0].maxKey : 0);
      out.push(`  -> the counter must sit just above ${highest}`);

      out.push("", "== What each document type was last used ==");
      for (const u of (await sch.lastUsed()).filter((u) => u.docs > 0)
             .sort((a, b) => new Date(b.lastDate) - new Date(a.lastDate))) {
        out.push(`  ${String(u.table).padEnd(12)} ${String(u.lastDate).slice(0, 10)}   ${u.docs} documents`);
      }

      // ---- the decisive test, this time in the right range ----
      out.push("", "== Hunting the global DocKey counter by value ==");
      const cands = await sch.smallTableNumericColumns(500);
      out.push(`  scanning ${cands.length} numeric columns in tables of 500 rows or fewer`);
      out.push(`  looking for a value between ${highest} and ${highest + 20000}`);
      const hits = await sch.findValueNear(cands, highest, highest + 20000);
      if (!hits.length) {
        out.push("  NOTHING FOUND - not a small numeric column.");
      } else {
        for (const h of hits) out.push(`  HIT  ${h.spot} = ${h.val}`);
      }

      out.push("", "== Other tables carrying a DocKey ==");
      out.push("  " + (await sch.docKeyTables()).map((t) => t.table).join(", "));

      const s2 = await sch.sampleOrder(header, detail, key);
      if (s2.header) {
        const lines = await sch.allLines(detail, key, s2.header[key]);
        out.push("", `== All ${lines.length} lines of ${s2.header.DocNo}, compactly ==`);
        for (const l of lines) {
          out.push(`  Seq ${l.Seq} | ${l.ItemCode || "(no code)"} | ${String(l.Description || "").slice(0, 46)}`
            + ` | qty ${l.Qty === null ? "-" : l.Qty} | price ${l.UnitPrice === null ? "-" : l.UnitPrice}`
            + ` | sub ${l.SubTotal === null ? "-" : l.SubTotal} | DtlType ${l.DtlType} | AddToSubTotal ${l.AddToSubTotal}`
            + ` | MainItem ${l.MainItem} | Numbering ${l.Numbering === null ? "-" : l.Numbering}`);
        }
      }
    } catch (e) {
      out.push("", "Round two failed: " + e.message);
    }

res.send(out.join("\n"));
  } catch (err) {
    res.send("FAILED: " + err.message);
  }
});

// ---- Send a slip to the customer on WhatsApp -------------------------------
// The PDF arrives as raw bytes, NOT JSON. Base64 would inflate it by a third
// and force the global 1mb JSON limit up for every route in the app; this way
// the parser above ignores the request entirely and only this route sees it.
//
// The PDF is built in the browser, by the same code that produces the copy
// staff look at. Deliberately not regenerated here: two generators would drift
// apart, and the customer would eventually receive something subtly different
// from what was on screen when it was signed.
app.post(
  "/api/slips/:slip/whatsapp",
  express.raw({ type: "application/pdf", limit: "10mb" }),
  async (req, res) => {
    const wa = require("./whatsapp");
    const { logSend } = require("./whatsappLog");
    const who = String(req.query.who || "").trim() || (req.query.auto === "1" ? "auto" : "?");
    const role = String(req.query.role || "").trim();
    const stamp = (outcome, detail, to) =>
      logSend({ slip: req.params.slip, to, outcome, detail, who: role ? `${who} (${role})` : who });

    try {
      const ready = wa.readiness();
      if (!ready.enabled) {
        return res.status(403).json({ error: "WhatsApp sending is switched off on this server." });
      }
      if (!ready.configured) {
        return res.status(503).json({ error: `WhatsApp is not configured (missing ${ready.missing.join(", ")}).` });
      }
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: "No PDF was received." });
      }

      const slip = await data.slips.getSlip(req.params.slip);
      if (!slip) return res.status(404).json({ error: "Slip not found." });

      // Fall back to the contact number only if no WhatsApp number was given -
      // the form defaults one to the other, so they are usually the same.
      const to = slip.whatsapp_number || slip.contact_number || "";
      const filename = `Service Slip ${slip.slip_number}.pdf`;

      // The date the slip was REGISTERED, not today - re-sending an older slip
      // from View Slips must still describe when the equipment came in.
      const received = (() => {
        const d = new Date(slip.created_at || Date.now());
        if (isNaN(d)) return "";
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
      })();

      // Just the count. The template reads "No. of Equipment: {{4}}" - the
      // machines are itemised on the attached slip, so naming them here only
      // repeated it and risked a long line wrapping badly on a phone.
      const equipment = String((slip.machines || []).length);

      const out = await wa.sendSlip({
        to,
        customerName: slip.contact_name || slip.company,
        slipNumber: slip.slip_number,
        receivedOn: received,
        equipment,
        pdf: req.body,
        filename,
      });

      stamp("SENT", out.messageId || "-", out.to);
      res.json({ sent: true, to: out.to, message_id: out.messageId });
    } catch (err) {
      // A failed send must never look like a success, and must never take the
      // slip down with it - the slip already exists and is the important part.
      stamp("FAILED", err.message, null);
      const code = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
      res.status(code).json({ error: err.message || "Could not send on WhatsApp." });
    }
  }
);

// Tells the browser whether to offer the button, and whether to send without
// being asked. Kept on the server so switching to automatic is a server
// setting, not an app deploy.
app.get("/api/whatsapp/status", (req, res) => {
  const wa = require("./whatsapp");
  const r = wa.readiness();
  res.json({ enabled: r.enabled, configured: r.configured, auto_send: r.autoSend });
});

// ---- Part reorder requests (Find Part "Order more" -> Purchaser screen) ----
app.post("/api/part-requests", async (req, res) => {
  try {
    const row = await data.requests.createPartRequest(req.body || {});
    res.status(201).json(row);
  } catch (err) {
    if (err.status === 400 || err.status === 409) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/part-requests]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save request" });
  }
});

// Lightweight pending-request count for the Purchaser home notification.
app.get("/api/part-requests/count", async (req, res) => {
  try {
    const count = await data.requests.countPendingPartRequests();
    res.json({ count });
  } catch (err) {
    console.error("[GET /api/part-requests/count]", err);
    res.json({ count: 0 }); // a broken badge should never break the home screen
  }
});

// Pending requests, each enriched with the current AutoCount balance (when
// AutoCount is enabled) so the purchaser sees live stock next to the ask.
app.get("/api/part-requests", async (req, res) => {
  try {
    const rows = await data.requests.listPartRequests(String(req.query.status || "PENDING"));
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource === "autocount" && rows.length) {
      const acRepo = require("./data/autocountRepo");
      for (const r of rows) {
        try {
          const info = await acRepo.getPartStock(r.item_code);
          r.current_qty = info ? info.bal_qty : null;
          if (info && !r.description) r.description = info.description;
        } catch (_) { r.current_qty = null; }
      }
    } else {
      for (const r of rows) r.current_qty = null;
    }
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/part-requests]", err);
    res.status(500).json({ error: "Failed to load requests" });
  }
});

app.patch("/api/part-requests/:id/ordered", async (req, res) => {
  try {
    const result = await data.requests.markPartRequestOrdered(Number(req.params.id));
    res.json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error("[PATCH /api/part-requests/:id/ordered]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update request" });
  }
});

// ---- Part prices (IPL viewer) ----------------------------------------------
// Read-only from AutoCount: Price1 is the Contractor Price, Price6 the List
// Price. Editing lives in AutoCount, not here — writing prices back would mean
// updating AutoCount fields, which is restricted to the one guarded
// write-back the app already has.
app.get("/api/part-prices/:code", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") {
      return res.status(503).json({ error: "AutoCount is not enabled." });
    }
    const acRepo = require("./data/autocountRepo");
    const row = await acRepo.getPartPrices(req.params.code);
    // Say which of the two things went wrong: the part was not found, or the
    // price columns are not where we expect. "No prices found" covered both
    // and made the real cause impossible to tell apart.
    if (!row || row.error) {
      return res.status(404).json({ error: `"${req.params.code}" not found in AutoCount.` });
    }
    res.json(row);
  } catch (err) {
    console.error("[GET /api/part-prices/:code]", err.message);
    res.status(500).json({ error: "Price lookup failed." });
  }
});

// Set a price that AutoCount does not have yet (Parts Diagram -> Check Price).
// This WRITES to the accounting database, so it is fenced in on every side:
// the switch must be on, the item code must be the exact one the price lookup
// resolved, the price must already be blank, and every attempt is logged.
//
// The role check is an accident guard, not security: this app has no logins,
// so the role comes from the browser and could be anything. It stops a
// technician tapping something they should not, which is what it is for.
app.post("/api/part-prices", async (req, res) => {
  const { item_code, tier, price, who, role } = req.body || {};
  const { logPriceEvent } = require("./priceLog");
  const stamp = (outcome, extra = {}) =>
    logPriceEvent({
      source: "Parts Diagram",
      itemCode: extra.item_code || item_code,
      tier: extra.tier || tier,
      oldPrice: extra.old_price ?? null,
      newPrice: price,
      who: `${who || "?"} (${role || "?"})`,
      outcome,
    });

  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") {
      return res.status(503).json({ error: "AutoCount is not enabled." });
    }
    const acRepo = require("./data/autocountRepo");
    if (!acRepo.writebackEnabled()) {
      return res.status(403).json({
        error: "Setting prices is switched off. Ask IT to enable AUTOCOUNT_PRICE_WRITEBACK.",
      });
    }
    if (!["sales", "purchaser", "admin"].includes(String(role || "").toLowerCase())) {
      stamp("REFUSED - role not allowed");
      return res.status(403).json({ error: "Only Sales, Purchaser and Admin can set a price." });
    }
    if (!String(who || "").trim()) {
      return res.status(400).json({ error: "Enter your initials so the change can be traced." });
    }

    const r = await acRepo.setMissingPrice(item_code, tier, price);
    const messages = {
      updated: `${r.tier} set to ${Number(r.new_price).toFixed(2)} in AutoCount.`,
      already_priced: `${r.tier} is already set in AutoCount — nothing was changed.`,
      not_found: `"${item_code}" is no longer in AutoCount.`,
      no_uom_row: `This item has no unit-of-measure row in AutoCount, so the price must be set there.`,
    };
    stamp(
      r.status === "updated" ? "updated in AutoCount" : `no change - ${r.status}`,
      r
    );
    if (r.status !== "updated") {
      return res.status(409).json({ error: messages[r.status] || "Nothing was changed.", status: r.status });
    }
    res.json({ ...r, message: messages.updated });
  } catch (err) {
    stamp(`FAILED - ${err.message}`);
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[POST /api/part-prices]", err.message);
    res.status(500).json({ error: "Could not save the price to AutoCount." });
  }
});

// Find Part: search parts by description/code (suggestion list).
app.get("/api/parts-search", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ results: [] });
    const acRepo = require("./data/autocountRepo");
    const results = await acRepo.searchParts(String(req.query.q || ""), 15);
    res.json({ results });
  } catch (err) {
    console.error("[GET /api/parts-search]", err.message);
    res.json({ results: [] });
  }
});

// Find Part: stock card for one part (code, description, shelf, balance qty).
app.get("/api/part-stock/:code", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.status(503).json({ error: "AutoCount is not enabled." });
    const acRepo = require("./data/autocountRepo");
    const info = await acRepo.getPartStock(req.params.code);
    if (!info) return res.status(404).json({ error: "Part not found." });
    res.json(info);
  } catch (err) {
    console.error("[GET /api/part-stock/:code]", err.message);
    res.status(500).json({ error: "Stock lookup failed." });
  }
});

// Search AutoCount debtors (customers) by company name, for the New Service
// company-name suggestions. Returns empty results when AutoCount items are off,
// so the app degrades gracefully.
app.get("/api/debtors-search", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ results: [] });
    const acRepo = require("./data/autocountRepo");
    const results = await acRepo.searchDebtors(String(req.query.q || ""), 12);
    res.json({ results });
  } catch (err) {
    console.error("[GET /api/debtors-search]", err.message);
    // Suggestions are a convenience — never surface a hard error to the form.
    res.json({ results: [] });
  }
});

// Search slips by number. ?q=638&scope=active|all
app.get("/api/slips-search", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const scope = String(req.query.scope || "all").toLowerCase();
    const result = await data.slips.searchSlips(q, scope, 20);
    res.json(result);
  } catch (err) {
    console.error("[GET /api/slips-search]", err);
    res.status(err.status || 500).json({ error: err.message || "Search failed" });
  }
});

// List slips. ?status=active|open|call_customer|closed|all  (default active)
app.get("/api/slips", async (req, res) => {
  try {
    const status = String(req.query.status || "active").toLowerCase();
    const rows = await data.slips.listSlips(status);
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/slips]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to list slips" });
  }
});

// Get one slip with machines + parts
app.get("/api/slips/:slip", async (req, res) => {
  try {
    const slip = await data.slips.getSlip(req.params.slip);
    if (!slip) return res.status(404).json({ error: "Service slip not found" });
    res.json(slip);
  } catch (err) {
    console.error("[GET /api/slips/:slip]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch slip" });
  }
});

// Add a scanned part to a specific machine on a slip
app.post("/api/machines/:machineId/parts", async (req, res) => {
  try {
    const machineId = Number(req.params.machineId);
    const parts = await data.slips.addPartToMachine(machineId, req.body || {});
    res.status(201).json(parts);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/machines/:machineId/parts]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to add part" });
  }
});

// Update a part line: quantity (0 removes) and/or unit_price
app.patch("/api/parts/:partId", async (req, res) => {
  try {
    const partId = Number(req.params.partId);
    const body = req.body || {};
    let result = {};
    if (body.unit_price !== undefined) {
      result = await data.slips.setPartPrice(partId, body.unit_price);
    }
    if (body.quantity !== undefined) {
      result = await data.slips.setPartQuantity(partId, body.quantity);
    }
    res.json(result);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/parts/:partId]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update part" });
  }
});

// Save a machine's repair comment
app.patch("/api/machines/:machineId/comment", async (req, res) => {
  try {
    const machineId = Number(req.params.machineId);
    const result = await data.slips.setMachineComment(machineId, (req.body || {}).comment);
    res.json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error("[PATCH /api/machines/:machineId/comment]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save comment" });
  }
});

// Labour charge for one machine (technician time, billed on top of parts).
app.patch("/api/machines/:machineId/labour", async (req, res) => {
  try {
    const machineId = Number(req.params.machineId);
    const result = await data.slips.setMachineLabour(machineId, (req.body || {}).labour_charge);
    res.json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error("[PATCH /api/machines/:machineId/labour]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save labour charge" });
  }
});

// Manually set a slip's quoting status: NEED_QUOTE, QUOTED, or back to IN_PROGRESS.
app.patch("/api/slips/:slip/status", async (req, res) => {
  try {
    const slip = await data.slips.setSlipStatus(req.params.slip, (req.body || {}).status);
    res.json(slip);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/status]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update status" });
  }
});

// Push an app order into AutoCount as a Sales Order. Kept separate from the
// conversion itself so a failure here never undoes work the workshop has
// already done - the slip stays converted and the push can be retried.
async function pushOrderToAutoCount(soNumber) {
  const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
  if (itemsSource !== "autocount") return { pushed: false, reason: "AutoCount is not enabled." };

  const so = require("./data/autocountSalesOrder");
  if (!so.writebackEnabled()) return { pushed: false, reason: "Writing Sales Orders to AutoCount is switched off." };

  const order = await data.orders.getOrder(soNumber);
  if (!order) return { pushed: false, reason: `Order ${soNumber} not found.` };
  if (order.autocount_doc_no) {
    return { pushed: false, already: order.autocount_doc_no, reason: `Already in AutoCount as ${order.autocount_doc_no}.` };
  }

  const slipNumber = String(order.notes || "").replace(/^S\/S:\s*/, "").trim();
  const slip = slipNumber ? await data.slips.getSlip(slipNumber) : null;
  if (!slip) return { pushed: false, reason: `Could not find the service slip behind ${soNumber}.` };

  const out = await so.createSalesOrder({
    slipNumber: slip.slip_number,
    debtorCode: slip.debtor_code || "C0112",
    contactName: slip.contact_name,
    contactNumber: slip.contact_number,
    lines: order.lines || [],
  });
  await data.slips.setOrderAutocountDocNo(soNumber, out.doc_no);
  return { pushed: true, doc_no: out.doc_no, doc_key: out.doc_key, lines: out.lines, totals: out.totals };
}

// Retry pushing an order that did not reach AutoCount the first time.
app.post("/api/orders/:so/push-to-autocount", async (req, res) => {
  try {
    res.json(await pushOrderToAutoCount(req.params.so));
  } catch (err) {
    console.error("[push-to-autocount]", err.message);
    res.status(err.status || 502).json({ error: err.message || "Could not write to AutoCount." });
  }
});

// Create the Sales Order for a slip (-> ALL_REPAIRED)
// If AutoCount price write-back is enabled, prices keyed in by staff for parts
// that had NO price in AutoCount are saved to AutoCount's ItemUOM at this
// moment. Failures never block the Sales Order — they are logged and reported.
app.post("/api/slips/:slip/order", async (req, res) => {
  try {
    // machine_ids lets the sales desk convert part of a slip; with none given
    // it takes everything not already on an order.
    const result = await data.slips.createSlipOrder(req.params.slip, (req.body || {}).machine_ids);

    // ---- Price write-back (guarded, best-effort) ----
    const priceSync = { updated: [], skipped: 0, failed: [] };
    try {
      const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
      const acRepo = itemsSource === "autocount" ? require("./data/autocountRepo") : null;
      // Deliberately a SEPARATE switch from the Parts Diagram one. Turning on
      // price-setting there must not silently start writing prices from every
      // Sales Order as well — that is a different decision, so it needs its
      // own explicit opt-in.
      const ordersWriteback =
        String(process.env.AUTOCOUNT_PRICE_WRITEBACK_ORDERS || "false").toLowerCase() === "true";
      if (acRepo && ordersWriteback) {
        const { logPriceEvent } = require("./priceLog");
        const slip = await data.slips.getSlip(req.params.slip);
        for (const machine of slip.machines || []) {
          for (const part of machine.parts || []) {
            if (!(Number(part.unit_price) > 0)) continue; // nothing keyed in
            try {
              const r = await acRepo.updateItemPriceIfMissing(part.item_code, part.unit_price);
              if (r.status === "updated") {
                priceSync.updated.push(r.item_code);
                logPriceEvent({
                  source: `Slip ${slip.slip_number}`, itemCode: r.item_code,
                  tier: "Contractor Price",
                  oldPrice: r.old_price, newPrice: r.new_price,
                  who: part.technician, outcome: "updated in AutoCount",
                });
              } else {
                priceSync.skipped++;
                // has-price skips are the normal case for every ordinarily
                // priced part and would flood the log. The other two are rare
                // and each means a price the staff expected to save did not,
                // so they are worth a line.
                if (r.status === "skipped_not_found" || r.status === "skipped_no_uom_row") {
                  logPriceEvent({
                    source: `Slip ${slip.slip_number}`, itemCode: part.item_code,
                    tier: "Contractor Price",
                    oldPrice: null, newPrice: part.unit_price,
                    who: part.technician,
                    outcome: r.status === "skipped_no_uom_row"
                      ? "SKIPPED - item has no unit-of-measure row in AutoCount"
                      : "SKIPPED - item not found in AutoCount",
                  });
                }
              }
            } catch (e) {
              priceSync.failed.push(part.item_code);
              logPriceEvent({
                source: `Slip ${slip.slip_number}`, itemCode: part.item_code,
                tier: "Contractor Price",
                oldPrice: null, newPrice: part.unit_price,
                who: part.technician, outcome: `FAILED - ${e.message}`,
              });
            }
          }
        }
      }
    } catch (e) {
      console.error("[price-writeback] sync step error:", e.message);
    }

    // ---- Write it into AutoCount (guarded, best-effort) ----
    // Deliberately after the slip has been committed: the machines are already
    // marked converted, and a failure here must not undo that. It is reported
    // instead, and can be retried.
    let autocount = { pushed: false, reason: "not attempted" };
    try {
      autocount = await pushOrderToAutoCount(result.so_number);
    } catch (e) {
      autocount = { pushed: false, error: e.message };
      console.error("[autocount SO]", e.message);
    }

    res.status(201).json({ ...result, price_sync: priceSync, autocount });
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/order]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to create order" });
  }
});

// Close a slip (Close Service) — requires DO/CS/INV ref
// The Sales Order raised for a slip (for the keyable AutoCount block view).
app.get("/api/slips/:slip/orders", async (req, res) => {
  try {
    res.json({ orders: await data.slips.getSlipOrders(req.params.slip) });
  } catch (err) {
    console.error("[GET /api/slips/:slip/orders]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to load sales orders" });
  }
});

app.get("/api/slips/:slip/order", async (req, res) => {
  try {
    const order = await data.slips.getSlipOrder(req.params.slip);
    if (!order) return res.status(404).json({ error: "No sales order for this slip yet." });
    res.json(order);
  } catch (err) {
    console.error("[GET /api/slips/:slip/order]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to load sales order" });
  }
});

app.post("/api/slips/:slip/close", async (req, res) => {
  try {
    const { closing_ref } = req.body || {};
    const slip = await data.slips.closeSlip(req.params.slip, closing_ref);
    res.json(slip);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/close]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to close slip" });
  }
});

// ---- Start server ----------------------------------------------------------
// Serve HTTPS when cert files are present (self-hosted on the office server,
// needed for the camera/QR features). Falls back to plain HTTP otherwise — so
// the Render deployment (which terminates HTTPS itself) is unaffected.
const fs = require("fs");
const https = require("https");

const CERT_PATH = path.join(__dirname, "cert.pem");
const KEY_PATH = path.join(__dirname, "key.pem");

if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  const options = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`OM Service running (HTTPS) at https://localhost:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`OM Service running (HTTP) at http://localhost:${PORT}`);
  });
}
