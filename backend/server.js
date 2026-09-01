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

// The site's own certificate, so a phone or tablet can be told to trust it.
// Until it is trusted, iOS shows a warning on every visit and will not take the
// home-screen icon — it fetches that outside the page, where the exception you
// tapped through does not apply, so you get a grey tile with the first letter
// of the address instead.
//
// This is the PUBLIC certificate, which every device already receives during
// the TLS handshake. The private key stays where it is and is never served.
// Content-Type is what makes iOS offer to install it rather than download it.
// Two addresses for the same file, and /api/cert.pem is the one that works on a
// device already running the app. A service worker only steps aside for a path
// it was written to ignore, and the copy installed on the iPad predates
// /cert.pem — so it intercepts that address, its own fetch fails on the
// untrusted certificate, and the page hangs. It cannot update itself out of
// this either: replacing a worker means fetching a new copy, which fails the
// same way. Every version ever shipped has ignored /api/, so that is the one
// door left open.
function sendCertificate(_req, res) {
  const certFile = path.join(__dirname, "cert.pem");
  if (!require("fs").existsSync(certFile)) {
    return res.status(404).type("text/plain").send("No certificate — this server is running over plain HTTP.");
  }
  res.type("application/x-x509-ca-cert");
  res.setHeader("Content-Disposition", 'attachment; filename="om-service.pem"');
  res.sendFile(certFile);
}
app.get("/api/cert.pem", sendCertificate);
app.get("/cert.pem", sendCertificate);

// ---- Web push --------------------------------------------------------------
// Telling sales, on their phone, that a repair is finished and waiting to be
// priced. See backend/push.js for what it needs; DEVICE-SETUP.md for turning it
// on per device.
// Who hears about a slip needing a quote. Not the technicians - they are the
// ones who just marked it.
const QUOTE_NOTIFY_ROLES = ["sales", "purchaser", "admin"];
// Orders are the purchaser's job; admins cover for her when she is away, and
// there is exactly one of her. Sales are the ones asking, so not them.
const ORDER_NOTIFY_ROLES = ["purchaser", "admin"];

const push = require("./push");
const pushDb = require("./db");
push.init(pushDb);

// The public half of the signing key. A browser needs it to subscribe, and it
// is public by definition - the private half never leaves the server.
app.get("/api/push/key", (_req, res) => res.json({ key: push.publicKey }));

