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
//
// NOT behind the gate below. The sign-in screen is part of it, and a login
// page you have to be logged in to see is a locked door with the handle on the
// inside. The parts drawings sit here too; they are Husqvarna's published
// artwork, not anybody's customer.
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---- Who is asking -------------------------------------------------------
// THE GATE. Everything under /api goes through here, so a route cannot be
// forgotten by being written later - which is exactly how the old role checks
// ended up covering four routes out of seventy-five.
//
// It runs in one of two modes, and the mode is a row in the database rather
// than a line in the code:
//
//   OFF  the app behaves exactly as it always has. A token is still read and
//        honoured where one is sent, so passwords can be handed out and tried
//        one person at a time while everybody else carries on working.
//   ON   no valid token, no /api. That is the whole point.
//
// It ships OFF. A deploy that locks the counter out of its own app at ten past
// nine is not a security improvement, it is an outage - and the people it
// stops are the ones with a customer in front of them.
const auth = require("./auth");

// The handful of things that must work before anybody is signed in.
//   login      obviously.
//   users      the sign-in screen lists names to tap, exactly as the old
//              picker did. The names are already on the wall of the workshop;
//              hiding them would buy nothing and cost every technician the
//              spelling of their own colleague.
//   cert.pem   fetched by the device itself while trusting the server, before
//              any of this exists.
//   first-code somebody choosing their first code has no token yet - that is
//              what they are here to get. Leaving it out meant nobody could
//              ever set a code once logins were on, which is to say nobody
//              could ever sign in. Missed by the first round of tests because
//              they exercised it with the switch OFF, where everything is let
//              through; found by doing it in a browser with the switch on.
const OPEN = new Set(["/auth/login", "/auth/first-code", "/auth/users", "/cert.pem"]);

app.use("/api", (req, res, next) => {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Always resolved, in both modes, so anything that records WHO did something
  // records the person the server knows about rather than the name a browser
  // sent about itself.
  req.user = token ? auth.sessionUser(token) : null;

  if (!auth.requireLogin()) return next();
  if (OPEN.has(req.path)) return next();
  if (req.user) return next();
  res.status(401).json({ error: "Please sign in.", login_required: true });
});

// What a route says when somebody signed in asks for something their job does
// not include. Used in place of the old checks, which read a role out of the
// request body - a word the browser chose for itself.
//
// With the gate off there is nobody to check, and it lets the request through:
// the app then behaves as it did before logins existed, which is the point of
// being able to turn this on and off.
function needRole(req, res, roles) {
  if (!auth.requireLogin()) return true;
  const role = (req.user && req.user.role) || "";
  if (roles.includes(role)) return true;
  res.status(403).json({ error: `This needs ${roles.join(" or ")}. You are signed in as ${role || "nobody"}.` });
  return false;
}

// ADMIN ROUTES ARE NEVER PERMISSIVE, switch or no switch.
//
// needRole() above lets everything through while logins are off, so that
// turning them on is the only thing that changes behaviour and nothing
// regresses in the meantime. That reasoning does not hold here: these routes
// did not exist before logins did, so there is no "how it behaved yesterday"
// to preserve - and one of them SETS SOMEBODY'S PASSWORD.
//
// Written the permissive way first, and caught by tools/test-auth-gate.js
// before it went anywhere: with the switch off, which is how this ships, any
// caller at all could have set any password on the system. That would have
// been worse than the nothing it replaced.
//
// Signing in works whether or not it is required, so an admin can always reach
// these - they just have to be signed in, which is the point.
function needAdmin(req, res) {
  if (req.user && req.user.role === "admin") return true;
  res.status(req.user ? 403 : 401).json({
    error: req.user
      ? "Only an admin can do this."
      : "Sign in as an admin first.",
  });
  return false;
}

// ---- Signing in ----------------------------------------------------------
// The names, for the screen that asks which one you are. No hashes, and only
// people who are still here.
app.get("/api/auth/users", (_req, res) => {
  res.json({
    users: auth.listUsers({ activeOnly: true })
      .map((u) => ({ id: u.id, name: u.name, role: u.role,
                     has_password: !!u.has_password,
                     // So the screen can say "choose your code" instead of
                     // asking for one they have not got.
                     setup_open: !!u.setup_open,
                     // Which home buttons they get. Here, on the one route
                     // that answers before anybody has signed in, because
                     // signing in is still switched off on this server and
                     // the home screen has to be right either way.
                     //
                     // It gives away no more than the role beside it already
                     // does - the job's list is in a file the browser loads
                     // anyway - and it is the person's own phone asking.
                     functions: u.effective_functions })),
    require_login: auth.requireLogin(),
  });
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { user_id, password, device } = req.body || {};
    const r = auth.login(user_id, password, device);
    res.json(r);
  } catch (err) {
    // 401, 409 and 429 are answers, not faults, and the messages are already
    // written to give nothing away. Anything else is a bug and says so.
    if (err.status) return res.status(err.status).json({ error: err.message, setup: !!err.setup });
    console.error("[POST /api/auth/login]", err);
    res.status(500).json({ error: "Could not sign in." });
  }
});

// The first code somebody chooses for themselves.
//
// Open to anybody, because the person using it has no way to prove who they
// are yet - that is what it is for. What stops it being a way to walk into
// somebody else's account is that an ADMIN has to have opened that account
// first, on the Users screen, moments before. See setup_open in db.js.
app.post("/api/auth/first-code", (req, res) => {
  try {
    const { user_id, password, device } = req.body || {};
    auth.firstCode(user_id, password);
    // Straight in, rather than made to sign in again with the code they typed
    // ten seconds ago.
    res.json(auth.login(user_id, password, device));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/auth/first-code]", err);
    res.status(500).json({ error: "Could not set the code." });
  }
});

// Who the server thinks you are. The app asks on every start, so a revoked
// device finds out the moment it is next opened rather than the next time
// somebody tries to save something.
app.get("/api/auth/me", (req, res) => {
  res.json({
    user: req.user ? {
      id: req.user.id, name: req.user.name, role: req.user.role, tech: req.user.tech || "",
      // Worked out on the server, so a browser cannot decide for itself which
      // buttons it is entitled to.
      functions: req.user.effective_functions,
    } : null,
    require_login: auth.requireLogin(),
  });
});

app.post("/api/auth/logout", (req, res) => {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) auth.revokeSession(header.slice(7).trim());
  res.json({ ok: true });
});

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
// A slip becoming a Sales Order is the counter's cue to invoice it. The
// technician who just converted it is on the other side of that handover, so
// not them - and they cannot receive it anyway, since only Open Service has
// the button and that is a technician's screen.
//
// Same list as the quote one, and deliberately its own constant: they answer
// different questions and either could change without the other.
const SO_NOTIFY_ROLES = ["sales", "purchaser", "admin"];

// A shipment moving is news for whoever is waiting on the parts: sales have
// customers asking, technicians have machines on the floor waiting for them.
// Iris is on it too - she made the change, but she also has a phone that is
// not the one she made it on.
const SHIPMENT_NOTIFY_ROLES = ["sales", "tech", "purchaser", "admin"];

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
// What AutoCount calls each machine, looked up once at registration and stored
// on the slip.
//
// Here rather than when a document is built, for two reasons: a quotation must
// still print with AutoCount unreachable, and a slip of six machines would
// otherwise cost six queries every time anyone produced one.
//
// Only asked for models that machine-types.js does not already know, and a
// failure is silent by design - the machine is then named exactly as it was
// typed, which is what it did before any of this existed.
const MACHINE_TYPES = require("../frontend/machine-types.js");
async function withMachineTypes(machines) {
  const list = Array.isArray(machines) ? machines : [];
  if ((process.env.ITEMS_SOURCE || "sqlite").toLowerCase() !== "autocount") return list;
  const acRepo = require("./data/autocountRepo");
  const seen = new Map();
  return Promise.all(list.map(async (m) => {
    const desc = String((m && m.desc) || "").trim();
    if (!desc || MACHINE_TYPES.typeFor(desc) || MACHINE_TYPES.namesAType(desc)) return m;
    if (!seen.has(desc)) {
      seen.set(desc, acRepo.machineCategory(desc).catch((e) => {
        console.error("[machine-type]", desc, e.message);
        return "";
      }));
    }
    return { ...m, machine_type: await seen.get(desc) };
  }));
}

