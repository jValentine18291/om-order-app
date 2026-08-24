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
    const { company, contact_name, contact_number, whatsapp_number, check_service, quote_first, notes, machines, signature } = req.body || {};
    const slip = await data.slips.createSlip({ company, contact_name, contact_number, whatsapp_number, check_service, quote_first, notes, machines, signature });
    res.status(201).json(slip);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[POST /api/slips]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to create slip" });
  }
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
    if (!["sales", "purchaser"].includes(String(role || "").toLowerCase())) {
      stamp("REFUSED - role not allowed");
      return res.status(403).json({ error: "Only Sales and Purchaser can set a price." });
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

// Create the Sales Order for a slip (-> ALL_REPAIRED)
// If AutoCount price write-back is enabled, prices keyed in by staff for parts
// that had NO price in AutoCount are saved to AutoCount's ItemUOM at this
// moment. Failures never block the Sales Order — they are logged and reported.
app.post("/api/slips/:slip/order", async (req, res) => {
  try {
    const result = await data.slips.createSlipOrder(req.params.slip);

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
                // Only log not-found skips; has-price skips are the normal case
                // for every ordinarily-priced part and would flood the log.
                if (r.status === "skipped_not_found") {
                  logPriceEvent({
                    source: `Slip ${slip.slip_number}`, itemCode: part.item_code,
                    tier: "Contractor Price",
                    oldPrice: null, newPrice: part.unit_price,
                    who: part.technician, outcome: "SKIPPED - item not found in AutoCount",
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

    res.status(201).json({ ...result, price_sync: priceSync });
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/order]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to create order" });
  }
});

// Close a slip (Close Service) — requires DO/CS/INV ref
// The Sales Order raised for a slip (for the keyable AutoCount block view).
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