app.post("/api/push/subscribe", (req, res) => {
  try {
    const { subscription, user_id, role, tech } = req.body || {};
    res.json(push.subscribe(pushDb, { subscription, user_id, role, tech }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not subscribe" });
  }
});

app.post("/api/push/unsubscribe", (req, res) => {
  try {
    res.json(push.unsubscribe(pushDb, (req.body || {}).endpoint));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not unsubscribe" });
  }
});

// How many devices would be told. Lets the app say "3 devices" rather than
// leaving someone wondering whether it is on anywhere at all — and "0 devices"
// is the answer to most of the ways this can appear broken.
// How many devices are being notified. Asked by whichever row is on screen, so
// it has to count the right group: telling a technician that "2 devices are
// being notified" when those two are the sales phones is worse than silence.
app.get("/api/push/status", (req, res) => {
  const group = String((req.query || {}).group || "").toLowerCase() === "tech"
    ? ["tech"] : QUOTE_NOTIFY_ROLES;
  res.json({ devices: push.countFor(pushDb, group) });
});

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

// Orders the app has raised that never reached AutoCount, with the reason.
app.get("/api/orders/awaiting-autocount", async (req, res) => {
  try {
    res.json({ orders: await data.slips.ordersAwaitingAutoCount() });
  } catch (err) {
    console.error("[GET /api/orders/awaiting-autocount]", err.message);
    res.status(500).json({ error: err.message });
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
    if (out.problems && out.problems.length) {
      t.push("");
      t.push("*** AutoCount would REJECT this order ***");
      for (const p of out.problems) t.push("  - " + p);
    } else {
      t.push("All AutoCount constraints check out.");
    }
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
// The stock snapshot taken when an order is made. John decided the list shows
// what the balance WAS at that moment - the context of the decision - rather
// than live stock, so this is the only time AutoCount is asked at all. A
// failure here must never block the order: the snapshot is context, not data.
async function stockSnapshot(codes) {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount" || !codes.length) return new Map();
    const acRepo = require("./data/autocountRepo");
    return await acRepo.getStockBalances(codes);
  } catch (e) {
    console.error("[part-requests] stock snapshot failed:", e.message);
    return new Map();
  }
}

app.post("/api/part-requests", async (req, res) => {
  try {
    const body = req.body || {};
    const snap = await stockSnapshot([body.item_code]);
    const hit = snap.get(String(body.item_code || "").trim());
    const row = await data.requests.createPartRequest({
      ...body,
      stock_at_request: hit ? hit.bal_qty : null,
    });
    res.status(201).json(row);

    // Tell the purchaser a request is waiting. Until now she found out by
    // opening the Orders list; the point of the list is that nothing waits
    // because nobody knew.
    push.notify(pushDb, ORDER_NOTIFY_ROLES, {
      title: "New part order",
      body: `${row.qty_requested} × ${row.description || row.item_code} · from ${row.requester || "?"}`,
      slip: "",
    }).catch((e) => console.error("[push] notify failed:", e.message));
  } catch (err) {
    if (err.status === 400 || err.status === 409) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/part-requests]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save request" });
  }
});

// A whole order at once - the Bulk Order cart. All-or-nothing in the
// repository, so a clash reports every problem together and saves nothing.
app.post("/api/part-requests/bulk", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const snap = await stockSnapshot(items.map((it) => (it || {}).item_code));
    const rows = await data.requests.createPartRequestBatch({
      ...body,
      items: items.map((it) => {
        const hit = snap.get(String((it || {}).item_code || "").trim());
        return { ...it, stock_at_request: hit ? hit.bal_qty : null };
      }),
    });
    res.status(201).json({ batch_id: rows[0].batch_id, rows });

    const n = rows.length;
    push.notify(pushDb, ORDER_NOTIFY_ROLES, {
      title: "New bulk order",
      body: `${n} part${n === 1 ? "" : "s"} · from ${rows[0].requester || "?"}`,
      slip: "",
    }).catch((e) => console.error("[push] notify failed:", e.message));
  } catch (err) {
    if (err.status === 400 || err.status === 409) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/part-requests/bulk]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save the order" });
  }
});