app.post("/api/slips", async (req, res) => {
  try {
    // Named one by one rather than spread, so nothing a client invents reaches
    // the database - which also means a new field has to be added HERE as well
    // as to the form and the table. contact2 was added in three places and
    // arrived empty until it was added in the fourth.
    const { company, debtor_code, contact_name, contact_number, whatsapp_number, contact2_name, contact2_number, check_service, repair_only, quote_first, notes, machines, signature, created_by } = req.body || {};
    const withTypes = await withMachineTypes(machines);
    const slip = await data.slips.createSlip({ company, debtor_code, contact_name, contact_number, whatsapp_number, contact2_name, contact2_number, check_service, repair_only, quote_first, notes, machines: withTypes, signature, created_by });
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
    // The contact this send was for goes in the log beside the number. Two
    // sends of one slip to two people are otherwise two near-identical lines.
    const label = Number(req.query.contact || 1) === 2 ? " [contact 2]" : "";
    const stamp = (outcome, detail, to) =>
      logSend({ slip: req.params.slip, to: String(to || "") + label, outcome, detail,
                who: role ? `${who} (${role})` : who });

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

      // WHICH of the slip's contacts this send is for. The client names the
      // contact; the SERVER looks up the number.
      //
      // That way round on purpose. A number taken from the request would let
      // anything that can reach this route post a customer's signed slip to
      // any phone in the world, and the log would faithfully record that we
      // did it. Naming a contact can only ever reach a number the slip itself
      // carries.
      const contacts = data.slips.slipContacts(slip);
      const wanted = Number(req.query.contact || 1) === 2 ? 2 : 1;
      const picked = contacts.find((c) => c.id === wanted);
      if (!picked) {
        return res.status(400).json({
          error: wanted === 2
            ? "This slip has no second contact number."
            : "This slip has no contact number to send to.",
        });
      }
      const to = picked.number;
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

// ---- The customer's copy, kept in Drive -------------------------------------
// Asked before the app offers a link, so staff are never shown a button that
// cannot work. The missing-settings list is deliberately included: when this is
// off it is nearly always one unset value on the server.
app.get("/api/drive/status", (req, res) => {
  const drive = require("./drive");
  const r = drive.readiness();
  res.json({ enabled: r.enabled, configured: r.configured, missing: r.missing });
});

// The PDF is built on the phone, by the same code that draws the copy staff
// look at, then posted up as raw bytes. Sending the finished file rather than
// having the server rebuild it means the customer cannot be given a subtly
// different document from the one that was signed.
//
// Uploading REPLACES this slip's existing file when there is one, so editing a
// slip and sending it again updates the document a customer already has a link
// to, instead of leaving two versions in the folder.
app.post(
  "/api/slips/:slip/pdf",
  express.raw({ type: "application/pdf", limit: "10mb" }),
  async (req, res) => {
    const drive = require("./drive");
    try {
      const ready = drive.readiness();
      if (!ready.enabled) {
        return res.status(403).json({ error: "Google Drive is switched off on this server." });
      }
      if (!ready.configured) {
        return res.status(503).json({ error: `Google Drive is not set up (missing ${ready.missing.join(", ")}).` });
      }
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: "No PDF was received." });
      }

      const slip = await data.slips.getSlip(req.params.slip);
      if (!slip) return res.status(404).json({ error: "Slip not found." });

      // Sharing is asked for only by the send path. Filing a slip on
      // registration leaves it readable by staff alone.
      const share = req.query.share === "1";
      const { fileId, link } = await drive.storeAndShare({
        slipNumber: slip.slip_number,
        company: slip.company,
        pdf: req.body,
        fileId: slip.drive_file_id || "",
        share,
      });
      // A link is only recorded once one exists; archiving must not wipe the
      // link a previous send handed to a customer.
      await data.slips.setSlipDrive(slip.slip_number, fileId, link || slip.drive_link || "");
      console.log(`[drive] slip ${slip.slip_number} ${share ? "shared" : "filed"} (${req.body.length} bytes)`);
      res.json({ ok: true, link });
    } catch (err) {
      // A Drive failure must never look like the slip itself failed - the
      // record is safe either way, and the app falls back to sharing the file
      // off the phone.
      console.error("[POST /api/slips/:slip/pdf]", err.message);
      res.status(502).json({ error: err.message || "Could not save the PDF to Drive." });
    }
  }
);

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

    // A one-line order is named rather than counted: "1 part" tells the
    // purchaser nothing, while "Diesel" or the part's own description tells
    // them whether it can wait until the afternoon.
    const n = rows.length;
    const what = n === 1 ? (rows[0].description || rows[0].item_code) : `${n} parts`;
    push.notify(pushDb, ORDER_NOTIFY_ROLES, {
      title: "New bulk order",
      body: `${what} · from ${rows[0].requester || "?"}`,
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
    // The role now comes from the session, not from the request. It used to be
    // read off body.role - a word the browser wrote about itself, which any
    // caller could have set to "admin".
    if (!needRole(req, res, ["sales", "purchaser", "admin"])) return;
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
    if (!needRole(req, res, ["purchaser", "admin"])) return;
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
// Who may change a price AutoCount ALREADY has. Everyone else may still fill
// in a blank one, which is the safe case: there is nothing to lose.
//
// Identified by the STAFF id, not by initials. John's initials are the single
// letter "J" (see initialsFor in app.js), and hanging a permission on one
// letter is asking for the day somebody is added whose initial is also J. The
// id is stable and unique, and the same comment in app.js says not to change
// one once it is in use.
//
// This is an accident guard, exactly like the role checks around it, and it is
// worth being plain about the limit: the app has no logins, so the id arrives
// from the browser and anyone who taps "John" on the user picker is John as far
// as this check can tell. What it stops is a wrong tap by someone who never
// meant to change a price, which is the realistic failure. What it cannot stop
// is somebody deliberately choosing another person's name - for that, the
// answer is the log, which records the id, the old price and the new one.
const PRICE_OVERWRITE_USERS = ["john"];

app.post("/api/part-prices", async (req, res) => {
  const { item_code, tier, price, who, role, user_id, overwrite } = req.body || {};
  const { logPriceEvent } = require("./priceLog");
  const stamp = (outcome, extra = {}) =>
    logPriceEvent({
      source: "Parts Diagram",
      itemCode: extra.item_code || item_code,
      tier: extra.tier || tier,
      oldPrice: extra.old_price ?? null,
      newPrice: price,
      // The id as well as the initials on an overwrite: this is the one write
      // that destroys a figure rather than filling a gap, and "J" on its own is
      // a thin thing to have to trace it by afterwards.
      who: overwrite
        ? `${who || "?"} (${role || "?"}, ${String(user_id || "?")}, OVERWRITE)`
        : `${who || "?"} (${role || "?"})`,
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
    if (!needRole(req, res, ["sales", "purchaser", "admin"])) {
      stamp("REFUSED - role not allowed");
      return;
    }
    if (!String(who || "").trim()) {
      return res.status(400).json({ error: "Enter your initials so the change can be traced." });
    }

    // Overwriting an existing price is a different act from filling in a blank
    // one, and is asked for explicitly rather than inferred: a client that
    // simply retried a "set" on a part somebody else had just priced must not
    // quietly become an overwrite.
    if (overwrite && !PRICE_OVERWRITE_USERS.includes(String(user_id || "").toLowerCase())) {
      // "unknown", not blank: the refusal happens before AutoCount is asked, so
      // the old price genuinely was not read - and it certainly was not absent.
      stamp("REFUSED - not allowed to change an existing price", { old_price: "unknown" });
      return res.status(403).json({
        error: "Only John can change a price that AutoCount already has.",
      });
    }

    const r = overwrite
      ? await acRepo.overwritePrice(item_code, tier, price)
      : await acRepo.setMissingPrice(item_code, tier, price);
    const messages = {
      updated: overwrite
        ? `${r.tier} changed from ${Number(r.old_price).toFixed(2)} to ${Number(r.new_price).toFixed(2)} in AutoCount.`
        : `${r.tier} set to ${Number(r.new_price).toFixed(2)} in AutoCount.`,
      already_priced: `${r.tier} is already set in AutoCount — nothing was changed.`,
      unchanged: `${r.tier} is already ${Number(r.new_price).toFixed(2)} — nothing was changed.`,
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
// Purchaser and Admin. As with prices, that is an accident guard rather than
// security: the app has no logins, so the role comes from the browser. It stops
// a technician changing a shelf by mistake, which is what it is for.
//
// The Purchaser is the person actually putting stock on the shelf, so she is
// the one who knows where it went - needing an admin to record that is how a
// location ends up stale, which costs more than the guard saves.
app.post("/api/part-location", async (req, res) => {
  const { logLocationEvent } = require("./priceLog");
  const sheets = require("./sheets");
  const { item_code, shelf, who = "", role = "", description = "" } = req.body || {};
  const stamp = (outcome, extra = {}) => {
    const source = (req.body || {}).source || "Find Part";
    const itemCode = extra.item_code || item_code;
    const oldShelf = extra.old_shelf === undefined ? null : extra.old_shelf;
    const newShelf = extra.new_shelf || shelf;
    logLocationEvent({
      source, itemCode, oldShelf, newShelf,
      who: `${who || "?"} (${role || "?"})`,
      outcome,
    });
  };

  // The Sheet gets only the moves that actually happened. It has no column
  // saying otherwise, so a refused or no-change attempt sitting in it would
  // read as a part that had moved when it had not. Everything else - the
  // refusals, the attempts on items AutoCount no longer has - stays in
  // location-updates.log, which is still the full record.
  //
  // Not awaited, and a failure is written back into the log rather than
  // thrown: this must never decide whether a location change succeeds. A sheet
  // that is obviously behind beats one quietly missing rows, and both beat a
  // change that fails because Google was down.
  const toSheet = (r) =>
    sheets
      .appendLocationChange({
        itemCode: r.item_code || item_code,
        description,
        oldShelf: r.old_shelf === undefined ? null : r.old_shelf,
        newShelf: r.new_shelf || shelf,
        who, role,
      })
      .catch((e) => {
        logLocationEvent({
          source: (req.body || {}).source || "Find Part",
          itemCode: r.item_code || item_code,
          oldShelf: r.old_shelf === undefined ? null : r.old_shelf,
          newShelf: r.new_shelf || shelf,
          who: `${who || "?"} (${role || "?"})`,
          outcome: `SHEET NOT UPDATED - ${e.message}`,
        });
        console.error("[sheets] location row not appended:", e.message);
      });

  try {
    // Who is asking comes first: it is the cheapest check, it needs no database,
    // and "Only Admin can change a location" is the honest answer to give a
    // technician - "AutoCount is not enabled" would send them to the wrong place.
    if (!needRole(req, res, ["purchaser", "admin"])) {
      stamp("REFUSED - not a purchaser or admin");
      return;
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
    toSheet(r);
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
// The same two facts for a whole cart, in one request.
//
// Bulk Order can hold a dozen parts and the answer is wanted for every one of
// them, so asking the single route a dozen times would be a dozen round trips
// and a dozen AutoCount queries. getOnOrder() already takes a list and chunks
// it; this hands it the lot.
//
// LEANER THAN THE SINGLE ROUTE, deliberately. No purchase-order numbers, no
// per-order status - a cart row has space for a sentence, and somebody who
// wants the detail taps the part and gets the full panel. What it does carry
// is the requests, because those are what will stop the order going through.
app.post("/api/parts-on-order", async (req, res) => {
  try {
    const codes = [...new Set(((req.body || {}).codes || [])
      .map((c) => String(c || "").trim()).filter(Boolean))].slice(0, 100);
    const parts = {};
    for (const code of codes) {
      let requests = [];
      try {
        requests = (data.requests.pendingRequestsFor(code) || []).map((r) => ({
          qty: Number(r.qty_requested) || 0,
          requester: r.requester || "",
          date: String(r.created_at || "").split(" ")[0],
        }));
      } catch (e) {
        console.error("[POST /api/parts-on-order] pending requests:", e.message);
      }
      parts[code] = {
        qty: 0,
        requested: requests.reduce((n, r) => n + r.qty, 0),
        requests,
      };
    }

    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount" || !codes.length) {
      return res.json({ supported: false, parts });
    }
    // The on-order half on its own, so a catalogue that is down costs the
    // quantities and not the requests - the same split as the single route.
    try {
      const map = await require("./data/autocountRepo").getOnOrder(codes);
      if (!map) return res.json({ supported: false, parts });
      for (const code of codes) {
        const hit = map.get(code);
        if (hit) parts[code].qty = hit.qty;
      }
      return res.json({ supported: true, parts });
    } catch (e) {
      console.error("[POST /api/parts-on-order] on order:", e.message);
      return res.json({ supported: false, parts });
    }
  } catch (err) {
    console.error("[POST /api/parts-on-order]", err);
    res.status(500).json({ supported: false, parts: {} });
  }
});

app.get("/api/part-on-order/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();

    // WHAT THE WORKSHOP HAS ALREADY ASKED FOR, and nobody has bought yet.
    //
    // Worked out FIRST and separately, because it comes out of our own
    // database and has nothing to do with AutoCount. The on-order half below
    // answers "supported: false" whenever the catalogue is sqlite or
    // unreachable, and the panel used to hide entirely on that answer - which
    // would have hidden this too, on exactly the day a catalogue outage makes
    // people most likely to order the same part twice.
    let requests = [];
    try {
      requests = (data.requests.pendingRequestsFor(code) || []).map((r) => ({
        qty: Number(r.qty_requested) || 0,
        requester: r.requester || "",
        // The date alone. Whoever is reading this wants "last Tuesday or this
        // morning", not the second it was saved.
        date: String(r.created_at || "").split(" ")[0],
        remarks: r.remarks || "",
      }));
    } catch (e) {
      console.error("[GET /api/part-on-order] pending requests:", e.message);
    }
    const requested = requests.reduce((n, r) => n + r.qty, 0);

    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") {
      return res.json({ supported: false, qty: 0, orders: [], requested, requests });
    }
    const acRepo = require("./data/autocountRepo");
    const map = await acRepo.getOnOrder([code]);
    if (!map) return res.json({ supported: false, qty: 0, orders: [], requested, requests });
    const hit = map.get(code) || { qty: 0, orders: [] };

    // Where each of those orders has actually got to - the same answer the
    // Purchase Orders screen gives, worked out the same way, so the two can
    // never disagree. "On order" on its own is the question half-answered:
    // raised last week and never sent is a different thing from on a container
    // that docks on Tuesday, and it is the difference between waiting and
    // chasing.
    //
    // Every part of this degrades on its own. A failed line read leaves Iris's
    // tick showing and nothing more; the whole block failing leaves the panel
    // exactly as it was before any of this existed.
    const docNos = hit.orders.map((o) => o.doc_no).filter(Boolean);
    let orders = hit.orders;
    if (docNos.length) {
      try {
        let lines = [];
        try { lines = (await acRepo.listPurchaseOrderLines(docNos)) || []; }
        catch (e) { console.error("[GET /api/part-on-order] line read:", e.message); }
        orders = poStatus.attach(hit.orders, {
          tracking: data.purchaseOrders.tracking(docNos),
          lines,
          allocated: data.shipments.allocatedByPo(docNos),
          delivered: data.shipments.receivedByPo(docNos),
        });
      } catch (e) {
        console.error("[GET /api/part-on-order] status:", e.message);
        orders = hit.orders;
      }
    }

    res.json({ supported: true, qty: hit.qty, orders, requested, requests });
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

// ---- Replacement parts ------------------------------------------------------
// What we fit when the part the book names cannot be had. Unlike a note, ANY
// role may record one, technicians included: they are who finds out, and a
// replacement that waits to be passed on is a replacement nobody records.
//
// The safety is not a role check, it is the catalogue. Every code is looked up
// in AutoCount before it is stored and refused if it is not there, so the worst
// a careless entry can be is the wrong REAL part - visible, priced, and
// correctable - rather than a code that silently leads nowhere. That is the
// whole reason this is a table of its own rather than more free text.
async function requireAutoCountItem(code) {
  const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
  if (itemsSource !== "autocount") {
    const e = new Error("AutoCount is not connected, so a replacement cannot be checked.");
    e.status = 503;
    throw e;
  }
  const acRepo = require("./data/autocountRepo");
  const item = await acRepo.findItem(code);
  const norm = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
  // findItem falls back to a trailing-match for scanned barcodes, which is
  // right when a person is scanning and wrong here: this code came from a list
  // the user picked from, so anything but the exact item means we resolved to
  // something they did not choose.
  if (!item || norm(item.item_code) !== norm(code)) {
    const e = new Error(`AutoCount has no part with the code ${code}.`);
    e.status = 400;
    throw e;
  }
  return item;
}

app.get("/api/part-replacements/:key", async (req, res) => {
  try {
    res.json({ results: await data.replacements.get(req.params.key, req.query.ipl_key || "") });
  } catch (err) {
    console.error("[GET /api/part-replacements]", err.message);
    // Same rule as the notes: this is an extra on a part sheet, and it must
    // never be the reason a lookup fails.
    res.json({ results: [] });
  }
});

// Which parts in a figure have one - asked once for the whole list.
app.post("/api/part-replacements/which", async (req, res) => {
  try {
    const keys = Array.isArray((req.body || {}).keys) ? req.body.keys : [];
    res.json({ counts: await data.replacements.counts(keys) });
  } catch (err) {
    console.error("[POST /api/part-replacements/which]", err.message);
    res.json({ counts: {} });
  }
});

app.post("/api/part-replacements", async (req, res) => {
  try {
    const { part_key, ipl_key = "", item_code, who = "" } = req.body || {};
    const item = await requireAutoCountItem(item_code);
    // The description is AutoCount's, not the caller's: a client that sent its
    // own could label the row anything it liked.
    res.json({
      results: await data.replacements.add({
        part_key, ipl_key, item_code: item.item_code, description: item.description, who,
      }),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/part-replacements]", err);
    res.status(500).json({ error: "Could not save the replacement." });
  }
});

// Removing one is not role-gated either, for the same reason as adding: a
// technician who has just discovered the substitute does not fit must be able
// to take it back out, and leaving a known-wrong answer on screen while waiting
// for the office is worse than either mistake.
app.delete("/api/part-replacements/:id", async (req, res) => {
  try {
    res.json(await data.replacements.remove(req.params.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[DELETE /api/part-replacements]", err);
    res.status(500).json({ error: "Could not remove the replacement." });
  }
});

// Find Part: search parts by description/code (suggestion list).
app.get("/api/parts-search", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ results: [] });
    const acRepo = require("./data/autocountRepo");
    // What the technician is working on, so their machine's own parts sort
    // first. Both are hints and neither filters anything out - see searchParts.
    const results = await acRepo.searchParts(String(req.query.q || ""), 15, {
      brand: String(req.query.brand || ""),
      prefer: String(req.query.prefer || "").split(",").filter(Boolean),
      models: String(req.query.models || "").split(",").filter(Boolean),
    });
    res.json({ results });
  } catch (err) {
    // Say that it BROKE, rather than answering with an empty list.
    //
    // An empty list is a real answer to a real question, and a failed query
    // returning one is indistinguishable from a part the catalogue does not
    // hold. That is how a malformed ORDER BY stayed up long enough to take
    // Find Part out for a working day: every screen said "No matching parts",
    // which is exactly what they say when there are none. Every caller of
    // this route is inside a try/catch and toasts the message.
    console.error("[GET /api/parts-search]", err.message);
    res.status(500).json({ results: [], error: `Part search failed: ${err.message}` });
  }
});


// ---- Accounts, for whoever runs the place ---------------------------------
// Admin only, and checked the same way everything else is now - from the
// session, not from a word in the request.
app.get("/api/admin/users", (req, res) => {
  if (!needAdmin(req, res)) return;
  res.json({ users: auth.listUsers(), require_login: auth.requireLogin() });
});

// Give somebody a password, or replace the one they have forgotten.
//
// There is deliberately no way to READ one, and no default. A default password
// is the one nobody changes, and a readable one is a password everybody in the
// office eventually knows.
app.post("/api/admin/users/:id/password", (req, res) => {
  if (!needAdmin(req, res)) return;
  try {
    res.json(auth.setPassword(req.params.id, (req.body || {}).password));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/admin/users/:id/password]", err);
    res.status(500).json({ error: "Could not set the password." });
  }
});

// Let somebody choose a new code - a new starter, or one who has forgotten.
//
// There is deliberately nothing here that READS a code, because nothing
// stores one: what is kept is a scrypt hash, and the whole value of that is
// that it cannot be turned back. This clears theirs and lets them pick a new
// one the next time they open the app.
app.post("/api/admin/users/:id/reset", (req, res) => {
  if (!needAdmin(req, res)) return;
  try {
    res.json(auth.openForSetup(req.params.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/admin/users/:id/reset]", err);
    res.status(500).json({ error: "Could not reset that person." });
  }
});

// Which home buttons one person gets.
//
// The list is validated against app-functions.js on the way in - the same file
// the home screen draws from - so a stored list can never name a button that
// does not exist.
app.post("/api/admin/users/:id/functions", (req, res) => {
  if (!needAdmin(req, res)) return;
  try {
    res.json(auth.setUserFunctions(req.params.id, (req.body || {}).functions));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/admin/users/:id/functions]", err);
    res.status(500).json({ error: "Could not save that." });
  }
});

// Every device anybody is signed in on, newest first. This is the screen that
// matters when a phone goes missing.
app.get("/api/admin/sessions", (req, res) => {
  if (!needAdmin(req, res)) return;
  res.json({ sessions: auth.listSessions() });
});

app.post("/api/admin/sessions/:id/revoke", (req, res) => {
  if (!needAdmin(req, res)) return;
  const done = auth.revokeSessionById(req.params.id);
  if (!done) return res.status(404).json({ error: "That device is already signed out." });
  res.json({ ok: true });
});

// ---- Purchase orders --------------------------------------------------------
// The ORDER is AutoCount's and is only ever read. What the app adds is the one
// thing AutoCount cannot know: whether Iris has actually emailed the PO to the
// supplier. She raises it there, consolidates it, and sends it herself, and
// nothing about that email reaches the accounts.
//
// Everyone reads. Only the Purchaser and Admin write - the same accident guard
// as part locations, and for the same reason: the role comes from the browser,
// so it stops the wrong person ticking something by mistake rather than
// stopping somebody determined.
const PO_WRITE_ROLES = ["purchaser", "admin"];

// What a notification says, kept apart from the sending of it so a test can
// read it without a push service. See backend/notifyText.js.
const notifyText = require("./notifyText");

// Where an order has got to, worked out rather than stored. See backend/poStatus.js.
const poStatus = require("./poStatus");

app.get("/api/purchase-orders", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ supported: false, orders: [] });
    const acRepo = require("./data/autocountRepo");
    const orders = await acRepo.listPurchaseOrders({ scope: String(req.query.scope || "open") });
    // null means the PO tables are not the shape this expects. Saying so is
    // the honest answer; an empty list would read as "no purchase orders",
    // which is a different problem with a different fix.
    if (!orders) return res.json({ supported: false, orders: [] });

    const docNos = orders.map((o) => o.doc_no);
    const tracking = data.purchaseOrders.tracking(docNos);

    // Where each order has got to, worked out from AutoCount's outstanding and
    // the app's shipments rather than typed in by anybody. Per LINE, then
    // rolled up: an order's totals would let one over-shipped line cover for
    // another line nobody has touched.
    //
    // If either read fails the cards still come back, showing Iris's tick and
    // nothing more. A listing that loads is worth more than a status.
    let lines = [];
    try { lines = (await acRepo.listPurchaseOrderLines(docNos)) || []; }
    catch (e) { console.error("[GET /api/purchase-orders] line read:", e.message); }
    const allocated = data.shipments.allocatedByPo(docNos);
    // What Iris has signed for but AutoCount may not have been told about yet.
    const delivered = data.shipments.receivedByPo(docNos);

    res.json({
      supported: true,
      orders: poStatus.attach(orders, { tracking, lines, allocated, delivered }),
    });
  } catch (err) {
    console.error("[GET /api/purchase-orders]", err.message);
    res.json({ supported: false, orders: [], error: "Could not read purchase orders." });
  }
});

app.get("/api/purchase-orders/:docNo", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ supported: false });
    const acRepo = require("./data/autocountRepo");
    const po = await acRepo.getPurchaseOrder(req.params.docNo);
    if (!po) return res.json({ supported: false });
    if (!po.found) return res.status(404).json({ error: "No such purchase order in AutoCount." });
    const t = data.purchaseOrders.status(po.doc_no);
    // What of this order is already on a shipment, per LINE. Shown beside the
    // outstanding figure rather than subtracted from it: the two are different
    // facts - what the supplier still owes, and what has been claimed for a
    // container - and quietly netting them off would hide whichever is wrong.
    //
    // exclude_shipment is sent by the form that is editing a shipment, so that
    // shipment's own lines do not come back looking like somebody else's claim.
    const allocated = data.shipments.allocatedByPo([po.doc_no], req.query.exclude_shipment);
    // Per-line progress, and the order's own. Worked out from the SAME
    // allocation the lines are shown with, so the chip on a line and the chip
    // at the top of the screen cannot tell two different stories.
    //
    // Note this uses the allocation with exclude_shipment applied when the
    // picker asked for it. That is right: the picker wants to know what is
    // claimed by OTHER shipments, and the status it draws beside a line should
    // answer the same question the box beside it does.
    const progress = poStatus.derive({
      docNo: po.doc_no, lines: po.items || [], allocated, tracked: t.status,
      delivered: data.shipments.receivedByPo([po.doc_no]),
    });
    const lineStatus = new Map(progress.lines.map((l, i) => [i, l.status]));
    res.json({
      supported: true, ...po,
      progress: progress.status, progress_label: progress.label,
      progress_counts: progress.counts,
      items: (po.items || []).map((it, i) => ({
        ...it,
        allocated: allocated.get(`${po.doc_no}#${it.seq == null ? "" : it.seq}`) || 0,
        progress: lineStatus.get(i),
      })),
      shipments: data.shipments.forPo(po.doc_no),
      status: t.status, ordered_at: t.ordered_at || "",
      updated_by: t.updated_by || "", updated_at: t.updated_at || "",
    });
  } catch (err) {
    console.error("[GET /api/purchase-orders/:docNo]", err.message);
    res.status(500).json({ error: "Could not read that purchase order." });
  }
});

