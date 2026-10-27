// ITEM PACKAGES ON THE SALES ORDER WRITTEN INTO AUTOCOUNT. No database needed:
//
//   node tools/test-so-packages.js
//
// John, 27 Oct 2026: technicians can put an AutoCount Item Package on a machine
// as one line. The Sales Order the app writes into AutoCount has to carry it
// the way AutoCount itself does, read off OM's own cash sale CS DocKey 2230413
// (tools/show-package-lines.js): a package line with no ItemCode and the
// PackageDocKey, then its items as DtlType "P" lines pointing back at it by
// ParentDtlKey, with SubQty, the package's own prices, and tax that adds up to
// the package line's. Only the package line counts in the document's totals.
//
// AutoCount is faked here with the real Cleaner Assy 4-35 package, so this
// checks the rows the app would insert without touching AutoCount.
const path = require("path");

// A stand-in for autocountConnection, answering the few questions buildRows
// asks. Anything else is a question this test did not expect.
const PACKAGE = { DocKey: 66606, PackageCode: "SZEN 140082002", Description: "Cleaner Assy 4-35 ", UserUOM: "SET" };
const PACKAGE_ITEMS = [
  { Seq: 16, ItemCode: "SZEN 140082113", Description: "Body 2-100 ", UOM: "PC", Qty: 1, UnitPrice: 3.7 },
  { Seq: 32, ItemCode: "SZEN 140082121", Description: "Cover 2-101 ", UOM: "PC", Qty: 1, UnitPrice: 3.7 },
  { Seq: 48, ItemCode: "SZEN 141882130", Description: "Element 2-102", UOM: "PC", Qty: 1, UnitPrice: 2.2 },
  { Seq: 64, ItemCode: "SZEN 140082141", Description: "Screen 2-103 ", UOM: "PC", Qty: 1, UnitPrice: 2.7 },
];
const asked = [];
async function query(sql, params = {}) {
  asked.push(sql);
  if (/FROM Debtor/.test(sql)) return [{ CompanyName: "TEST CO", DisplayTerm: "C.O.D" }];
  if (/FROM Package WHERE/.test(sql)) return params.c === PACKAGE.PackageCode ? [PACKAGE] : [];
  if (/FROM PackageDTL/.test(sql)) return params.k === PACKAGE.DocKey ? PACKAGE_ITEMS : [];
  if (/SELECT ItemCode, Desc2 FROM Item/.test(sql)) {
    return Object.values(params).map((c) => ({ ItemCode: c, Desc2: "BK3410" }));
  }
  if (/SELECT DocNo FROM SO/.test(sql)) return [];
  throw new Error("unexpected query: " + sql.slice(0, 80));
}
const conn = path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js");
require.cache[conn] = { id: conn, filename: conn, loaded: true, exports: { query, execute: async () => {} } };
const so = require(path.resolve(__dirname, "..", "backend", "data", "autocountSalesOrder.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const money = (n) => Math.round(n * 100) / 100;

// A slip's block as slipBlockLines produces it: the A1 opener, the machine
// heading, a part, the package, the subtotal.
const block = (pkg) => [
  { item_code: "A1 SVR LANDSCAPE", description: "Service", uom: "NOS", unit_price: 0, quantity: 1 },
  { item_code: "", description: "BK3410, S/S: 00123 - 1/1" },
  { item_code: "M1618SK WS7F", description: "Bosch WS7F Spark plug", uom: "PC", unit_price: 2.8, quantity: 1 },
  { item_code: "SZEN 140082002", description: "Cleaner Assy 4-35", uom: "SET", is_package: 1, ...pkg },
  { item_code: "", description: "SubTotal" },
];

(async () => {
  console.log("-- two Cleaner Assy packages at the package price, as the DO in AutoCount has them --");
  let built = await so.buildRows({ slipNumber: "00123", debtorCode: "C0112", lines: block({ unit_price: 12.3, quantity: 2 }) });
  let rows = so.keyedRows(built.details, 1000);
  const parent = rows.find((r) => r.PackageDocKey);
  const kids = rows.filter((r) => r.DtlType === "P");
  check("the package line: no item code, the package's key, its qty and price",
    [parent.ItemCode, parent.PackageDocKey, parent.Qty, parent.UnitPrice, parent.SubTotal, parent.UserUOM, parent.DtlType],
    [undefined, 66606, 2, 12.3, 24.6, "SET", "N"]);
  // 2.21 on its own, plus the document's odd cent (GST on 27.40 is 2.47, the
  // lines come to 2.46) - which lands on the last priced line, this one. The
  // same 2.22 AutoCount's own DO 2223548 carries for two of them.
  check("no tax code on it, but its tax", [parent.TaxType, parent.Tax], [undefined, 2.22]);
  check("then its four items, in the package's order",
    kids.map((k) => k.ItemCode), PACKAGE_ITEMS.map((i) => i.ItemCode));
  check("straight after it", rows.indexOf(kids[0]), rows.indexOf(parent) + 1);
  check("each pointing at the package line", [...new Set(kids.map((k) => k.ParentDtlKey))], [parent.DtlKey]);
  check("qty per package, and for the two", kids.map((k) => [k.SubQty, k.Qty]), [[1, 2], [1, 2], [1, 2], [1, 2]]);
  check("the package's own prices", kids.map((k) => [k.UnitPrice, k.SubTotal]), [[3.7, 7.4], [3.7, 7.4], [2.2, 4.4], [2.7, 5.4]]);
  check("numbered 16, 32... of their own", kids.map((k) => k.Seq), [16, 32, 48, 64]);
  check("taxed SR9", [...new Set(kids.map((k) => k.TaxType))], ["SR9"]);
  check("their tax adds up to the package line's", money(kids.reduce((t, k) => t + k.Tax, 0)), parent.Tax);
  check("not transferable on their own, and no delivery date", [kids[0].Transferable, kids[0].DeliveryDate], [undefined, undefined]);
  check("their models from the catalogue", kids[0].Desc2, "BK3410");
  check("no stray helper field reaches AutoCount", rows.some((r) => "_parent" in r), false);
  check("the document counts the package once", [built.totalExTax, built.net], [money(2.8 + 24.6), money(27.4 + built.totalTax)]);
  const subtotal = rows.find((r) => r.DtlType === "S");
  check("and so does the machine's subtotal", subtotal.SubTotal, 27.4);
  check("the tax on the lines that count adds up to the document's",
    money(rows.filter((r) => r.DtlType === "N" && r.Tax !== undefined).reduce((t, r) => t + r.Tax, 0)), built.totalTax);

  console.log("\n-- the package priced differently on the slip --");
  built = await so.buildRows({ slipNumber: "00123", debtorCode: "C0112", lines: block({ unit_price: 10, quantity: 1 }) });
  rows = so.keyedRows(built.details, 1000);
  const p2 = rows.find((r) => r.PackageDocKey);
  const k2 = rows.filter((r) => r.DtlType === "P");
  check("the package line at the slip's price", [p2.UnitPrice, p2.SubTotal], [10, 10]);
  check("its items scaled to add up to it exactly", money(k2.reduce((t, k) => t + k.SubTotal, 0)), 10);
  check("and their tax to its tax", money(k2.reduce((t, k) => t + k.Tax, 0)), p2.Tax);

  console.log("\n-- a package AutoCount no longer has --");
  let err = "";
  try {
    await so.buildRows({ slipNumber: "00123", debtorCode: "C0112",
      lines: block({ item_code: "GONE PKG", unit_price: 5, quantity: 1 }).map((l) => l.is_package ? { ...l, item_code: "GONE PKG" } : l) });
  } catch (e) { err = e.message; }
  check("refused before anything is written, naming it", /Item package GONE PKG is not in AutoCount/.test(err), true);

  console.log("\n-- the same code as an ordinary item is an ordinary line --");
  built = await so.buildRows({ slipNumber: "00123", debtorCode: "C0112",
    lines: block({ unit_price: 12.3, quantity: 1 }).map((l) => (l.is_package ? { ...l, is_package: 0 } : l)) });
  rows = so.keyedRows(built.details, 1000);
  check("SZEN 140082002 without the flag goes on as an item",
    [rows.some((r) => r.PackageDocKey), rows.some((r) => r.ItemCode === "SZEN 140082002")], [false, true]);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
