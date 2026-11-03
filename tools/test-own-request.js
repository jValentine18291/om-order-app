// ORDERS FOR SALES, CHANGING YOUR OWN REQUEST, AND SEARCHING ORDERS.
// Run against a throwaway database, never the real one:
//
//   node tools/test-own-request.js C:/temp/scratch.db
//
// John, 3 Nov 2026:
//   1. Carmen and Chiu Yan (Sales) get the Orders list, and edit what is still
//      Need to Order. Delete and Mark as Ordered stay Iris's and admin's.
//   2. In Order more, a request already made BY YOU can be changed - quantity,
//      remark - or cancelled, while it is still Need to Order.
//   3. A search box on Orders: part, code, who asked, remarks; both tabs.
//
// Checked: the Sales default list has Orders; the Orders screen still keeps
// Delete and Mark as Ordered from Sales; your own request changes and cancels,
// one line of a bulk order without touching the others; somebody else's is
// refused, and so is one already Ordered; the popup's lookup carries the id;
// the search matches as described.
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
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));
const OM_FUNCTIONS = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
async function refused(what, fn, status, like) {
  try { await fn(); check(what, "allowed", "refused"); }
  catch (e) { check(what, e.status === status && like.test(e.message) ? "refused" : `${e.status} ${e.message}`, "refused"); }
}

(async () => {
  console.log("-- 1. Sales get Orders --");
  check("Sales' home screen has Orders", OM_FUNCTIONS.functionsFor({ role: "sales" }).includes("requests"), true);
  check("technicians still do not", OM_FUNCTIONS.functionsFor({ role: "tech" }).includes("requests"), false);
  const app = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
  check("Delete and Mark as Ordered stay the purchaser's and admin's",
    /const canManage = \["purchaser", "admin"\]\.includes\(getRole\(\)\);/.test(app), true);
  check("Edit is for whoever canDecide (sales, admin), on Need to Order",
    /pending && canDecide\(\) \? `<button class="pu-edit"/.test(app), true);

  console.log("\n-- 2. your own request, from Order more --");
  const mine = await data.requests.createPartRequest({ item_code: "M1618SK WS7F", description: "Bosch spark plug", qty_requested: 10, requester: "Carmen", remarks: "slip 00266" });
  let row = await data.requests.updateOwnPartRequest(mine.id, "Carmen", { qty_requested: 4, remarks: "only 4" });
  check("changed by the one who asked", [row.qty_requested, row.remarks, row.status], [4, "only 4", "PENDING"]);
  await refused("not by somebody else", () => data.requests.updateOwnPartRequest(mine.id, "Chiu Yan", { qty_requested: 2 }), 403, /Only Carmen/);
  await refused("not with no name", () => data.requests.cancelOwnPartRequest(mine.id, ""), 403, /Only Carmen/);
  await refused("not to nothing", () => data.requests.updateOwnPartRequest(mine.id, "Carmen", { qty_requested: 0 }), 400, /at least 1/);
  const ids = data.requests.pendingRequestsFor("M1618SK WS7F").map((r) => r.id);
  check("the popup's lookup finds it by id", ids, [mine.id]);
  await data.requests.cancelOwnPartRequest(mine.id, "Carmen");
  check("cancelled: gone, so the part can be ordered again", data.requests.pendingRequestsFor("M1618SK WS7F").length, 0);

  // One line of a bulk order: the rest of the order is left alone.
  const batch = await data.requests.createPartRequestBatch({ requester: "文建", items: [
    { item_code: "SZEN 140082113", description: "Body 2-100", qty_requested: 2 },
    { item_code: "SZEN 848KD35820", description: "Pipe", qty_requested: 3 },
  ] });
  await data.requests.cancelOwnPartRequest(batch[0].id, "文建");
  const left = (await data.requests.listPartRequests("PENDING")).filter((r) => r.batch_id === batch[0].batch_id);
  check("cancelling one line of a bulk order keeps the other", left.map((r) => [r.item_code, r.qty_requested]), [["SZEN 848KD35820", 3]]);

  await data.requests.markPartRequestBatchOrdered(batch[0].batch_id);
  await refused("once Ordered, it is locked", () => data.requests.updateOwnPartRequest(batch[1].id, "文建", { qty_requested: 5 }), 409, /already been marked Ordered/);
  await refused("and cannot be cancelled from here", () => data.requests.cancelOwnPartRequest(batch[1].id, "文建"), 409, /already been marked Ordered/);

  const server = fs.readFileSync(path.resolve(__dirname, "..", "backend", "server.js"), "utf8");
  check("the on-order lookup sends each request's id", /requests = \(data\.requests\.pendingRequestsFor\(code\)[\s\S]{0,200}id: r\.id,/.test(server), true);
  check("the button shows only on your own line", /const mine = \(q\) => !!me && q\.id && q\.requester === me;/.test(app), true);

  console.log("\n-- 3. searching Orders --");
  const start = app.indexOf("function puMatches(");
  const puMatches = new Function(app.slice(start, app.indexOf("\n}\n", start) + 2) + "\nreturn puMatches;")();
  const r = { description: "Bosch spark plug", item_code: "M1618SK WS7F", requester: "Carmen", remarks: "for slip 00266", batch_remarks: "urgent" };
  check("part name, any case", puMatches(r, "SPARK"), true);
  check("code with or without its space", [puMatches(r, "M1618SK WS7F"), puMatches(r, "m1618skws7f")], [true, true]);
  check("who asked", puMatches(r, "carmen"), true);
  check("the line's remark and the order's", [puMatches(r, "00266"), puMatches(r, "urgent")], [true, true]);
  check("every word must be there", [puMatches(r, "spark carmen"), puMatches(r, "spark iris")], [true, false]);
  check("searching asks for both tabs", /status=\$\{encodeURIComponent\(q \? "ALL" : puStatus\)\}/.test(app), true);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
