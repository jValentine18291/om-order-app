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

module.exports = { salesOrderMessage };
