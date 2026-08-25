// whatsapp.js
// ============================================================================
// Sends the Service Slip PDF to the customer over WhatsApp, via Meta's
// WhatsApp Cloud API.
//
// WHY THE CLOUD API AND NOT TWILIO
// Meta lets us upload the PDF straight from this server and then reference it
// by id. Twilio needs a publicly reachable URL for media, which this server -
// sitting on the office LAN - does not have.
//
// WHY A TEMPLATE AND NOT A PLAIN MESSAGE
// The customer has not messaged us first, so this is a "business-initiated"
// message. WhatsApp only allows those through a template Meta has approved in
// advance. The wording is fixed at approval time; we fill in the blanks. That
// also means: a template that is not approved yet will fail here, and the
// error will say so.
//
// SETTINGS (all on the server, never in the repo)
//   WHATSAPP_ENABLED           "true" to allow sending at all. Default off.
//   WHATSAPP_AUTO_SEND         "true" to send automatically when a slip is
//                              created. Default off - staff press a button.
//   WHATSAPP_PHONE_NUMBER_ID   from the WhatsApp API Setup page
//   WHATSAPP_TOKEN             permanent System User token. NEVER logged.
//   WHATSAPP_TEMPLATE          approved template name
//   WHATSAPP_TEMPLATE_LANG     its language code (default "en")
//   WHATSAPP_GRAPH_VERSION     default "v22.0"
//   WHATSAPP_GRAPH_BASE        override the API host (used by the tests)
// ============================================================================

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const GRAPH_BASE = process.env.WHATSAPP_GRAPH_BASE || "https://graph.facebook.com";

const on = (v) => String(v || "false").toLowerCase() === "true";

function config() {
  return {
    enabled: on(process.env.WHATSAPP_ENABLED),
    autoSend: on(process.env.WHATSAPP_AUTO_SEND),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    token: process.env.WHATSAPP_TOKEN || "",
    template: process.env.WHATSAPP_TEMPLATE || "service_slip_confirmation",
    lang: process.env.WHATSAPP_TEMPLATE_LANG || "en",
  };
}

// Is it switched on AND actually configured? Reported separately so the app
// can say "not set up" rather than failing at send time.
function readiness() {
  const c = config();
  const missing = [];
  if (!c.phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!c.token) missing.push("WHATSAPP_TOKEN");
  return {
    enabled: c.enabled,
    autoSend: c.enabled && c.autoSend,
    configured: missing.length === 0,
    missing,
  };
}

// ---- phone numbers --------------------------------------------------------
// Staff type these by hand, so accept what they actually type: "9123 4567",
// "+65 9123 4567", "6591234567", "65-9123-4567". WhatsApp wants digits only,
// country code included, no plus.
//
// A wrong number here sends a customer's signed slip to a stranger, so this
// refuses anything it cannot confidently read rather than guessing.
function normalisePhone(raw, defaultCountry = "65") {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "No WhatsApp number on this slip." };

  const hadPlus = s.startsWith("+");
  s = s.replace(/[^0-9]/g, "");
  if (!s) return { ok: false, error: "That WhatsApp number has no digits in it." };

  // Singapore mobiles are 8 digits starting 8 or 9. Anything of that shape
  // without a country code gets the local one.
  if (!hadPlus && s.length === 8 && /^[89]/.test(s)) s = defaultCountry + s;

  if (s.length < 8) return { ok: false, error: `"${raw}" is too short to be a WhatsApp number.` };
  if (s.length > 15) return { ok: false, error: `"${raw}" is too long to be a WhatsApp number.` };

  // A local 8-digit number that does not start 8 or 9 is almost certainly a
  // landline or a typo; WhatsApp would silently never deliver.
  if (s.length === 8) {
    return { ok: false, error: `"${raw}" does not look like a mobile number. Include the country code if it is not Singapore.` };
  }
  return { ok: true, number: s };
}

// WhatsApp rejects a template parameter containing a newline, a tab, or four
// consecutive spaces, and silently truncates very long ones. Machine
// descriptions are typed by hand, so they get cleaned rather than trusted.
function waParam(value, fallback, max) {
  const clean = String(value == null ? "" : value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

// ---- Graph calls ----------------------------------------------------------
// Meta returns its real complaint in body.error.message; surface that rather
// than a bare status code, because the useful cases (template not approved,
// number not on the allow-list, no payment method) all arrive that way.
async function graph(path, { method = "POST", body, headers = {}, timeoutMs = 30000 } = {}) {
  const c = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.token}`, ...headers },
      body,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("WhatsApp did not respond in time.");
    throw new Error(`Could not reach WhatsApp: ${e.message}`);
  }
  clearTimeout(timer);

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const err = json && json.error;
    const detail = err && (err.error_user_msg || err.message);
    const e = new Error(detail || `WhatsApp rejected the request (HTTP ${res.status}).`);
    e.code = err && err.code;
    e.subcode = err && err.error_subcode;
    throw e;
  }
  return json || {};
}

// Upload the PDF and get an id back. Media ids are good for a limited time,
// so this is always done immediately before sending, never cached.
async function uploadPdf(buffer, filename) {
  const c = config();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
  const out = await graph(`${c.phoneNumberId}/media`, { body: form });
  if (!out.id) throw new Error("WhatsApp accepted the file but returned no id.");
  return out.id;
}

// Send the approved template, with the PDF as its document header.
async function sendSlip({ to, customerName, slipNumber, receivedOn, equipment, pdf, filename }) {
  const c = config();
  if (!c.enabled) { const e = new Error("WhatsApp sending is switched off."); e.status = 403; throw e; }
  if (!c.phoneNumberId || !c.token) {
    const e = new Error("WhatsApp is not configured on this server."); e.status = 503; throw e;
  }
  const phone = normalisePhone(to);
  if (!phone.ok) { const e = new Error(phone.error); e.status = 400; throw e; }

  const mediaId = await uploadPdf(pdf, filename);

  const out = await graph(`${c.phoneNumberId}/messages`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone.number,
      type: "template",
      template: {
        name: c.template,
        language: { code: c.lang },
        components: [
          {
            type: "header",
            parameters: [{ type: "document", document: { id: mediaId, filename } }],
          },
          {
            type: "body",
            parameters: [
              // Order matters and is fixed by the approved template:
              // 1 customer name, 2 slip number, 3 date received, 4 equipment.
              // A template variable cannot contain a newline or a tab, so each
              // of these is flattened and trimmed before it goes anywhere.
              { type: "text", text: waParam(customerName, "there", 60) },
              { type: "text", text: waParam(slipNumber, "", 20) },
              { type: "text", text: waParam(receivedOn, "-", 20) },
              { type: "text", text: waParam(equipment, "-", 90) },
            ],
          },
        ],
      },
    }),
  });

  const messageId = out.messages && out.messages[0] && out.messages[0].id;
  return { to: phone.number, mediaId, messageId: messageId || null };
}

module.exports = { config, readiness, normalisePhone, sendSlip, uploadPdf, waParam };