app.patch("/api/purchase-orders/:docNo", (req, res) => {
  try {
    const { status, who = "", role = "" } = req.body || {};
    if (!PO_WRITE_ROLES.includes(String(role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Purchaser or Admin can change a purchase order." });
    }
    res.json(data.purchaseOrders.setStatus(req.params.docNo, status, who));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[PATCH /api/purchase-orders/:docNo]", err.message);
    res.status(500).json({ error: "Could not save that." });
  }
});

// ---- Shipments --------------------------------------------------------------
// Entirely the app's own: AutoCount knows nothing about a container or an ETA.
// Everyone reads - "when does my part get here" is asked all over the building
// - and only the Purchaser and Admin write.
app.get("/api/shipments", (req, res) => {
  try {
    res.json({ shipments: data.shipments.list({ scope: String(req.query.scope || "live") }) });
  } catch (err) {
    console.error("[GET /api/shipments]", err.message);
    res.status(500).json({ error: "Could not load shipments." });
  }
});

app.get("/api/shipments/:id", (req, res) => {
  try {
    const shipment = data.shipments.get(req.params.id);
    if (!shipment) return res.status(404).json({ error: "No such shipment." });
    res.json(shipment);
  } catch (err) {
    console.error("[GET /api/shipments/:id]", err.message);
    res.status(500).json({ error: "Could not load that shipment." });
  }
});

app.post("/api/shipments", (req, res) => {
  try {
    const { who = "", role = "" } = req.body || {};
    if (!PO_WRITE_ROLES.includes(String(role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Purchaser or Admin can create a shipment." });
    }
    res.status(201).json(data.shipments.create(req.body || {}, who));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[POST /api/shipments]", err.message);
    res.status(500).json({ error: "Could not save that shipment." });
  }
});

app.patch("/api/shipments/:id", (req, res) => {
  try {
    const { who = "", role = "" } = req.body || {};
    if (!PO_WRITE_ROLES.includes(String(role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Purchaser or Admin can change a shipment." });
    }
    // Read BEFORE the update: "Shipped becomes Arrived Singapore" is the thing
    // worth telling people, and after the write the previous status is gone.
    const before = data.shipments.get(req.params.id);
    const updated = data.shipments.update(req.params.id, req.body || {}, who);

    // Only on a real move. Correcting a container number is not news, and a
    // notification that fires on every save is one people turn off.
    if (before && before.status !== updated.status) {
      const msg = notifyText.shipmentStatusMessage(updated, before.status);
      // Not awaited, and it cannot throw: the status change is the thing that
      // matters, and telling people is a courtesy on top of it.
      push.notify(pushDb, SHIPMENT_NOTIFY_ROLES, msg)
        .catch((e) => console.error("[shipment notify]", e.message));
    }
    res.json(updated);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/shipments/:id]", err.message);
    res.status(500).json({ error: "Could not save that shipment." });
  }
});

// What is on a shelf. Read-only, and open to everyone: knowing where a part
// lives is the whole point of recording it, and a technician looking for one
// is exactly who needs the answer.
app.get("/api/parts-by-location", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ total: 0, results: [] });
    const acRepo = require("./data/autocountRepo");
    res.json(await acRepo.partsByShelf(String(req.query.q || ""), 100));
  } catch (err) {
    console.error("[GET /api/parts-by-location]", err.message);
    res.json({ total: 0, results: [], error: "Lookup failed." });
  }
});

// The machine models themselves, for the box the counter types into when a
// slip is registered. Returns nothing at all when AutoCount is not the item
// source, which is the same shape as parts-search: the field stays free text,
// so a machine that is not ours - or a lookup that cannot be reached - never
// stops a slip being written.
app.get("/api/machine-search", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ results: [] });
    const acRepo = require("./data/autocountRepo");
    const results = await acRepo.searchMachines(String(req.query.q || ""), 15);
    res.json({ results });
  } catch (err) {
    console.error("[GET /api/machine-search]", err.message);
    res.json({ results: [] });
  }
});

