// What "stock when the order was made" records, and what it must never invent.
//
//   node tools/test-stock-snapshot.js C:/temp/scratch.db
//
// The bug this guards: Number(null) is 0, not NaN, so "AutoCount has never
// heard of this part" was being stored as "we have none left". A purchaser
// reads those two very differently.
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

let failures = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const rowFor = (code) =>
  data.requests.listPartRequests("ALL").find((r) => r.item_code === code);

// A part AutoCount knows, with real stock on the shelf.
data.requests.createPartRequestBatch({
  requester: "TEST",
  items: [{ item_code: "SZEN 111", description: "Known part", qty_requested: 2, stock_at_request: 7 }],
});
check("a real balance is kept", rowFor("SZEN 111").stock_at_request, 7);

// A part AutoCount genuinely has none of. Zero is a fact and must survive.
data.requests.createPartRequestBatch({
  requester: "TEST",
  items: [{ item_code: "SZEN 222", description: "Out of stock", qty_requested: 1, stock_at_request: 0 }],
});
check("a genuine zero is kept", rowFor("SZEN 222").stock_at_request, 0);

// A part AutoCount has never heard of - diesel, or anything free-text. This is
// the one that used to come back as 0.
data.requests.createPartRequestBatch({
  requester: "TEST",
  items: [{ item_code: "DIESEL", description: "Diesel — usual amount", qty_requested: 1, free_text: true, stock_at_request: null }],
});
check("unknown stays unknown, not zero", rowFor("DIESEL").stock_at_request, null);

// The field missing entirely means the same thing as null.
data.requests.createPartRequestBatch({
  requester: "TEST",
  items: [{ item_code: "PAINT", description: "Touch-up paint", qty_requested: 1, free_text: true }],
});
check("an absent balance is unknown too", rowFor("PAINT").stock_at_request, null);

// And nonsense is not a number either.
data.requests.createPartRequestBatch({
  requester: "TEST",
  items: [{ item_code: "OIL", description: "Chain oil", qty_requested: 1, free_text: true, stock_at_request: "n/a" }],
});
check("nonsense is unknown, not zero", rowFor("OIL").stock_at_request, null);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