// Edit a pending order: quantities, per-part remarks, removed lines, and the
// order's own remarks. Refused once marked Ordered - that is a record of what
// was keyed into a Purchase Order.
app.patch("/api/part-requests/batch/:batchId", async (req, res) => {
  try {
    const body = req.body || {};
    if (!["sales", "purchaser", "admin"].includes(String(body.role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Sales, Purchaser and Admin can edit an order." });
    }
    res.json(await data.requests.updatePartRequestBatch(req.params.batchId, body));
  } catch (err) {
    if ([400, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/part-requests/batch/:batchId]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save the edit" });
  }
});

// Delete an order outright, whatever its status. The purchaser asked for it
// for the cases a status cannot express - a duplicate, a mistake, a request
// cancelled by phone. Purchaser and Admin only: editing is a correction, this
// is destruction, and it is the one action here with no undo. The frontend
// confirms; the repository names whoever did it in the log; the nightly
// backup is the way back.
app.delete("/api/part-requests/batch/:batchId", async (req, res) => {
  try {
    const role = String((req.query || {}).role || "").toLowerCase();
    if (!["purchaser", "admin"].includes(role)) {
      return res.status(403).json({ error: "Only the Purchaser and Admin can delete an order." });
    }
    res.json(await data.requests.deletePartRequestBatch(
      req.params.batchId, String((req.query || {}).who || "")
    ));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error("[DELETE /api/part-requests/batch/:batchId]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to delete the order" });
  }
});

// One order (batch) moves to ORDERED as a whole: the purchaser has keyed the
// Purchase Order, and its parts travel together.
app.patch("/api/part-requests/batch/:batchId/ordered", async (req, res) => {
  try {
    res.json(await data.requests.markPartRequestBatchOrdered(req.params.batchId));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error("[PATCH /api/part-requests/batch/:batchId/ordered]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update the order" });
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
    // No AutoCount here at all: the stock number shown is the balance WHEN THE
    // ORDER WAS MADE, captured at creation and stored with the row. The list
    // is a plain local read however long the history grows.
    res.json(await data.requests.listPartRequests(String(req.query.status || "PENDING")));
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

// Move a part to a different shelf (Find Part / IPL -> Change location).
// The THIRD write into the accounting database, and unlike the price one it
// deliberately overwrites: a location is meant to change when a part moves.
// So the safety is a confirmation the person must read - the old value comes
// back from the same query that performs the write - plus an exact item code,
// one column on one row, and a permanent log of what it used to be.
//
// Admin only. As with prices, that is an accident guard rather than security:
// the app has no logins, so the role comes from the browser. It stops a
// technician changing a shelf by mistake, which is what it is for.
app.post("/api/part-location", async (req, res) => {
  const { logLocationEvent } = require("./priceLog");
  const { item_code, shelf, who = "", role = "" } = req.body || {};
  const stamp = (outcome, extra = {}) =>
    logLocationEvent({
      source: (req.body || {}).source || "Find Part",
      itemCode: extra.item_code || item_code,
      oldShelf: extra.old_shelf === undefined ? null : extra.old_shelf,
      newShelf: extra.new_shelf || shelf,
      who: `${who || "?"} (${role || "?"})`,
      outcome,
    });

  try {
    // Who is asking comes first: it is the cheapest check, it needs no database,
    // and "Only Admin can change a location" is the honest answer to give a
    // technician - "AutoCount is not enabled" would send them to the wrong place.
    if (String(role || "").toLowerCase() !== "admin") {
      stamp("REFUSED - not an admin");
      return res.status(403).json({ error: "Only Admin can change a part's location." });
    }
    if (!String(who || "").trim()) {
      return res.status(400).json({ error: "Missing initials, so the change could not be traced." });
    }
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") {
      return res.status(503).json({ error: "AutoCount is not enabled." });
    }
    const acRepo = require("./data/autocountRepo");
    if (!acRepo.locationWritebackEnabled()) {
      return res.status(403).json({
        error: "Changing locations is switched off. Ask IT about AUTOCOUNT_LOCATION_WRITEBACK.",
      });
    }

    const r = await acRepo.setPartShelf(item_code, shelf);
    const messages = {
      updated: `Location changed to ${r.new_shelf} in AutoCount.`,
      unchanged: `That is already the location — nothing was changed.`,
      not_found: `"${item_code}" is no longer in AutoCount.`,
      no_uom_row: `This item has no unit-of-measure row in AutoCount, so the location must be set there.`,
    };
    stamp(r.status === "updated" ? "updated in AutoCount" : `no change - ${r.status}`, r);
    if (r.status !== "updated") {
      return res.status(409).json({ error: messages[r.status] || "Nothing was changed.", status: r.status });
    }
    res.json({ ...r, message: messages.updated });
  } catch (err) {
    stamp(`FAILED - ${err.message}`);
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[POST /api/part-location]", err.message);
    res.status(500).json({ error: "Could not save the location to AutoCount." });
  }
});

// How much of this part is already on order from a supplier, and on which
// Purchase Orders. Asked at the moment someone is about to request more, so
// they can see it has been handled rather than asking twice.
//
// Answers { supported: false } when AutoCount's Purchase Orders cannot be
// read in the shape expected - the app then shows nothing rather than a
// number that might be wrong. Run backend/inspect-po.js to see what is there.
app.get("/api/part-on-order/:code", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ supported: false, qty: 0, orders: [] });
    const acRepo = require("./data/autocountRepo");
    const code = String(req.params.code || "").trim();
    const map = await acRepo.getOnOrder([code]);
    if (!map) return res.json({ supported: false, qty: 0, orders: [] });
    const hit = map.get(code) || { qty: 0, orders: [] };
    res.json({ supported: true, qty: hit.qty, orders: hit.orders });
  } catch (err) {
    console.error("[GET /api/part-on-order]", err.message);
    // Never block an order over this: it is context, not permission.
    res.json({ supported: false, qty: 0, orders: [] });
  }
});

