// backend/logs-export.js
// ============================================================================
// EVERY RECORD THE APP KEEPS, AS ONE EXCEL WORKBOOK.
//
// John, 2 Oct 2026: the logs are plain text and database tables, readable by
// nobody but a programmer. This turns them into clean tables - one tab each,
// headers, filters, the top row frozen, newest first, real dates Excel can
// sort - built fresh every time the button is pressed, so it is never stale.
//
// His choices: slips and machines, AutoCount writes, and WhatsApp sends.
// Part orders and sign-ins are deliberately left out. John alone may download
// it (canDownloadLogs) - it holds customer phone numbers.
//
// READ-ONLY. Nothing here writes to the database or the logs.
// ============================================================================

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

// What the screens call things - the same words, so the file reads like the app.
const MACHINE_STATE = {
  RECEIVED: "Need Repair", AWAITING_QUOTE: "Waiting to quote", QUOTED: "Waiting on customer",
  TO_REPAIR: "In Progress", REPAIRED: "Repaired", CONDEMNED: "Condemned",
};
const DISPOSAL = { COLLECTED: "Customer collected", DISPOSED: "Disposed of" };
const SLIP_STATUS = {
  OPEN: "Open", IN_PROGRESS: "In Progress", NEED_QUOTE: "Need to Quote", QUOTED: "Waiting on Customer",
  REPAIRED: "Repaired", ALL_REPAIRED: "All Repaired", PART_SO: "Partial SO", CALL_CUSTOMER: "All Repaired",
  CONVERTED: "SO Created", INVOICED: "Invoice Created", READY_TO_CLOSE: "Ready to close", CLOSED: "Closed",
};

const TEAL = "FF0A7F86";

// "2026-10-02 10:14:05" -> a Date whose UTC parts are those wall-clock parts.
// Excel has no time zones: writing it this way puts exactly 10:14 in the cell,
// which is what the server recorded in Singapore time.
function when(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s ? String(s) : "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

function readLog(file) {
  try {
    return fs.readFileSync(path.join(__dirname, file), "utf8")
      .split(/\r?\n/).filter((l) => l.trim());
  } catch (_) {
    return [];                        // never written yet: an empty tab says so
  }
}

// One tab. `cols` is [header, width, kind]; kind "date" or "money" formats it.
function sheet(wb, name, cols, rows, emptyNote) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } };
  head.alignment = { vertical: "middle" };
  head.height = 20;
  for (const r of rows) ws.addRow(r);
  cols.forEach(([, , kind], i) => {
    const c = ws.getColumn(i + 1);
    if (kind === "date") c.numFmt = "yyyy-mm-dd hh:mm";
    if (kind === "money") c.numFmt = "#,##0.00";
    if (kind === "wrap") c.alignment = { wrapText: true, vertical: "top" };
  });
  if (rows.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  } else {
    ws.addRow([emptyNote || "Nothing recorded yet."]).font = { italic: true, color: { argb: "FF85958D" } };
  }
  return ws;
}

const newestFirst = (rows) => rows.sort((a, b) => {
  const ta = a[0] instanceof Date ? a[0].getTime() : 0;
  const tb = b[0] instanceof Date ? b[0].getTime() : 0;
  return tb - ta;
});
const pipe = (line) => line.split(" | ").map((x) => x.trim());
const dash = (v) => (v === "-" ? "" : v);

