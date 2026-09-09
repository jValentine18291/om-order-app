// backend/poStatus.js
// ============================================================================
// Where a purchase order has got to.
//
// Nobody types this in. It is worked out from three things that are already
// true somewhere else:
//
//   AutoCount   how much of each line is still outstanding. Outstanding falls
//               when goods are received into stock, so this is the only honest
//               source for "has it arrived".
//   Shipments   which lines are on a container that has sailed. The app's own,
//               because AutoCount knows nothing about a shipment.
//   Iris        whether the PO was actually emailed to the supplier. Her tick,
//               because AutoCount cannot know that either.
//
// Keeping it derived rather than stored is the point: a status somebody typed
// in March is a claim about March. This one cannot go stale, because there is
// nothing to go stale - it is recomputed from the facts every time it is read.
//
// It lives in its own file so a test can put a line in every state and read
// back what the screen would say, without a server, a database or AutoCount.
// ============================================================================

// Worst-to-best, and the order the rollup walks. "Worst" here means least far
// along: a PO is only as finished as its least finished line.
const LINE_STATUSES = ["NOT_ORDERED", "ORDERED", "PART_SHIPPED", "SHIPPED", "PART_RECEIVED", "RECEIVED"];

const LABELS = {
  NOT_ORDERED: "Not ordered yet",
  ORDERED: "Ordered",
  PART_SHIPPED: "Partially shipped",
  SHIPPED: "Shipped",
  PART_RECEIVED: "Partially received",
  RECEIVED: "Received",
};

// Where ONE line has got to.
//
//   line       { qty, outstanding } as AutoCount has it. qty is what was
//              ordered; outstanding is what is still owed.
//   allocated  how much of it is on a shipment that has sailed and not yet
//              been received. Received shipments are not counted - AutoCount's
//              outstanding has already dropped for those, and counting them
//              here too would subtract the same goods twice.
//   delivered  how much of it is on a shipment Iris has marked received. She
//              marks a container the day it reaches the workshop and the stock
//              is keyed into AutoCount afterwards, so for a while the goods are
//              on the floor and AutoCount still shows the line outstanding.
//   tracked    Iris's tick for the whole PO, which is where a line that has
//              not moved at all gets its answer.
function lineStatus(line, allocated, tracked, delivered) {
  const ordered = Number((line || {}).qty) || 0;
  const outstanding = Number((line || {}).outstanding) || 0;
  const onShips = Number(allocated) || 0;

  // Two people can say goods have arrived: AutoCount, when the stock is keyed
  // in, and Iris, when she signs for the container. The LARGER of the two is
  // taken, never the sum.
  //
  // Not the sum, because the two usually describe the SAME goods and adding
  // them would say a line is fully in while the supplier still owes half of
  // it - and somebody would stop chasing it. The larger can understate for a
  // while, which shows as "Partially received" on an order that is actually
  // complete: a smaller and much more visible mistake.
  const receivedByAutoCount = Math.max(0, ordered - outstanding);
  const received = Math.min(ordered, Math.max(receivedByAutoCount, Number(delivered) || 0));

  // Nothing left owed: it is all in. Checked first, because a line that is
  // fully received is fully received whatever anyone ticked.
  if (outstanding <= 0 || (ordered > 0 && received >= ordered)) return "RECEIVED";
  // Some of it has arrived, some has not.
  if (received > 0) return "PART_RECEIVED";
  // None received. Is what is still owed on a ship?
  //
  // >= rather than ===: a supplier who sends more than was ordered has still
  // sent the lot, and a line reading "partially shipped" because too much is
  // coming would be a strange thing to read.
  if (onShips >= outstanding && onShips > 0) return "SHIPPED";
  if (onShips > 0) return "PART_SHIPPED";
  return tracked === "ORDERED" ? "ORDERED" : "NOT_ORDERED";
}

// Where the WHOLE order has got to, from the state of its lines.
//
// Two questions, in this order, because they answer different things:
//
//   Is it all in?          every line RECEIVED -> Received.
//   Has any of it come?    any line at least partly received -> Partially
//                          received. That beats "shipped": once goods start
//                          landing, "how much is here" is the question being
//                          asked, and a PO with half on the shelf and half at
//                          sea reading "Shipped" would answer the other one.
//
// Below that the same shape repeats for shipping, and with nothing moved at
// all the answer falls back to Iris's tick.
function rollUp(statuses, tracked) {
  const list = (statuses || []).filter(Boolean);
  if (!list.length) return tracked === "ORDERED" ? "ORDERED" : "NOT_ORDERED";
  const has = (s) => list.includes(s);
  const every = (s) => list.every((x) => x === s);

  if (every("RECEIVED")) return "RECEIVED";
  if (has("RECEIVED") || has("PART_RECEIVED")) return "PART_RECEIVED";
  if (every("SHIPPED")) return "SHIPPED";
  if (has("SHIPPED") || has("PART_SHIPPED")) return "PART_SHIPPED";
  return tracked === "ORDERED" ? "ORDERED" : "NOT_ORDERED";
}

// The whole answer for one purchase order.
//
//   lines        [{ seq, qty, outstanding }] - AutoCount's, real lines only
//   allocated    Map or plain object keyed `${docNo}#${seq}`, from the
//                shipments repo: what is in transit
//   delivered    the same shape, for shipments marked received
//   tracked      "ORDERED" | "NOT_ORDERED"
//
// Returns the PO's status, each line's, and the counts the screen uses to say
// "3 of 8 lines received" without counting them again itself.
function derive({ docNo, lines, allocated, delivered, tracked }) {
  const from = (src) => (key) => {
    if (!src) return 0;
    if (typeof src.get === "function") return src.get(key) || 0;
    return src[key] || 0;
  };
  const alloc = from(allocated);
  const deliv = from(delivered);
  const perLine = (lines || []).map((l) => {
    const key = `${docNo}#${l.seq === null || l.seq === undefined ? "" : l.seq}`;
    return {
      seq: l.seq,
      status: lineStatus(l, alloc(key), tracked, deliv(key)),
      allocated: alloc(key),
      delivered: deliv(key),
    };
  });
  const status = rollUp(perLine.map((l) => l.status), tracked);
  const count = (s) => perLine.filter((l) => l.status === s).length;
  return {
    status,
    label: LABELS[status] || status,
    lines: perLine,
    counts: {
      total: perLine.length,
      received: count("RECEIVED"),
      part_received: count("PART_RECEIVED"),
      shipped: count("SHIPPED"),
      part_shipped: count("PART_SHIPPED"),
    },
  };
}

module.exports = { derive, lineStatus, rollUp, LABELS, LINE_STATUSES };
