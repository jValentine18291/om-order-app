// WHERE A TAPPED NOTIFICATION LANDS, AND WHO GETS "READY TO QUOTE".
// Run against a throwaway database, never the real one:
//
//   node tools/test-notify-routes.js C:/temp/scratch.db
//
// John, 4 Nov 2026. The workflow: a technician sends a machine for quotation,
// which tells Carmen, Chiu Yan and John; they ring the customer and press
// proceed or condemn, which tells the technician who worked on it. Tapping
// any notification should land on the page it is about - before this,
// everything but the technicians' go-ahead landed on Need to Quote, shipment
// notices to technicians included.
//
// Checked: every notification the server sends names its page; the two
// message builders do too; "Ready to quote" goes to those three people and
// nobody else; the worker hands each kind on, and an old notification still
// on a lock screen still lands where it used to; the app has a landing for
// every page the server names.
const fs = require("fs");
const path = require("path");
const target = process.argv[2];
const live = path.resolve(__dirname, "..", "backend", "om_orders.db");
if (!target) {
  console.error("Give a scratch database path, e.g. node " + path.basename(__filename) + " C:/temp/scratch.db");
  process.exit(2);
}
if (path.resolve(target) === live) {
  console.error("Refusing to run against the live database: " + live);
  process.exit(2);
}
process.env.OM_DB_PATH = target;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const server = read("backend/server.js");
const sw = read("frontend/sw.js");
const app = read("frontend/app.js");
const PAGES = ["quote", "slip", "close", "machine", "orders", "shipment"];

(async () => {
  console.log("-- every notification the server sends names its page --");
  // Each push.notify / notifyTechs / notifyUsers call with an object written
  // out in place; the two built elsewhere are checked below.
  const calls = [...server.matchAll(/push\.notify(?:Techs|Users)?\(pushDb, [^,]+, \{([\s\S]*?)\n\s*\}\)/g)];
  check("found the calls written out in server.js", calls.length >= 9, true);
  const missing = calls.filter((m) => !/open: "(quote|slip|close|machine|orders|shipment)"/.test(m[1]))
    .map((m) => (m[1].match(/title: ([^\n]+)/) || [])[1]);
  check("and none of them is without a page", missing, []);

  const { salesOrderMessage, shipmentStatusMessage } = require(path.resolve(__dirname, "..", "backend", "notifyText.js"));
  const so = salesOrderMessage({ slip_number: "00266", company: "X" },
    { machines_converted: [{ machine_desc: "BK3410" }], machines_remaining: 0, total_amount: 10 }, "SO-1");
  check("a Sales Order opens that slip in Close Service", [so.open, so.slip], ["close", "00266"]);
  const sh = shipmentStatusMessage({ id: 7, invoice_no: "INV-1", status: "SHIPPED", lines: [] }, "");
  check("a shipment opens that shipment", [sh.open, sh.shipment], ["shipment", 7]);

  console.log("\n-- the workflow's two notifications --");
  check("Ready to quote opens Need to Quote, at the slip",
    [...server.matchAll(/title: "Ready to quote",[\s\S]{0,260}?open: "quote"/g)].length, 2);
  check("the go-ahead to the technician opens their machine",
    /title: `\$\{state === "TO_REPAIR" \? "Repair" : "Condemn"\}[\s\S]{0,400}?open: "machine"/.test(server), true);
  check("a new order names its card on the Orders screen",
    (server.match(/open: "orders",\s*\n\s*order: /g) || []).length, 2);

  console.log("\n-- who is told that a machine is ready to quote --");
  check("the three who ring the customer",
    /const QUOTE_READY_USERS = \["carmen", "chiuyan", "john"\];/.test(server), true);
  check("by person, both times it is sent",
    (server.match(/notifyUsers\(pushDb, QUOTE_READY_USERS, \{\s*\n\s*title: "Ready to quote"/g) || []).length, 2);

  // And that "by person" really picks out those people. Nothing is sent
  // anywhere: the push library's send is swapped for a recorder.
  const webpush = require(path.resolve(__dirname, "..", "backend", "node_modules", "web-push"));
  const sentTo = [];
  webpush.sendNotification = async (sub) => { sentTo.push(sub.endpoint); };
  const push = require(path.resolve(__dirname, "..", "backend", "push.js"));
  const db = require(path.resolve(__dirname, "..", "backend", "db"));
  push.init(db);
  const sub = (who, role) => push.subscribe(db, {
    subscription: { endpoint: `https://push.test/${who}`, keys: { p256dh: "k", auth: "a" } },
    user_id: who, role,
  });
  [["carmen", "sales"], ["chiuyan", "sales"], ["john", "admin"], ["iris", "purchaser"],
   ["keeseng", "admin"], ["wenjian", "tech"]].forEach(([w, r]) => sub(w, r));
  // John's second device.
  push.subscribe(db, { subscription: { endpoint: "https://push.test/john-ipad", keys: { p256dh: "k", auth: "a" } },
    user_id: "john", role: "admin" });
  await push.notifyUsers(db, ["carmen", "chiuyan", "john"], { title: "Ready to quote", body: "x", slip: "1", open: "quote" });
  check("every device of those three, and no one else's", sentTo.map((e) => e.split("/").pop()).sort(),
    ["carmen", "chiuyan", "john", "john-ipad"]);
  sentTo.length = 0;
  await push.notifyUsers(db, [], { title: "x", body: "x" });
  check("an empty list tells nobody - not everybody", sentTo.length, 0);

  console.log("\n-- the worker hands each kind on --");
  const start = sw.indexOf("function goFor(");
  const goFor = new Function(sw.slice(start, sw.indexOf("\n}\n", start) + 2) + "\nreturn goFor;")();
  check("Ready to quote", goFor({ slip: "00266", open: "quote" }).open, "quote");
  check("a shipment keeps its id", goFor({ slip: "", open: "shipment", shipment: 7 }).shipment, 7);
  check("an order keeps its card", goFor({ slip: "", open: "orders", order: "R12" }).order, "R12");
  check("one already on a lock screen, from before: Need to Quote, as it always was",
    goFor({ slip: "00266", open: "" }).open, "quote");
  check("the test message points nowhere, so it just opens the app", goFor({ slip: "" }), null);
  check("every kind is written down for the app, not only the machine",
    /const note = go\s*\n?\s*\? caches\.open\(GO_CACHE\)/.test(sw), true);

  console.log("\n-- the app has somewhere to land for each --");
  const goToSrc = app.slice(app.indexOf("async function goTo("), app.indexOf("// ...and a notification that opened the app cold"));
  check("a case for every page the server names",
    PAGES.filter((p) => !goToSrc.includes(`case "${p}":`)), []);
  check("a page they lack falls back to the slip, not forced on them",
    /case "quote":\s*\n\s*if \(!canOpen\("quote"\)\) \{ if \(slip\) await slipWindow\(\);/.test(goToSrc), true);
  check("Ready to quote opens the slip over the Need to Quote list",
    /await enterNeedToQuote\(\);[\s\S]{0,200}vsWindowScreen = "quote"; await onViewSlipChosen\(slip\);/.test(goToSrc), true);
  check("unsaved parts are never thrown away by a tap",
    /session\.pendingParts && session\.pendingParts\.length/.test(goToSrc), true);
  check("Orders cards carry the key a notification names",
    /class="pu-card \$\{pending \? "pu-card-pending" : "pu-card-ordered"\}" data-key="\$\{escapeAttr\(b\.key\)\}"/.test(app), true);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
