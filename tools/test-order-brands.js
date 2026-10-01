// ORDERS: EACH LINE'S SUPPLIER, FOR IRIS'S FILTER.
// Run against a throwaway database, never the real one:
//
//   node tools/test-order-brands.js C:/temp/scratch.db
//
// John, 1 Oct 2026: filter Orders by supplier, the supplier being the brand
// AutoCount holds on the item. Checked: a line gets its item's brand; a code
// with no brand, or a free-text line, gets '' (Other); the lookup runs once
// per row and is kept; a failed lookup is not stored, so it is asked again;
// one line of a mixed order can be marked Ordered while the rest stay.
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
const repo = require(path.resolve(__dirname, "..", "backend", "data", "sqliteRepo.js"));
const db = require(path.resolve(__dirname, "..", "backend", "db"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

(async () => {
  const add = db.prepare("INSERT OR REPLACE INTO items (item_code, barcode, description, brand, uom, unit_price) VALUES (?, ?, ?, ?, 'PCS', 1)");
  add.run("SHUQ 900000001", "900000001", "Test bar", "HUSQVARNA");
  add.run("SZEN 900000002", "900000002", "Test filter", "ZENOAH");
  add.run("M0507CS 900000003R", "900000003R", "Test gasket R", "ZENOAH R");
  add.run("M1618GC 900000004", "900000004", "Test no brand", "");

  await data.requests.createPartRequestBatch({
    requester: "Iris",
    items: [
      { item_code: "SHUQ 900000001", description: "Test bar", qty_requested: 2 },
      { item_code: "SZEN 900000002", description: "Test filter", qty_requested: 1 },
      { item_code: "M0507CS 900000003R", description: "Test gasket R", qty_requested: 3 },
      { item_code: "M1618GC 900000004", description: "Test no brand", qty_requested: 1 },
      { item_code: "NOTINAUTOCOUNT 1", description: "Not a real code at all", qty_requested: 1 },
    ],
  });

  let rows = await data.requests.fillBrands(await data.requests.listPartRequests("PENDING"));
  const by = (code) => rows.find((r) => r.item_code === code);
  check("Husqvarna", by("SHUQ 900000001").brand, "HUSQVARNA");
  check("Zenoah", by("SZEN 900000002").brand, "ZENOAH");
  check("the R brand kept apart", by("M0507CS 900000003R").brand, "ZENOAH R");
  check("no brand on the item reads ''", by("M1618GC 900000004").brand, "");
  check("a code AutoCount doesn't know reads ''", by("NOTINAUTOCOUNT 1").brand, "");
  check("and it is stored", db.prepare("SELECT COUNT(*) AS n FROM part_requests WHERE brand IS NULL").get().n, 0);

  // Asked once: a second read must not look anything up.
  let asked = 0;
  await repo.partRequests.fillPartRequestBrands(await data.requests.listPartRequests("PENDING"),
    async (codes) => { asked += codes.length; return new Map(); });
  check("the second read asks nothing", asked, 0);

  // A failed lookup is not remembered as "no brand".
  db.prepare("UPDATE part_requests SET brand = NULL WHERE item_code = 'SHUQ 900000001'").run();
  rows = await repo.partRequests.fillPartRequestBrands(await data.requests.listPartRequests("PENDING"),
    async () => { throw new Error("AutoCount unreachable"); });
  check("shown as Other for now", rows.find((r) => r.item_code === "SHUQ 900000001").brand, "");
  check("but left to ask again", db.prepare("SELECT brand FROM part_requests WHERE item_code = 'SHUQ 900000001'").get().brand, null);
  rows = await data.requests.fillBrands(await data.requests.listPartRequests("PENDING"));
  check("and found next time", rows.find((r) => r.item_code === "SHUQ 900000001").brand, "HUSQVARNA");

  // Marking one supplier's lines of a mixed order.
  const husq = rows.find((r) => r.item_code === "SHUQ 900000001");
  await data.requests.markPartRequestOrdered(husq.id);
  const after = await data.requests.listPartRequests("ALL");
  check("the Husqvarna line is Ordered", after.find((r) => r.id === husq.id).status, "ORDERED");
  check("the rest of the order stays Need to Order",
    after.filter((r) => r.batch_id === husq.batch_id && r.id !== husq.id).every((r) => r.status === "PENDING"), true);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