// A note kept against a part - usually what replaced it. Read by anyone;
// written by Sales, Purchaser and Admin. The role check is the same accident
// guard used everywhere else here: this app has no logins, so it stops a
// technician changing something by mistake rather than stopping an intruder.
app.get("/api/part-notes/:code", async (req, res) => {
  try {
    res.json(await data.notes.getPartNote(req.params.code) || { note: "" });
  } catch (err) {
    console.error("[GET /api/part-notes]", err.message);
    res.json({ note: "" });          // a missing note must never break a lookup
  }
});

app.post("/api/part-notes", async (req, res) => {
  try {
    const { item_code, note, who = "", role = "" } = req.body || {};
    if (!["sales", "purchaser", "admin"].includes(String(role).toLowerCase())) {
      return res.status(403).json({ error: "Only Sales, Purchaser and Admin can change a part note." });
    }
    res.json(await data.notes.setPartNote(item_code, note, who));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[POST /api/part-notes]", err);
    res.status(500).json({ error: "Could not save the note." });
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

// The customer's signature, fetched only when the slip PDF is being drawn.
// It is deliberately NOT part of the slip response - see getSlip.
app.get("/api/slips/:slip/signature", async (req, res) => {
  try {
    res.json(await data.slips.getSlipSignature(req.params.slip));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error("[GET /api/slips/:slip/signature]", err);
    res.status(500).json({ error: "Failed to fetch the signature" });
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

// Update a part line: quantity (0 removes), unit_price, and - for the A5-A8
// and MISC codes only - the description.
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
    if (body.description !== undefined) {
      result = await data.slips.setPartDescription(partId, body.description);
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

// ---- Moving a machine along -------------------------------------------------
//
// One machine, one state, one route. Quoting and the customer's answer used to
// be three separate endpoints writing two columns between them, which is how a
// machine ended up quoted and awaiting a quote at once.
//
//   RECEIVED -> AWAITING_QUOTE   sales, please quote this
//   AWAITING_QUOTE -> QUOTED     quoted; waiting on the customer
//   QUOTED -> TO_REPAIR          the customer said go ahead
//   QUOTED -> CONDEMNED          the customer said no
//   anything -> TO_REPAIR        no quotation needed, just do it
//
// Who is told depends on the direction. Sales are told when work arrives for
// them; the technicians who worked on THAT machine are told when the answer
// comes back, because a slip may hold another machine that is nothing to do
// with them and a notification everyone gets is one nobody reads.
async function notifyStateChange(slip, machineId, before, state) {
  try {
    const m = (slip.machines || []).find((x) => x.id === machineId);
    const desc = m ? m.machine_desc : "machine";

    if (state === "AWAITING_QUOTE" && before !== "AWAITING_QUOTE") {
      const waiting = (slip.machines || []).filter((x) => x.state === "AWAITING_QUOTE").length;
      const total = (slip.machines || []).length;
      await push.notify(pushDb, QUOTE_NOTIFY_ROLES, {
        title: "Ready to quote",
        body: `${slip.slip_number} · ${slip.company} · ${desc}` +
              (total > 1 ? ` (${waiting} of ${total})` : ""),
        slip: slip.slip_number,
      });
      return;
    }

    // The answer to a quotation, which is the only thing the workshop is
    // waiting on. Deciding to repair a machine nobody quoted is not news.
    const answered = (before === "QUOTED" || before === "AWAITING_QUOTE") &&
                     (state === "TO_REPAIR" || state === "CONDEMNED");
    if (answered) {
      const techs = await data.slips.techniciansForMachine(machineId);
      await push.notifyTechs(pushDb, techs, {
        title: `${state === "TO_REPAIR" ? "Repair" : "Condemn"}: ${desc}`,
        body: `${slip.slip_number} · ${slip.company} · the customer says ${
          state === "TO_REPAIR" ? "go ahead with the repair" : "do not repair - condemn it"
        }`,
        slip: slip.slip_number,
      });
    }
  } catch (e) {
    console.error("[push] notify failed:", e.message);
  }
}

async function handleMachineState(req, res) {
  try {
    const machineId = Number(req.params.id);
    const state = String((req.body || {}).state || "").toUpperCase();
    // Read the machine before the change: what to send, and to whom, depends
    // on where it was, and afterwards that is gone.
    const prev = await data.slips.getSlip(req.params.slip);
    const before = ((prev && prev.machines) || []).find((m) => m.id === machineId);
    const slip = await data.slips.setMachineState(
      req.params.slip, machineId, state, (req.body || {}).who || ""
    );
    res.json(slip);
    // Answer first, notify after: a push is a round trip to Google or Apple,
    // and the person who tapped the button should not wait for it.
    notifyStateChange(slip, machineId, before ? before.state : "", state);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/machines/:id/state]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update the machine" });
  }
}
app.patch("/api/slips/:slip/machines/:id/state", handleMachineState);

// The same move applied to every machine on the slip - "all of these need
// quoting", "none of them do". Machines already billed or already disposed of
// are left where they are.
async function handleSlipState(req, res) {
  try {
    const state = String((req.body || {}).state || "").toUpperCase();
    const prev = await data.slips.getSlip(req.params.slip);
    const slip = await data.slips.setAllMachineStates(
      req.params.slip, state, (req.body || {}).who || ""
    );
    res.json(slip);

    if (state === "AWAITING_QUOTE") {
      // One push for the slip, not one per machine: sales are being told there
      // is a slip to quote, and they will see the machines when they open it.
      const fresh = ((prev && prev.machines) || [])
        .filter((m) => m.state !== "AWAITING_QUOTE").length;
      if (fresh) {
        const n = (slip.machines || []).length;
        push.notify(pushDb, QUOTE_NOTIFY_ROLES, {
          title: "Ready to quote",
          body: `${slip.slip_number} · ${slip.company} · ${n} machine${n === 1 ? "" : "s"}`,
          slip: slip.slip_number,
        }).catch((e) => console.error("[push] notify failed:", e.message));
      }
    }
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/state]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update the slip" });
  }
}
app.patch("/api/slips/:slip/state", handleSlipState);

// A condemned machine is still in the workshop until somebody says where it
// went. Until then the slip will not close.
app.patch("/api/slips/:slip/machines/:id/disposal", async (req, res) => {
  try {
    const slip = await data.slips.setMachineDisposal(
      req.params.slip, Number(req.params.id),
      String((req.body || {}).disposal || "").toUpperCase(), (req.body || {}).who || ""
    );
    res.json(slip);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/machines/:id/disposal]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to record the disposal" });
  }
});

// ---- The three routes this replaced -----------------------------------------
// A phone runs its cached copy of the app until its second open, so for a shift
// or so after a deploy these are still being called. They translate into the
// new model rather than 404 at a technician mid-job. Nothing new calls them.
const LEGACY_STATE = {
  NEED_QUOTE: "AWAITING_QUOTE",
  QUOTED: "QUOTED",
  IN_PROGRESS: "TO_REPAIR",
  REPAIR: "TO_REPAIR",
  CONDEMN: "CONDEMNED",
  "": "RECEIVED",
};

app.patch("/api/slips/:slip/status", (req, res) => {
  const state = LEGACY_STATE[String((req.body || {}).status || "").toUpperCase()];
  if (!state) return res.status(400).json({ error: "Invalid status." });
  req.body = { state, who: (req.body || {}).who || "" };
  return handleSlipState(req, res);
});

for (const path of ["/api/slips/:slip/machines/:id/quote", "/api/slips/:slip/machines/:id/decision"]) {
  app.patch(path, (req, res) => {
    const body = req.body || {};
    // "quote" sent quote_status, "decision" sent decision, and an empty
    // quote_status meant "not waiting to be quoted" - a real value, not a
    // missing one, so it is read with !== undefined rather than || "".
    const asked = String(body.quote_status !== undefined ? body.quote_status : (body.decision || "")).toUpperCase();
    const state = LEGACY_STATE[asked];
    if (!state) return res.status(400).json({ error: "Invalid value." });
    req.body = { state, who: body.who || "" };
    return handleMachineState(req, res);
  });
}

// Edit a slip's registration details: company, contacts, notes, and each
// machine's name, serial and intake remarks. The work - parts, labour,
// status - is untouched; a closed slip is refused.
app.patch("/api/slips/:slip/details", async (req, res) => {
  try {
    const body = req.body || {};
    if (!["sales", "purchaser", "admin"].includes(String(body.role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Sales, Purchaser and Admin can edit a slip." });
    }
    res.json(await data.slips.updateSlipDetails(req.params.slip, { ...body, who: body.who || "" }));
  } catch (err) {
    if ([400, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/details]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save the edit" });
  }
});

// Push an app order into AutoCount as a Sales Order. Kept separate from the
// conversion itself so a failure here never undoes work the workshop has
// already done - the slip stays converted and the push can be retried.
// Every attempt, kept as plain text beside the app. A write into the accounts
// that quietly does not happen is the failure mode worth guarding against, and
// a toast lasts four seconds.
function logAutoCountOrder(soNumber, outcome, detail) {
  const fs = require("fs");
  const path = require("path");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
               `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const flat = String(detail || "").split(/\s+/).join(" ").trim();
  const line = `${when} | ${soNumber} | ${outcome} | ${flat}` + String.fromCharCode(10);
  try {
    fs.appendFileSync(path.join(__dirname, "autocount-orders.log"), line);
  } catch (e) {
    console.error("[autocount-orders log]", e.message);
  }
}

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

  let out;
  try {
    out = await so.createSalesOrder({
      slipNumber: slip.slip_number,
      debtorCode: slip.debtor_code || "C0112",
      contactName: slip.contact_name,
      contactNumber: slip.contact_number,
      lines: order.lines || [],
    });
  } catch (e) {
    // Keep the reason on the order itself, so it can be read tomorrow.
    await data.slips.setOrderAutocountError(soNumber, e.message);
    logAutoCountOrder(soNumber, "FAILED", e.message);
    throw e;
  }
  await data.slips.setOrderAutocountDocNo(soNumber, out.doc_no);
  logAutoCountOrder(soNumber, "WRITTEN", `${out.doc_no} (DocKey ${out.doc_key}, ${out.lines} lines)`);

  // Adopt AutoCount's number as the app's own, so staff see one number for the
  // order rather than the app's SO-2026-00003 next to AutoCount's SO-2608-003.
  const renamed = await data.slips.renameOrder(soNumber, out.doc_no);

  return {
    pushed: true,
    doc_no: out.doc_no,
    doc_key: out.doc_key,
    lines: out.lines,
    totals: out.totals,
    so_number: renamed.so_number,
    rename_note: renamed.ok ? undefined : renamed.reason,
  };
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

    // Report the number the order actually carries now - AutoCount's, if it
    // got there.
    const finalSo = (autocount && autocount.so_number) || result.so_number;
    res.status(201).json({ ...result, so_number: finalSo, price_sync: priceSync, autocount });
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
