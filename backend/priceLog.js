// priceLog.js
// ============================================================================
// Text-file audit log for every price the app writes into AutoCount.
//
// This log matters more than a normal app log. Writing straight to AutoCount's
// database bypasses AutoCount's OWN audit trail, so if a price is ever queried
// months later this file is the only record of who set it and when. It is
// append-only, never rotated, and plain text — open it in Notepad any time.
//
// Format:
//   2026-08-24 11:20:05 | Parts Diagram | SZEN 612912230C | List Price | not set -> 12.80 | JT (sales) | updated in AutoCount
//   2026-08-24 11:21:40 | Slip 00012 | SZEN 140051111 | Contractor Price | not set -> 9.50 | WJ (tech) | updated in AutoCount
//
// Every attempt is logged, including the ones that changed nothing, so a
// missing line means the request never reached the server.
// ============================================================================

const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "price-updates.log");

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A price that was never set reads better as "not set" than "0.00", which
// looks like someone deliberately priced the part at zero.
const amount = (v) =>
  v === null || v === undefined || Number(v) === 0 ? "not set" : Number(v).toFixed(2);

function logPriceEvent({ source, itemCode, tier, oldPrice, newPrice, who, outcome }) {
  const line =
    `${ts()} | ${source || "-"} | ${itemCode || "-"} | ${tier || "-"} | ` +
    `${amount(oldPrice)} -> ${amount(newPrice)} | ${who || "-"} | ${outcome}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error("[priceLog] could not write log:", e.message);
  }
}

module.exports = { logPriceEvent, LOG_PATH };