// Every part that fits one machine, from the item's second description line.
// Separate from parts-search because that matches the code and description too:
// searching "365" there returns anything with 365 in a part number, while this
// answers only "what fits a 365".
app.get("/api/parts-by-model", async (req, res) => {
  try {
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
    if (itemsSource !== "autocount") return res.json({ model: "", total: 0, results: [] });
    const acRepo = require("./data/autocountRepo");
    res.json(await acRepo.partsForModel(String(req.query.model || ""), Number(req.query.limit) || 200));
  } catch (err) {
    console.error("[GET /api/parts-by-model]", err.message);
    res.json({ model: String(req.query.model || ""), total: 0, results: [], error: "Lookup failed." });
  }
});

// THE CUSTOMER SIGNING FOR A CONDEMNED MACHINE. A second decision, taken in
// person and later than the slip's own signature: that this machine is beyond
// repair and they accept it.
app.post("/api/slips/:slip/machines/:id/condemn-signature", async (req, res) => {
  try {
    const body = req.body || {};
    const slip = await data.slips.setCondemnSignature(req.params.slip, Number(req.params.id), {
      image: body.image, who: body.who || "",
    });
    res.status(201).json(slip);
  } catch (err) {
    console.error("[POST condemn-signature]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/slips/:slip/machines/:id/condemn-signature", async (req, res) => {
  try {
    res.json(await data.slips.getCondemnSignature(req.params.slip, Number(req.params.id)));
  } catch (err) {
    console.error("[GET condemn-signature]", err.message);
    res.status(err.status || 500).json({ error: err.message });
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

// Add a part to the SLIP itself, belonging to no machine on it.
//
// Asked for by the workshop, Sep 2026: something sold alongside the repair
// rather than fitted to it. Before this the only place to put one was on a
// machine it was never fitted to, which billed it inside that machine's block.
app.post("/api/slips/:slip/parts", async (req, res) => {
  try {
    const parts = await data.slips.addPartToSlip(req.params.slip, req.body || {});
    res.status(201).json(parts);
  } catch (err) {
    if (err.status === 400 || err.status === 404 || err.status === 409) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("[POST /api/slips/:slip/parts]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to add part" });
  }
});

// The note against a slip's own parts. Internal - see setSlipExtrasNote.
app.patch("/api/slips/:slip/extras-note", async (req, res) => {
  try {
    const r = await data.slips.setSlipExtrasNote(req.params.slip, (req.body || {}).extras_note);
    res.json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/extras-note]", err);
    res.status(500).json({ error: "Could not save the note." });
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
// Save, on the technician's machine popup. The parts, labour and note have
// already gone up through the routes around this one; this is the last step,
// and it is what moves the machine to Repaired.
//
// A route of its own rather than a side effect of saving a part: a part is
// scanned in the middle of a job, and marking the machine finished then would
// be wrong. Pressing Save is the moment the technician says they are done.
app.post("/api/machines/:machineId/finish", async (req, res) => {
  try {
    const machineId = Number(req.params.machineId);
    const { who = "" } = req.body || {};
    const result = await data.slips.finishRepair(machineId, who);
    res.json(result);

    // Any price the technician had to look up goes into AutoCount now.
    //
    // Answer first, write after - the same shape as notifyStateChange below
    // it. Each part is a round trip to SQL Server, and the technician standing
    // at the bench should not wait on the accounts database to be told their
    // machine is saved. The write is recorded in price-updates.log either way,
    // and the pass at Sales Order conversion catches anything this misses.
    //
    // Run even when finishRepair moved nothing: a machine already marked
    // repaired can still have had a part added to it, and that part's price is
    // just as worth saving.
    const slipNumber = (result && result.slip && result.slip.slip_number) || "";
    if (slipNumber) {
      const machine = ((result.slip.machines || []).find((m) => m.id === machineId)) || {};
      // Not a machine already on an order: that batch has been through the
      // conversion pass, and its prices are AutoCount's business now.
      if (!String(machine.converted_at || "").trim()) {
        writeSlipPricesToAutoCount(machine.parts || [], `Slip ${slipNumber}`)
          .catch((e) => console.error("[price-writeback] on finish:", e.message));
      }
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/machines/:machineId/finish]", err);
    res.status(500).json({ error: "Could not finish that machine." });
  }
});

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
      return;
    }

    // Condemned from anywhere else - which now includes a technician doing it
    // at the bench when the customer balks at the price. Sales are the ones who
    // have to act on it: the machine still has to leave the building, and it
    // will not be on the invoice they were expecting to raise.
    if (state === "CONDEMNED" && before !== "CONDEMNED") {
      await push.notify(pushDb, QUOTE_NOTIFY_ROLES, {
        title: `Condemned: ${desc}`,
        body: `${slip.slip_number} · ${slip.company} · not being repaired - it still has to leave the workshop`,
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

// WHAT THIS SLIP'S ORDERS BECAME IN AUTOCOUNT, refreshed.
//
// Called by the app when somebody opens a slip - John's choice of moment, and
// the cheap one: it asks only about the slip being looked at, rather than
// sweeping the whole book all day.
//
// ITS OWN ROUTE, not part of GET /api/slips/:slip. Reading a slip must stay
// fast and must never fail because SQL Server is busy or off; this can take a
// moment and is allowed to come back with nothing. The screen shows the slip
// first and the chain when it arrives.
//
// EVERY FAILURE IS SILENT AND HARMLESS. No AutoCount, no answer, no change -
// and Close Service still takes a number typed by hand exactly as it does
// today.
app.post("/api/slips/:slip/documents/refresh", async (req, res) => {
  try {
    const slipNumber = req.params.slip;
    const orders = await data.slips.getSlipOrders(slipNumber);
    const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();

    // Whatever is already known, so the screen has something either way.
    const known = () => (orders || []).map((o) => ({
      so_number: o.so_number,
      autocount_doc_no: o.autocount_doc_no || "",
      closing_ref: o.closing_ref || "",
      documents: data.slips.orderDocuments(o.id),
    }));

    if (itemsSource !== "autocount") {
      return res.json({ supported: false, orders: known(), filled: [] });
    }

    const acRepo = require("./data/autocountRepo");
    let asked = 0;
    for (const o of orders || []) {
      const start = String(o.autocount_doc_no || "").trim();
      if (!start) continue;                       // never reached AutoCount
      try {
        const found = await acRepo.chainFrom([start]);
        data.slips.recordOrderDocuments(o.id, found);
        asked++;
      } catch (e) {
        // One order failing is not the others failing.
        console.error(`[documents/refresh] ${o.so_number}:`, e.message);
      }
    }

    // Only after everything found is written down, so the number chosen is the
    // best one available rather than the first one that happened to arrive.
    const { filled } = asked
      ? data.slips.autoInvoiceFromDocuments(slipNumber, "AutoCount")
      : { filled: [] };

    res.json({
      supported: true,
      orders: await (async () => {
        const fresh = await data.slips.getSlipOrders(slipNumber);
        return (fresh || []).map((o) => ({
          so_number: o.so_number,
          autocount_doc_no: o.autocount_doc_no || "",
          closing_ref: o.closing_ref || "",
          documents: data.slips.orderDocuments(o.id),
        }));
      })(),
      filled,
    });
  } catch (err) {
    console.error("[POST /api/slips/:slip/documents/refresh]", err);
    res.json({ supported: false, orders: [], filled: [] });
  }
});

// CORRECTING A MACHINE'S STATUS BY HAND. John's, and nobody else's.
//
// HOW STRONG THIS IS, said plainly. With signing in switched ON the answer
// comes from the session and is real - a phone cannot claim to be John. With
// it OFF, which is how the server still runs, nothing can prove who is asking
// and this falls back to what the browser says about itself. That is exactly
// as strong as every other role check in the app today, and no stronger.
// Turning the login switch on is what makes it a boundary rather than a
// label; until then it keeps the button off everybody else's screen, which is
// most of the point.
function needCorrector(req, res) {
  return needKeyholder(req, res, "canCorrect", "Only John can correct a machine's status.");
}

// The same question for deleting a slip. Its own capability over the same list
// of people - see KEYHOLDERS in app-functions.js.
function needDeleter(req, res) {
  return needKeyholder(req, res, "canDeleteSlips", "Only John can delete a service slip.");
}

function needKeyholder(req, res, fn, refusal) {
  const FN = require("../frontend/app-functions.js");
  if (auth.requireLogin()) {
    if (FN[fn](req.user)) return true;
  } else if (FN[fn]({ id: String((req.query || {}).user_id || (req.body || {}).user_id || "") })) {
    return true;
  }
  res.status(403).json({ error: refusal });
  return false;
}

// What deleting this slip would cost, asked before anybody agrees to it.
app.get("/api/slips/:slip/deletable", (req, res) => {
  if (!needDeleter(req, res)) return;
  try {
    res.json(data.slips.slipDeletable(req.params.slip));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[GET /api/slips/:slip/deletable]", err);
    res.status(500).json({ error: "Could not read that slip." });
  }
});

// And doing it.
app.post("/api/slips/:slip/delete", (req, res) => {
  if (!needDeleter(req, res)) return;
  try {
    const out = data.slips.deleteSlip(req.params.slip, (req.body || {}).who || "");
    console.log(`[delete-slip] ${req.params.slip} deleted by ${(req.body || {}).who || "?"}` +
      (out.frees_number ? ` - the number goes back` : ` - a gap is left`));
    res.json(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/delete]", err);
    res.status(500).json({ error: "Could not delete that slip." });
  }
});

app.post("/api/slips/:slip/machines/:id/correct", (req, res) => {
  if (!needCorrector(req, res)) return;
  try {
    const b = req.body || {};
    res.json(data.slips.correctMachine(req.params.slip, Number(req.params.id), {
      state: b.state,
      clear_comment: !!b.clear_comment,
      clear_labour: !!b.clear_labour,
      who: b.who || "",
    }));
  } catch (err) {
    if ([400, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/machines/:id/correct]", err);
    res.status(500).json({ error: err.message || "Could not correct the machine" });
  }
});

// Put a machine's status back to where it started, for the decision nobody
// meant to make. Its own route rather than a state of "RECEIVED" sent to the
// one above, because that route moves a machine along and asks no questions -
// this one refuses the moment there is anything recorded against the machine,
// and the check belongs with the act, not with the caller.
//
// No push notification: the point of this is that nothing happened.
app.post("/api/slips/:slip/machines/:id/undo", async (req, res) => {
  try {
    const body = req.body || {};
    if (!["sales", "purchaser", "admin"].includes(String(body.role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Sales, Purchaser and Admin can put a status back." });
    }
    res.json(await data.slips.undoMachineDecision(
      req.params.slip, Number(req.params.id), body.who || ""));
  } catch (err) {
    if ([400, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/machines/:id/undo]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to put the status back" });
  }
});

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
    if (!needRole(req, res, ["sales", "purchaser", "admin"])) return;
    // A machine renamed here needs its type looked up again, or the documents
    // would go on naming it after the model it used to be.
    const machines = Array.isArray(body.machines)
      ? await withMachineTypes(body.machines.map((m) => ({ ...m, desc: m.desc || m.machine_desc })))
      : body.machines;
    res.json(await data.slips.updateSlipDetails(req.params.slip,
      { ...body, machines, who: body.who || "" }));
  } catch (err) {
    if ([400, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error("[PATCH /api/slips/:slip/details]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to save the edit" });
  }
});

// Add a machine to a slip that is already registered - the one the counter
// forgot. Separate from the edit above because it is a different act and is
// recorded as one: that PATCH corrects what a machine is called, this POST
// says another machine came in.
app.post("/api/slips/:slip/machines", async (req, res) => {
  try {
    const body = req.body || {};
    if (!["sales", "purchaser", "admin"].includes(String(body.role || "").toLowerCase())) {
      return res.status(403).json({ error: "Only Sales, Purchaser and Admin can add a machine." });
    }
    // Looked up here, exactly as at registration, so the added machine is
    // named on the documents the same way the others are.
    const [machine] = await withMachineTypes([{ ...body, desc: body.desc || body.machine_desc }]);
    res.json(data.slips.addMachineToSlip(req.params.slip, machine, body.who || ""));
  } catch (err) {
    if ([400, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/machines]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to add the machine" });
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

// ---- Prices keyed on a slip, into AutoCount ---------------------------------
//
// Some parts have no price in AutoCount. The technician looks the price up in
// the office price list and types it on the slip; this is what carries it back,
// filling the blank so nobody has to look it up twice.
//
// Called from TWO places, deliberately:
//
//   when a technician presses Save on a machine  - the moment they say the job
//        is done, so the price is settled but nothing waits on Sales
//   when Sales convert the slip to a Sales Order - the backstop, for parts
//        added after Save, machines that were never finished, and slips
//        already in flight when this was written
//
// Running twice costs nothing: the write only ever fills a blank, so the second
// pass finds the price already set and skips it.
//
// THE WRITE IS ONE-WAY AND FINAL. It never overwrites, so whichever pass gets
// there first decides the price in AutoCount for good. That is why this fires
// at Save and not on every keystroke: a technician correcting a typo a minute
// later would not be able to correct AutoCount.
//
// Governed by AUTOCOUNT_PRICE_WRITEBACK_ORDERS. The name now under-describes
// it - it is one decision, "let prices keyed on a slip reach AutoCount", and
// splitting it in two would allow a state where Save writes and conversion
// does not, which is not a thing anybody would want.
async function writeSlipPricesToAutoCount(parts, source) {
  const out = { updated: [], skipped: 0, failed: [] };
  const itemsSource = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
  if (itemsSource !== "autocount") return out;
  if (String(process.env.AUTOCOUNT_PRICE_WRITEBACK_ORDERS || "false").toLowerCase() !== "true") return out;

  const acRepo = require("./data/autocountRepo");
  const { logPriceEvent } = require("./priceLog");
  for (const part of parts || []) {
    if (!(Number(part.unit_price) > 0)) continue;      // nothing keyed in
    try {
      const r = await acRepo.updateItemPriceIfMissing(part.item_code, part.unit_price);
      if (r.status === "updated") {
        out.updated.push(r.item_code);
        logPriceEvent({
          source, itemCode: r.item_code, tier: "Contractor Price",
          oldPrice: r.old_price, newPrice: r.new_price,
          who: part.technician, outcome: "updated in AutoCount",
        });
      } else {
        out.skipped++;
        // has-price skips are the normal case for every ordinarily priced part
        // and would flood the log. The other two are rare and each means a
        // price the staff expected to save did not, so they are worth a line.
        if (r.status === "skipped_not_found" || r.status === "skipped_no_uom_row") {
          logPriceEvent({
            source, itemCode: part.item_code, tier: "Contractor Price",
            oldPrice: null, newPrice: part.unit_price, who: part.technician,
            outcome: r.status === "skipped_no_uom_row"
              ? "SKIPPED - item has no unit-of-measure row in AutoCount"
              : "SKIPPED - item not found in AutoCount",
          });
        }
      }
    } catch (e) {
      out.failed.push(part.item_code);
      logPriceEvent({
        source, itemCode: part.item_code, tier: "Contractor Price",
        oldPrice: null, newPrice: part.unit_price, who: part.technician,
        outcome: `FAILED - ${e.message}`,
      });
    }
  }
  return out;
}

// Create the Sales Order for a slip (-> ALL_REPAIRED)
// If AutoCount price write-back is enabled, prices keyed in by staff for parts
// that had NO price in AutoCount are saved to AutoCount's ItemUOM at this
// moment. Failures never block the Sales Order — they are logged and reported.
app.post("/api/slips/:slip/order", async (req, res) => {
  try {
    // machine_ids lets the sales desk convert part of a slip; with none given
    // it takes everything not already on an order.
    // extras: put the slip's loose parts on this order too. Explicit rather
    // than assumed - they are ticked on the same screen as the machines, and
    // once they are on one order they are never offered again.
    const result = await data.slips.createSlipOrder(req.params.slip,
                     (req.body || {}).machine_ids,
                     { extras: !!(req.body || {}).extras });

    // ---- Price write-back (guarded, best-effort) ----
    // The backstop pass. Most parts were already written when the technician
    // pressed Save; this catches anything added since, and any machine that
    // reached an order without being finished. Parts already priced are
    // skipped, so a second pass over the same slip writes nothing.
    let priceSync = { updated: [], skipped: 0, failed: [] };
    try {
      const slip = await data.slips.getSlip(req.params.slip);
      // The slip's loose parts as well as every machine's. A price somebody
      // typed is a price somebody typed, whichever list it landed in, and the
      // whole point of the write-back is that the catalogue learns it once.
      const parts = (slip.machines || []).flatMap((m) => m.parts || [])
                      .concat(slip.extras || []);
      priceSync = await writeSlipPricesToAutoCount(parts, `Slip ${slip.slip_number}`);
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

    // Tell the counter. Until now a slip became an order in the workshop and
    // sales found out by looking; the whole point of an order waiting is that
    // nothing should wait because nobody knew.
    //
    // AFTER the response and never awaited: the order is committed by this
    // point, and a push that fails must not turn a successful conversion into
    // an error on a technician's phone. push.notify does not throw, and the
    // catch is here for the getSlip beside it.
    (async () => {
      const { salesOrderMessage } = notifyText;
      const slip = await data.slips.getSlip(req.params.slip);
      await push.notify(pushDb, SO_NOTIFY_ROLES, salesOrderMessage(slip, result, finalSo));
    })().catch((e) => console.error("[push] sales order notify failed:", e.message));
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

// Everything the Repair Quotation prints, built from the same lines the Sales
// Order is built from. Read-only: asking for a quotation never moves the slip
// on, so Sales can produce one, have it queried, and produce it again.
//
// The customer's address comes from AutoCount and is looked up here rather than
// in the browser, so a catalogue that is down or a debtor whose columns differ
// costs the quotation its address block and nothing more.
app.get("/api/slips/:slip/quotation", async (req, res) => {
  try {
    // extras=0 leaves the slip's loose parts off. The preview includes them
    // unless asked otherwise, so the screen opens showing what the Sales Order
    // will actually charge.
    // machines=3,7 quotes those two alone. Left off, every machine with work
    // recorded on it is quoted, which is what the screen opens showing.
    const chosen = String(req.query.machines || "").split(",")
                     .map((s) => Number(s.trim())).filter((n) => n > 0);
    const q = await data.slips.quotationForSlip(req.params.slip, chosen,
                    { service: String(req.query.service || ""),
                      extras: String(req.query.extras || "") !== "0" });
    q.debtor = null;
    if (q.debtor_code && (process.env.ITEMS_SOURCE || "sqlite").toLowerCase() === "autocount") {
      try {
        q.debtor = await require("./data/autocountRepo").getDebtor(q.debtor_code);
      } catch (e) {
        // Said, not swallowed: a quotation that silently loses the customer's
        // address looks like the address was never there.
        console.error("[GET /api/slips/:slip/quotation] debtor lookup:", e.message);
        q.debtor_error = e.message;
      }
    }
    res.json(q);
  } catch (err) {
    console.error("[GET /api/slips/:slip/quotation]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to build the quotation" });
  }
});

// Record that a quotation went out, and hand back what it is called.
//
// Separate from the GET above because this is the only part that writes. The
// GET builds a preview as often as anyone likes; this says "that one was
// sent", and only here can a re-send be told from a revision - which is the
// whole of the numbering rule.
app.post("/api/slips/:slip/quotation", async (req, res) => {
  try {
    const { payment = "", delivery = "", who = "", service = "", extras, machines } = req.body || {};
    const issued = await data.slips.issueQuotation(req.params.slip,
                       { payment, delivery, who, service, extras: extras !== false,
                         // Absent means every machine with work on it, which is
                         // what this route did before the choice existed and
                         // what an older phone still on a cached app will send.
                         machines: Array.isArray(machines)
                           ? machines.map(Number).filter((n) => n > 0) : undefined });
    issued.debtor = null;
    if (issued.debtor_code && (process.env.ITEMS_SOURCE || "sqlite").toLowerCase() === "autocount") {
      try {
        issued.debtor = await require("./data/autocountRepo").getDebtor(issued.debtor_code);
      } catch (e) {
        console.error("[POST /api/slips/:slip/quotation] debtor lookup:", e.message);
        issued.debtor_error = e.message;
      }
    }
    res.json(issued);
  } catch (err) {
    console.error("[POST /api/slips/:slip/quotation]", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to issue the quotation" });
  }
});

// File a Repair Quotation in the staff Drive folder.
//
// Filed only - no link is created and none is stored. The customer gets the
// quotation as an attachment off the phone; this is the office's own copy, so
// that "what did we quote them in September" has an answer that does not
// depend on someone's sent items.
//
// The PDF comes up as raw bytes from the browser that drew it, for the same
// reason the slip does: rebuilding it here would eventually produce a document
// subtly different from the one the customer was sent.
app.post(
  "/api/quotations/:ref/pdf",
  express.raw({ type: "application/pdf", limit: "10mb" }),
  async (req, res) => {
    const drive = require("./drive");
    try {
      const ready = drive.quotationReadiness();
      if (!ready.enabled) {
        return res.status(403).json({ error: "Google Drive is switched off on this server." });
      }
      if (!ready.configured) {
        return res.status(503).json({ error: `Quotation filing is not set up (missing ${ready.missing.join(", ")}).` });
      }
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: "No PDF was received." });
      }
      const q = await data.slips.quotationByRef(req.params.ref);
      if (!q) return res.status(404).json({ error: "No such quotation." });

      const slip = await data.slips.getSlip(q.slip_number);
      const fileId = await drive.storeQuotation({
        ref: q.ref,
        company: slip ? slip.company : "",
        pdf: req.body,
        fileId: q.drive_file_id || "",
      });
      await data.slips.setQuotationDrive(q.ref, fileId);
      console.log(`[drive] quotation ${q.ref} filed (${req.body.length} bytes)`);
      res.json({ ok: true });
    } catch (err) {
      // Filing is a convenience. A Drive failure must never look like the
      // quotation failed - it has a number, it is recorded, and the copy going
      // to the customer is already in the sender's hands.
      console.error("[POST /api/quotations/:ref/pdf]", err.message);
      res.status(502).json({ error: err.message || "Could not file the quotation." });
    }
  }
);

// Sales have keyed the Sales Order into AutoCount and got a DO/INV/CS number
// back. Its own step, before closing: only once this has happened does anyone
// ring the customer to come and collect.
app.post("/api/slips/:slip/invoiced", async (req, res) => {
  try {
    // so_number says which order the number is for. A slip with one order
    // does not need it; a slip with two does, and the repo refuses without it
    // rather than guessing which batch the customer was invoiced for.
    const { closing_ref, who = "", so_number = "" } = req.body || {};
    res.json(await data.slips.setSlipInvoiced(req.params.slip, closing_ref, who, so_number));
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.error("[POST /api/slips/:slip/invoiced]", err);
    res.status(500).json({ error: "Could not record that invoice." });
  }
});

app.post("/api/slips/:slip/close", async (req, res) => {
  try {
    const { closing_ref, who = "" } = req.body || {};
    const slip = await data.slips.closeSlip(req.params.slip, closing_ref, who);
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

const tls = require("tls");

// The office certificate. Overridable for the same reason the database path
// is: so a change can be tried without putting a private key anywhere near the
// real folder. The service sets neither, so on the server these are exactly
// the paths they have always been.
const CERT_PATH = process.env.OM_CERT || path.join(__dirname, "cert.pem");
const KEY_PATH = process.env.OM_KEY || path.join(__dirname, "key.pem");

// A SECOND certificate, for the name this server answers to on Tailscale.
//
// WHY TWO. One server, one socket, but two names: 192.168.1.7 in the office
// and something.ts.net from outside. A certificate names who it is for, so a
// single one cannot be right for both - and the office is the half that must
// not break. Dropping a Tailscale certificate over cert.pem would have every
// device at the counter refuse the server it has trusted for a year, which is
// a bad morning caused by a change nobody at the counter made.
//
// So the office certificate stays exactly where it is and keeps answering
// everything, and the Tailscale one is used only when a client asks for a
// .ts.net name by name. A server with no Tailscale certificate behaves exactly
// as it did before this existed.
//
// PUT THEM HERE (or set OM_TS_CERT / OM_TS_KEY to wherever `tailscale cert`
// wrote them):
const TS_CERT = process.env.OM_TS_CERT || path.join(__dirname, "tailscale-cert.pem");
const TS_KEY = process.env.OM_TS_KEY || path.join(__dirname, "tailscale-key.pem");

// Re-read when the files change on disk, so a renewed certificate is picked up
// without restarting the service.
//
// These last about 90 days and are renewed by re-running `tailscale cert`. A
// certificate that has quietly expired is the kind of fault that surfaces on a
// Saturday, to the one person who is out on a job - and "restart the service"
// is not a thing they can do from a customer's driveway.
let tsCache = { at: 0, ctx: null };
function tailscaleContext() {
  try {
    if (!fs.existsSync(TS_CERT) || !fs.existsSync(TS_KEY)) return null;
    const stamp = Math.max(fs.statSync(TS_CERT).mtimeMs, fs.statSync(TS_KEY).mtimeMs);
    if (tsCache.ctx && tsCache.at === stamp) return tsCache.ctx;
    const ctx = tls.createSecureContext({
      cert: fs.readFileSync(TS_CERT),
      key: fs.readFileSync(TS_KEY),
    });
    tsCache = { at: stamp, ctx };
    console.log(`[tls] Tailscale certificate loaded from ${path.basename(TS_CERT)}`);
    return ctx;
  } catch (e) {
    // Never fatal. A broken second certificate must not take the office down;
    // it falls back to the one that has always worked, and says so.
    console.error("[tls] Tailscale certificate not usable:", e.message);
    return null;
  }
}

if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  const options = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
    // Asked once per connection, with the name the client typed. Anything that
    // is not a Tailscale name - an IP address included, which sends no name at
    // all - gets the office certificate above.
    SNICallback: (servername, cb) => {
      const ctx = /\.ts\.net$/i.test(String(servername || "")) ? tailscaleContext() : null;
      cb(null, ctx || undefined);
    },
  };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`OM Service running (HTTPS) at https://localhost:${PORT}`);
    if (tailscaleContext()) console.log("[tls] .ts.net names will use the Tailscale certificate");
  });
} else {
  app.listen(PORT, () => {
    console.log(`OM Service running (HTTP) at http://localhost:${PORT}`);
  });
}
