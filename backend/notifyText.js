// backend/notifyText.js
// ============================================================================
// The wording of a notification, apart from the sending of it.
//
// It lives here so a test can check what people will actually read without
// standing up a server and a push service. A copy of the expression in a test
// file would only ever prove that the copy still agrees with itself.
// ============================================================================

// A slip has become a Sales Order.
//
// The three things sales need before deciding whether to act on it: whose it
// is, what it is worth, and whether the slip is finished with - a slip with
// machines still on it cannot be invoiced and closed, and finding that out by
// opening the app is the thing this notification exists to save.
function salesOrderMessage(slip, result, finalSo) {
  const converted = result.machines_converted || [];
  // A COUNT, not a list: createSlipOrder returns the number still unconverted.
  // Read as an array it comes back 0 every time, which would silently drop the
  // "still on the slip" half of the message.
  const left = Number(result.machines_remaining) || 0;
  const amount = Number(result.total_amount);

  // One machine is worth naming; three are worth counting. A list of three
  // model names does not fit on a lock screen and gets truncated mid-word.
  const machines = converted.length === 1
    ? ((converted[0] || {}).machine_desc || "1 machine")
    : `${converted.length} machines`;

  return {
    title: `Sales Order ${finalSo}`,
    body: `${slip.slip_number} · ${slip.company} · ${machines}` +
          // "$0.00" tells nobody anything, so an order worth nothing says
          // nothing about money rather than drawing the eye to a zero.
          (Number.isFinite(amount) && amount > 0 ? ` · $${amount.toFixed(2)}` : "") +
          (left > 0 ? ` · ${left} still on the slip` : ""),
    slip: slip.slip_number,
  };
}

// A shipment has moved.
//
// Read by sales with a customer on the phone and by a technician with the
// machine open in front of him, so the two things it has to carry are WHAT is
// on the container and WHEN it lands. The invoice number is how Iris refers to
// a shipment; the parts are what everybody else recognises it by, so both are
// on it.
//
// `before` is where it was, because "Arrived Singapore" on its own is a fact
// and "Shipped becomes Arrived Singapore" is news.
function shipmentStatusMessage(shipment, before) {
  const s = shipment || {};
  const lines = s.lines || [];
  const label = (st) => SHIPMENT_LABELS[st] || st || "";

  // One part is worth naming, several are worth counting - a lock screen shows
  // about forty characters of body text before it gives up mid-word.
  const what = lines.length === 1
    ? ((lines[0] || {}).description || (lines[0] || {}).item_code || "1 item")
    : `${lines.length} item${lines.length === 1 ? "" : "s"}`;

  // The date that matters depends on where it has got to. Before it lands in
  // Singapore, the Singapore date is the one being waited on; after that, the
  // one that matters is when it reaches the workshop it is going to.
  const eta = s.status === "ARRIVED_SG" ? s.eta_dest : s.eta_sg;
  const where = s.status === "ARRIVED_SG" ? (DEST_LABELS[s.destination] || "destination") : "Singapore";

  const bits = [s.supplier_name || "", what];
  // "Cancelled, ETA next Tuesday" would be a strange thing to read, and a
  // received shipment has arrived - there is nothing left to wait for.
  if (eta && s.status !== "CANCELLED" && s.status !== "RECEIVED") bits.push(`${where} ${formatDate(eta)}`);

  return {
    title: `${s.invoice_no || "Shipment"} · ${label(s.status)}`,
    body: bits.filter(Boolean).join(" · ") + (before ? ` (was ${label(before)})` : ""),
    shipment: s.id,
  };
}

const SHIPMENT_LABELS = {
  SHIPPED: "Shipped",
  ARRIVED_SG: "Arrived Singapore",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};
const DEST_LABELS = { JOO_SENG: "Joo Seng", EUNOS: "Eunos" };

// 2026-09-24 -> 24 Sep. The year is left off deliberately: everything on a
// notification is happening this year or next month, and the four characters
// are better spent on the part.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return String(iso || "");
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]}`;
}

module.exports = { salesOrderMessage, shipmentStatusMessage };
