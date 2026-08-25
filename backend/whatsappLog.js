// whatsappLog.js
// ============================================================================
// Append-only record of every Service Slip we tried to send to a customer.
//
// This answers the question staff will actually ask: "did the customer get
// their slip?" WhatsApp delivery is not guaranteed and Meta rejects messages
// for reasons that are invisible from inside this app (template withdrawn,
// no payment method, number not on WhatsApp). Every attempt is recorded,
// including the failures, so a missing line means the request never arrived.
//
// Format:
//   2026-08-25 11:20:05 | Slip 00123 | 6591234567 | SENT | wamid.HBgLNjU5... | JT (sales)
//   2026-08-25 11:22:41 | Slip 00124 | 6598765432 | FAILED | Template not approved | auto
//
// Plain text, opens in Notepad, never rotated. Excluded from GitHub - it holds
// customer phone numbers.
// ============================================================================

const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "whatsapp-sends.log");

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logSend({ slip, to, outcome, detail, who }) {
  const line = `${ts()} | Slip ${slip || "-"} | ${to || "-"} | ${outcome} | ${detail || "-"} | ${who || "-"}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error("[whatsappLog] could not write log:", e.message);
  }
}

module.exports = { logSend, LOG_PATH };
