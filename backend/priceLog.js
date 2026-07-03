// priceLog.js
// ============================================================================
// Text-file audit log for price changes made through the app.
// Appends one line per event to price-updates.log in the backend folder.
//
// Format:
//   2026-07-03 11:20:05 | Slip 00012 | SZEN 140051111 | 0.00 -> 12.80 | tech WJ | updated in AutoCount
//
// The file is plain text — open it in Notepad any time. It is append-only and
// never rotated automatically; at a few lines per day it stays small for years.
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

function logPriceEvent({ slip, itemCode, oldPrice, newPrice, technician, outcome }) {
  const line =
    `${ts()} | Slip ${slip} | ${itemCode} | ` +
    `${Number(oldPrice ?? 0).toFixed(2)} -> ${Number(newPrice ?? 0).toFixed(2)} | ` +
    `tech ${technician || "-"} | ${outcome}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error("[priceLog] could not write log:", e.message);
  }
}

module.exports = { logPriceEvent, LOG_PATH };
