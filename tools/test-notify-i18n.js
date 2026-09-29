// WHAT A NOTIFICATION SAYS ON A CHINESE PHONE.
//
//   node tools/test-notify-i18n.js
//
// No database: this is wording, and the point of keeping it in its own file is
// that it can be checked without standing up a server or a push service.
//
// John, 29 Sep 2026: "if a user is in English mode, all notifications and
// wordings should be in English. Likewise for Chinese mode."
//
// THE PAYLOADS BELOW ARE COPIED FROM THE REAL CALL SITES in server.js and
// notifyText.js, shape for shape. That is the whole risk here: a pattern that
// looks right against an invented string and misses the one the server
// actually builds. If a message is reworded there and not here, this file goes
// on passing while a technician's phone quietly goes back to English - so the
// last check walks server.js and fails on a title it has never seen.
const path = require("path");
const fs = require("fs");
const { translate, localise, PATTERNS } = require(path.resolve(__dirname, "..", "backend", "notify-i18n.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

console.log("-- the two a technician actually receives --");
// notifyStateChange(), the answer to a quotation. This is the one that matters:
// the technicians are the Chinese readers in the workshop.
const repair = {
  title: "Repair: HBZ260EZ Handheld Blower",
  body: "00084 · SPLENDOR HORTICULTURAL SVCS & SUPPLY · the customer says go ahead with the repair",
  slip: "00084",
};
const condemn = {
  title: "Condemn: HBZ260EZ Handheld Blower",
  body: "00084 · SPLENDOR HORTICULTURAL SVCS & SUPPLY · the customer says do not repair - condemn it",
  slip: "00084",
};
check("go ahead, in Chinese", localise(repair, "zh"), {
  title: "可以维修：HBZ260EZ Handheld Blower",
  body: "00084 · SPLENDOR HORTICULTURAL SVCS & SUPPLY · 客户同意维修",
  slip: "00084",
});
check("condemn, in Chinese", localise(condemn, "zh"), {
  title: "报废：HBZ260EZ Handheld Blower",
  body: "00084 · SPLENDOR HORTICULTURAL SVCS & SUPPLY · 客户不维修，要报废",
  slip: "00084",
});

console.log("\n-- and the machine keeps its own name --");
// A machine is called an HBZ260EZ on the machine itself. So are slip numbers
// and company names: the customer's words, not ours.
check("the model is untouched", /HBZ260EZ Handheld Blower/.test(localise(repair, "zh").title), true);
check("so is the company", /SPLENDOR HORTICULTURAL SVCS & SUPPLY/.test(localise(repair, "zh").body), true);
check("and the slip it points at", localise(repair, "zh").slip, "00084");

console.log("\n-- English stays English --");
// The half John asked for that is easy to forget: Sales must not start getting
// Chinese because somebody added a translation.
check("nothing is changed for an English phone", localise(repair, "en"), repair);
check("nor for a device that never said", localise(repair, ""), repair);
check("nor for a nonsense value", localise(repair, "de"), repair);

console.log("\n-- the rest of the messages --");
check("ready to quote", translate("Ready to quote", "zh"), "等待报价");
check("  with a count of machines",
  translate("00084 · SPLENDOR · 3 machines", "zh"), "00084 · SPLENDOR · 3 台机器");
check("  and one machine", translate("00084 · SPLENDOR · 1 machine", "zh"), "00084 · SPLENDOR · 1 台机器");
check("a sales order", translate("Sales Order SO-2609-059", "zh"), "销售订单 SO-2609-059");
check("a shipment moving",
  translate("INV-123 · Arrived Singapore", "zh"), "INV-123 · 已抵达新加坡");
check("  and where it was", translate("Husqvarna · 3 items · Singapore 18 Sep (was Shipped)", "zh"),
  "Husqvarna · 3 items · Singapore 18 Sep（原为已发货）");
check("a new part order", translate("New part order", "zh"), "新零件订单");

console.log("\n-- a message with no translation goes out as it is --");
// The right failure. A technician reading English is inconvenienced; a
// technician reading half a sentence is misled.
check("untouched", translate("Something nobody has translated yet", "zh"),
  "Something nobody has translated yet");
check("and an empty one stays empty", translate("", "zh"), "");
check("and a missing one does not become 'undefined'", translate(undefined, "zh"), "");

console.log("\n-- every pattern is anchored at both ends --");
// The same rule frontend/i18n.js is held to. A pattern that can match part of
// a message will mangle the rest of it, and the mangling lands on a lock
// screen where nobody can ask what it was supposed to say.
const loose = PATTERNS.filter(([re]) => !(re.source.startsWith("^") && re.source.endsWith("$")));
check("none of them can match a fragment", loose.map(([re]) => re.source), []);

console.log("\n-- and every title the server sends has a translation --");
// The check that catches the real drift: a message reworded in server.js, or a
// new one added, that nobody thought to translate.
const server = fs.readFileSync(path.resolve(__dirname, "..", "backend", "server.js"), "utf8");

// Plain ones first: "Ready to quote" and the like.
const plain = [...new Set(
  [...server.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean)
)];
// A check over nothing passes, and a passing check over nothing is worse than
// no check: it says the drift is covered when the regex simply stopped
// matching. So prove it found some before believing the answer.
check("the sweep found titles to check", plain.length > 0, true);
check("plain titles all translate", plain.filter((t) => translate(t, "zh") === t), []);

// And the templated ones - `Repair: ${desc}`. Anything with literal words in
// front of the first ${ can be checked by standing a sample in for the data.
const templated = [...new Set(
  [...server.matchAll(/title:\s*`([^`]+)`/g)].map((m) => m[1])
)];
const checkable = templated
  .map((t) => ({ raw: t, prefix: t.split("${")[0] }))
  .filter((t) => t.prefix.trim());
check("the sweep found templated titles too", checkable.length > 0, true);
check("they translate with data standing in",
  checkable.filter(({ prefix }) => translate(prefix + "SAMPLE", "zh") === prefix + "SAMPLE")
           .map(({ raw }) => raw),
  []);
// The ones that start with a ${...} - a ternary choosing the first word - are
// out of reach of any static check, so they are named rather than skipped
// silently. Both are covered by the payload tests at the top of this file.
const unreachable = templated.filter((t) => !t.split("${")[0].trim());
console.log(`  note  ${unreachable.length} title(s) built from a condition, checked by hand above:` +
  unreachable.map((t) => `\n        ${t}`).join(""));

console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
process.exit(failures ? 1 : 0);
