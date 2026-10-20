// WHAT A PART HAS BEEN SELLING FOR. No database needed:
//
//   node tools/test-recent-sales.js
//
// John, 15 Oct 2026: Check Price shows the most common unit price of the
// part's last 7 sales (12 months, before discount, no $0 lines, no service-
// slip orders), and a technician adding a part with no Contractor Price gets
// that price. Checked here: the figures worked out from the rows, and the
// shape of the query. The query itself runs only against AutoCount - check it
// on the live server.
const path = require("path");
const ac = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const row = (date, type, price, extra = {}) => ({
  DocDate: new Date(date + "T00:00:00"), DocType: type, DocNo: `${type}-${date}`,
  UnitPrice: price, LineQty: 1, BaseQty: 1, CurrencyRate: 1, ...extra,
});

console.log("-- the mock-up's example --");
const a = ac.summariseRecentSales([
  row("2026-10-03", "IV", 55), row("2026-09-28", "CS", 55), row("2026-09-20", "IV", 58),
  row("2026-09-02", "IV", 55), row("2026-08-11", "CS", 68), row("2026-07-30", "IV", 55),
  row("2026-06-12", "IV", 58),
]);
check("most common: $55, 4 of 7", a.common, { price: 55, count: 4 });
check("recommended", a.recommended, 55);
check("latest", [a.latest.date, a.latest.price, a.latest.doc_type], ["2026-10-03", 55, "INV"]);
check("the 7 kept, newest first", a.sales.map((s) => s.price), [55, 55, 58, 55, 68, 55, 58]);

console.log("\n-- ties, and none in common --");
const t = ac.summariseRecentSales([row("2026-10-03", "IV", 58), row("2026-09-01", "IV", 55),
  row("2026-08-01", "IV", 55), row("2026-07-01", "IV", 58)]);
check("a tie goes to the price sold most recently", t.common, { price: 58, count: 2 });
const d = ac.summariseRecentSales([row("2026-10-03", "IV", 40), row("2026-09-01", "CS", 42), row("2026-08-01", "IV", 45)]);
check("all different: no common price", d.common, null);
check("and the latest is recommended instead", d.recommended, 40);
const none = ac.summariseRecentSales([]);
check("never sold: nothing to recommend", [none.sales.length, none.recommended], [0, null]);

console.log("\n-- the price itself --");
const uom = ac.summariseRecentSales([row("2026-10-03", "IV", 30, { LineQty: 2, BaseQty: 20 })]);
check("2 BOX at $30 = 20 units: $3.00 each", uom.latest.price, 3);
const fx = ac.summariseRecentSales([row("2026-10-03", "IV", 10, { CurrencyRate: 1.35 })]);
check("a foreign-currency sale in SGD", fx.latest.price, 13.5);
const cents = ac.summariseRecentSales([row("2026-10-03", "IV", 10.004), row("2026-09-03", "IV", 9.996)]);
check("to the cent, so near-identical prices count together", cents.common, { price: 10, count: 2 });
check("a $0 line never counts", ac.summariseRecentSales([row("2026-10-03", "IV", 0)]).sales.length, 0);
check("DO and CS read as the screen calls them",
  ac.summariseRecentSales([row("2026-10-03", "DO", 5), row("2026-10-02", "CS", 5)]).sales.map((s) => s.doc_type), ["DO", "CS"]);

console.log("\n-- the query --");
const sql = ac.buildRecentSalesSql().replace(/\s+/g, " ");
check("the last 7", /SELECT TOP 7 /.test(sql), true);
check("from the stock ledger, sales out only", /FROM StockDTL s/.test(sql) && /s\.Qty < 0/.test(sql), true);
check("delivery orders, cash sales and invoices", /s\.DocType IN \('DO', 'CS', 'IV'\)/.test(sql), true);
check("not credit notes", /'CN'/.test(sql), false);
check("the unit price, before discount", /COALESCE\(d0\.UnitPrice, d1\.UnitPrice, d2\.UnitPrice\) AS UnitPrice/.test(sql), true);
check("$0 lines left out", /COALESCE\(d0\.UnitPrice, d1\.UnitPrice, d2\.UnitPrice\) > 0/.test(sql), true);
check("12 months", /s\.DocDate >= @since/.test(sql), true);
check("service-slip documents left out, in all three", (sql.match(/Description LIKE '%S\/S:%'/g) || []).length, 3);
check("newest first", /ORDER BY s\.DocDate DESC/.test(sql), true);
check("only the parameters it is given", [...sql.matchAll(/@(\w+)/g)].map((m) => m[1]).filter((v, i, x) => x.indexOf(v) === i).sort(), ["appSlipsFrom", "itemCode", "since"]);
// Paper-booklet repairs before the app count; this app's do not (20 Oct 2026,
// DO-2604-014 to Splendor Horticultural).
check("only S/S: documents since the app went live are left out",
  /AND NOT \( s\.DocDate >= @appSlipsFrom AND \(/.test(sql), true);

console.log("\n-- customers on special prices (20 Oct 2026) --");
// SQL LIKE, as the database reads it: % is anything, case does not matter.
const like = (name, pat) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i").test(name);
const special = (name) => ac.SPECIAL_PRICE_CUSTOMERS.some((p) => like(name, p));
// Names as the live Debtor list spells them, 20 Oct 2026.
for (const n of ["ACERTEC HARDWARE PTE LTD", "BAN SOON HARDWARE & HYDRAULIC SUPPLY",
  "CHONG BROTHER HARDWARE SUPPLY -Hardware City", "HORNE TRADING PTE LTD", "PRECISION CO PTE LTD", "KEH TECHNOLOGY"]) {
  check(`left out: ${n}`, special(n), true);
}
for (const n of ["COPTHORNE KING'S HOTEL SINGAPORE", "PRECISION PEST PTE. LTD.", "TAN LANDSCAPING PTE LTD", "CASH"]) {
  check(`kept: ${n}`, special(n), false);
}
check("the query leaves them out, by the document's name and the Debtor's",
  /AND NOT \( UPPER\(COALESCE\(m0\.DebtorName, m1\.DebtorName, m2\.DebtorName, ''\)\) LIKE '%HARDWARE%' OR UPPER\(ISNULL\(cust\.CompanyName, ''\)\) LIKE '%HARDWARE%'/.test(sql), true);
check("matched to the customer record by its code",
  /LEFT JOIN Debtor cust ON cust\.AccNo = COALESCE\(m0\.DebtorCode, m1\.DebtorCode, m2\.DebtorCode\)/.test(sql), true);

console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
process.exit(failures ? 1 : 0);