async function buildLogsWorkbook(db) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OM Service";
  wb.created = new Date();

  // ---- Read me ------------------------------------------------------------
  const readme = wb.addWorksheet("Read me");
  readme.columns = [{ width: 22 }, { width: 90 }];
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  readme.addRow(["OM Service - logs"]).font = { bold: true, size: 14 };
  readme.addRow(["Downloaded", `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`]);
  readme.addRow([]);
  for (const [tab, what] of [
    ["Status history", "Every machine status change and collection, with who and when. Kept from 2 Oct 2026 onward - earlier steps were never stored."],
    ["Machines now", "Every machine as it stands: status, the last decision, its Sales Order, and whether it has gone."],
    ["Slips", "Every slip: registered, invoiced (DO/CS/INV) and closed - by whom and when."],
    ["Slip changes", "Every correction made to a slip after the customer signed: field, before, after, who, when."],
    ["Deleted slips", "Every slip deleted, by whom and when. A full copy is kept on the server."],
    ["Quotations", "Every quotation issued."],
    ["Sales Orders", "Every attempt to create a Sales Order in AutoCount, including failures and why."],
    ["Prices", "Every price the app wrote to AutoCount."],
    ["Shelf moves", "Every shelf location the app wrote to AutoCount."],
    ["WhatsApp", "Every WhatsApp send. Holds customer phone numbers - keep this file private."],
  ]) {
    const r = readme.addRow([tab, what]);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true };
  }

  // ---- Status history -------------------------------------------------------
  const hist = db.prepare(
    `SELECT h.changed_at, s.slip_number, s.company, m.machine_desc, h.field, h.from_value, h.to_value, h.who
       FROM machine_status_history h
       LEFT JOIN slip_machines m ON m.id = h.machine_id
       LEFT JOIN service_slips s ON s.id = h.slip_id
      ORDER BY h.id DESC`
  ).all();
  sheet(wb, "Status history", [
    ["When", 18, "date"], ["Slip", 9], ["Company", 32], ["Machine", 28],
    ["What", 12], ["From", 20], ["To", 20], ["By", 8],
  ], hist.map((h) => {
    const label = h.field === "disposal" ? (v) => DISPOSAL[v] || (v ? v : "Not yet")
                                         : (v) => MACHINE_STATE[v] || v;
    return [when(h.changed_at), h.slip_number || "(deleted)", h.company || "", h.machine_desc || "",
      h.field === "disposal" ? "Collection" : (h.from_value ? "Status" : "Registered"),
      h.from_value ? label(h.from_value) : "", label(h.to_value), h.who || ""];
  }), "Nothing yet - the history starts from the day this went live.");

  // ---- Machines now -------------------------------------------------------
  const machines = db.prepare(
    `SELECT s.slip_number, s.company, m.machine_desc, m.serial_no, m.state, m.decided_by, m.decided_at,
            m.so_number, m.converted_at, m.disposal, m.disposal_by, m.disposal_at
       FROM slip_machines m JOIN service_slips s ON s.id = m.slip_id
      ORDER BY s.slip_number DESC, m.id`
  ).all();
  sheet(wb, "Machines now", [
    ["Slip", 9], ["Company", 32], ["Machine", 28], ["Serial", 14], ["Status", 20],
    ["Last decision by", 10], ["Last decision", 18, "date"], ["Sales Order", 16], ["On SO since", 18, "date"],
    ["Gone?", 20], ["By", 8], ["When", 18, "date"],
  ], machines.map((m) => [
    m.slip_number, m.company, m.machine_desc, m.serial_no || "",
    m.state === "REPAIRED" && m.disposal === "COLLECTED" ? "Repaired – With Customer" : (MACHINE_STATE[m.state] || m.state),
    m.decided_by || "", when(m.decided_at), m.so_number || "", when(m.converted_at),
    DISPOSAL[m.disposal] || "Still here", m.disposal_by || "", when(m.disposal_at),
  ]));

  // ---- Slips ------------------------------------------------------------------
  const slips = db.prepare(
    `SELECT slip_number, physical_ss, company, status, created_by, created_at,
            closing_ref, invoiced_by, invoiced_at, closed_by, closed_at
       FROM service_slips ORDER BY slip_number DESC`
  ).all();
  sheet(wb, "Slips", [
    ["Slip", 9], ["Physical SS", 11], ["Company", 32], ["Status", 16],
    ["Registered", 18, "date"], ["By", 14], ["DO/CS/INV", 16], ["Invoiced", 18, "date"], ["By", 8],
    ["Closed", 18, "date"], ["By", 8],
  ], slips.map((s) => [
    s.slip_number, s.physical_ss || "", s.company, SLIP_STATUS[s.status] || s.status,
    when(s.created_at), s.created_by || "", s.closing_ref || "", when(s.invoiced_at), s.invoiced_by || "",
    when(s.closed_at), s.closed_by || "",
  ]));

  // ---- Slip changes -----------------------------------------------------------
  const changes = db.prepare(
    `SELECT a.changed_at, s.slip_number, s.company, a.field, a.before, a.after, a.changed_by
       FROM slip_amendments a LEFT JOIN service_slips s ON s.id = a.slip_id
      ORDER BY a.id DESC`
  ).all();
  sheet(wb, "Slip changes", [
    ["When", 18, "date"], ["Slip", 9], ["Company", 30], ["What changed", 30],
    ["Before", 30, "wrap"], ["After", 30, "wrap"], ["By", 8],
  ], changes.map((c) => [when(c.changed_at), c.slip_number || "", c.company || "", c.field,
    c.before || "", c.after || "", c.changed_by || ""]));

  // ---- Deleted slips ------------------------------------------------------
  const deleted = db.prepare(
    "SELECT deleted_at, slip_number, company, payload, deleted_by FROM deleted_slips ORDER BY id DESC"
  ).all();
  sheet(wb, "Deleted slips", [
    ["When", 18, "date"], ["Slip", 9], ["Company", 32], ["Machines", 40, "wrap"], ["By", 10],
  ], deleted.map((d) => {
    let ms = "";
    try { ms = (JSON.parse(d.payload).machines || []).map((m) => m.machine_desc).join(", "); } catch (_) {}
    return [when(d.deleted_at), d.slip_number, d.company || "", ms, d.deleted_by || ""];
  }));

  // ---- Quotations -----------------------------------------------------------
  const quotes = db.prepare(
    `SELECT q.issued_at, q.ref, q.slip_number, s.company, q.total, q.payment_term, q.delivery_term, q.issued_by
       FROM slip_quotations q LEFT JOIN service_slips s ON s.slip_number = q.slip_number
      ORDER BY q.id DESC`
  ).all();
  sheet(wb, "Quotations", [
    ["When", 18, "date"], ["Quotation", 14], ["Slip", 9], ["Company", 30], ["Total", 12, "money"],
    ["Payment", 18], ["Delivery", 18], ["By", 8],
  ], quotes.map((q) => [when(q.issued_at), q.ref, q.slip_number, q.company || "", Number(q.total) || 0,
    q.payment_term || "", q.delivery_term || "", q.issued_by || ""]));

  // ---- The text logs --------------------------------------------------------
  // "when | SO | outcome | detail"
  sheet(wb, "Sales Orders", [
    ["When", 18, "date"], ["Sales Order", 16], ["Outcome", 16], ["Detail", 90, "wrap"],
  ], newestFirst(readLog("autocount-orders.log").map((l) => {
    const f = pipe(l);
    return [when(f[0]), dash(f[1] || ""), dash(f[2] || ""), dash(f.slice(3).join(" | "))];
  })));

  // "when | source | item | tier | old -> new | who | outcome"
  const arrow = (s) => { const [a, b] = String(s || "").split(" -> "); return [dash(a || ""), dash(b || "")]; };
  sheet(wb, "Prices", [
    ["When", 18, "date"], ["From", 14], ["Item code", 24], ["Price", 14], ["Old", 10], ["New", 10],
    ["By", 10], ["Outcome", 40, "wrap"],
  ], newestFirst(readLog("price-updates.log").map((l) => {
    const f = pipe(l);
    return [when(f[0]), dash(f[1] || ""), dash(f[2] || ""), dash(f[3] || ""), ...arrow(f[4]),
      dash(f[5] || ""), dash(f.slice(6).join(" | "))];
  })));

  // "when | source | item | old -> new | who | outcome"
  sheet(wb, "Shelf moves", [
    ["When", 18, "date"], ["From", 14], ["Item code", 24], ["Old shelf", 14], ["New shelf", 14],
    ["By", 10], ["Outcome", 40, "wrap"],
  ], newestFirst(readLog("location-updates.log").map((l) => {
    const f = pipe(l);
    return [when(f[0]), dash(f[1] || ""), dash(f[2] || ""), ...arrow(f[3]),
      dash(f[4] || ""), dash(f.slice(5).join(" | "))];
  })));

  // "when | Slip X | to | outcome | detail | who"
  sheet(wb, "WhatsApp", [
    ["When", 18, "date"], ["Slip", 9], ["To", 16], ["Outcome", 14], ["Detail", 60, "wrap"], ["By", 8],
  ], newestFirst(readLog("whatsapp-sends.log").map((l) => {
    const f = pipe(l);
    const who = f.length > 5 ? f[f.length - 1] : "";
    const detail = f.length > 5 ? f.slice(4, -1).join(" | ") : (f[4] || "");
    return [when(f[0]), dash(String(f[1] || "").replace(/^Slip\s+/, "")), dash(f[2] || ""), dash(f[3] || ""),
      dash(detail), dash(who)];
  })));

  return wb.xlsx.writeBuffer();
}

module.exports = { buildLogsWorkbook, when };
