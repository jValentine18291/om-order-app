// backend/notify-i18n.js
// ============================================================================
// WHAT A NOTIFICATION SAYS, IN THE LANGUAGE OF THE PHONE IT LANDS ON.
//
// John, 29 Sep 2026: "if a user is in English mode, all notifications and
// wordings should be in English. Likewise for Chinese mode."
//
// Everything on screen goes through frontend/i18n.js, which works because the
// app is standing in front of the text when it is drawn. A push notification
// is the one thing that is not: it is composed here, on the server, and shown
// by the phone while the app is closed. So the wording has to be chosen before
// it is sent, per device, from the language that device told us it is in.
//
// THE SAME DISCIPLINE AS frontend/i18n.js, deliberately:
//
//   - whole strings in DICT, matched exactly;
//   - anything carrying a number or a name in PATTERNS, anchored at both ends
//     so a pattern can never match part of a message and mangle the rest;
//   - no translation found means the English goes out unchanged, which is the
//     right failure: a technician reading English is inconvenienced, a
//     technician reading half a sentence is misled.
//
// WHAT IS DELIBERATELY NOT TRANSLATED: slip numbers, company names, machine
// descriptions, part descriptions, money. Those are the customer's words and
// AutoCount's, they are the same in both languages, and a machine is called an
// HBZ260EZ on the machine itself.
// ============================================================================

const DICT = {
  "Ready to quote": "等待报价",
  "New part order": "新零件订单",
  "New bulk order": "新批量订单",
};

// Anchored at both ends, every one of them. See test-notify-i18n.js, which
// refuses any that is not.
const PATTERNS = [
  // ---- The two the technicians actually get -------------------------------
  // The answer to a quotation, which is the only thing the workshop is waiting
  // on. These are the reason this file exists.
  [/^Repair: (.+)$/, "可以维修：$1"],
  [/^Condemn: (.+)$/, "报废：$1"],
  [/^(.+) · (.+) · the customer says go ahead with the repair$/, "$1 · $2 · 客户同意维修"],
  [/^(.+) · (.+) · the customer says do not repair - condemn it$/, "$1 · $2 · 客户不维修，要报废"],

  // ---- Sales' own, for an admin who has chosen Chinese --------------------
  [/^Condemned: (.+)$/, "已报废：$1"],
  [/^(.+) · (.+) · not being repaired - it still has to leave the workshop$/,
   "$1 · $2 · 不维修，但仍需运出车间"],
  [/^(.+) · (.+) · (\d+) machines?$/, "$1 · $2 · $3 台机器"],
  // A technician gave the customer's answer (1 Oct 2026).
  [/^Proceed: (.+)$/, "继续维修：$1"],
  [/^(.+) · (.+) · (.+): customer agreed, repair going ahead$/, "$1 · $2 · $3：客户同意，继续维修"],
  [/^(.+) · (.+) · (.+): customer says too expensive - condemned$/, "$1 · $2 · $3：客户嫌太贵，已报废"],
  [/^Sales Order (.+)$/, "销售订单 $1"],
  [/^(.+) · (.+) · (\d+) still on the slip$/, "$1 · $2 · 服务单上还有 $3 台"],

  // ---- Shipments, which technicians are told about too ---------------------
  [/^(.+) · Shipped$/, "$1 · 已发货"],
  [/^(.+) · Arrived Singapore$/, "$1 · 已抵达新加坡"],
  [/^(.+) · Received$/, "$1 · 已收货"],
  [/^(.+) · Cancelled$/, "$1 · 已取消"],
  [/^(.+) \(was Shipped\)$/, "$1（原为已发货）"],
  [/^(.+) \(was Arrived Singapore\)$/, "$1（原为已抵达新加坡）"],
  [/^(.+) \(was Received\)$/, "$1（原为已收货）"],
  [/^(.+) \(was Cancelled\)$/, "$1（原为已取消）"],
];

// One string. Returns it unchanged when there is nothing better to say.
function translate(text, lang) {
  const s = String(text == null ? "" : text);
  if (String(lang || "").toLowerCase() !== "zh" || !s.trim()) return s;
  if (Object.prototype.hasOwnProperty.call(DICT, s)) return DICT[s];
  for (const [re, out] of PATTERNS) {
    if (re.test(s)) return s.replace(re, out);
  }
  return s;
}

// A whole payload, ready to send to one device. Everything except the title
// and the body is passed through untouched - `slip` and `shipment` are how the
// worker decides where to go when the notification is tapped, and translating
// a slip number would break that as well as being nonsense.
function localise(payload, lang) {
  const p = payload || {};
  return { ...p, title: translate(p.title, lang), body: translate(p.body, lang) };
}

module.exports = { translate, localise, DICT, PATTERNS };
