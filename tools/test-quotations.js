// QUOTATIONS, READ FROM AUTOCOUNT. No database needed:
//
//   node tools/test-quotations.js
//
// John, 23 Oct 2026: a read-only list of AutoCount's quotations for the eight
// people he named, searchable by debtor, quotation number or item, cancelled
// ones left out. Checked here: who gets it, and the shape of the query. The
// query itself runs only against AutoCount - check it on the live server.
const path = require("path");
const ac = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));
const fn = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

console.log("-- who sees it --");
const named = ["john", "chiuyan", "carmen", "iris", "chansing", "keeseng", "shirley", "khoon"];
check("the eight John named", named.map((id) => fn.canViewQuotations({ id })), named.map(() => true));
check("Alvin is an admin and is not on it", fn.canViewQuotations({ id: "alvin", role: "admin" }), false);
check("nor a technician", fn.canViewQuotations({ id: "ray", role: "tech" }), false);
check("nobody signed in", fn.canViewQuotations(null), false);
check("not a home-screen job button", fn.IDS.includes("qt"), false);

console.log("\n-- the query, no search --");
const all = ac.buildQuotationSearchSql("", null);
check("cancelled left out", /ISNULL\(m\.Cancelled, 'F'\) <> 'T'/.test(all.sql), true);
check("no date limit", /@since/.test(all.sql), false);
check("newest first", /ORDER BY m\.DocDate DESC, m\.DocNo DESC/.test(all.sql), true);
check("a page at a time", /OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY/.test(all.sql), true);
check("reads only", /\b(INSERT|UPDATE|DELETE|MERGE|EXEC|DROP)\b/i.test(all.sql), false);
check("no parameters", all.params, {});

console.log("\n-- the query, searched --");
const s = ac.buildQuotationSearchSql("  tan   bk 3410 ", "2026-07-23");
check("one condition per word, every word must match",
  (s.sql.match(/m\.DocNo LIKE '%' \+ @w\d \+ '%'/g) || []).length, 3);
check("the words as parameters, not in the SQL", [s.params.w0, s.params.w1, s.params.w2], ["tan", "bk", "3410"]);
check("item codes compared without spaces", s.params.n1, "BK");
check("searches the debtor", /m\.DebtorName LIKE '%' \+ @w0 \+ '%'/.test(s.sql), true);
check("searches the items' codes and descriptions",
  /REPLACE\(UPPER\(ISNULL\(x\.ItemCode, ''\)\), ' ', ''\) LIKE '%' \+ @n0 \+ '%'/.test(s.sql)
  && /x\.Description LIKE '%' \+ @w0 \+ '%'/.test(s.sql), true);
check("the date chip", [/m\.DocDate >= @since/.test(s.sql), s.params.since], [true, "2026-07-23"]);
check("nothing typed reaches the SQL", /tan|3410/i.test(s.sql), false);
const many = ac.buildQuotationSearchSql("a b c d e f g", null);
check("at most five words", Object.keys(many.params).filter((k) => k.startsWith("w")).length, 5);
const quote = ac.buildQuotationSearchSql("O'Brien", null);
check("a quote mark stays a parameter", [quote.params.w0, /O'Brien/.test(quote.sql)], ["O'Brien", false]);

console.log(failures ? `\n${failures} FAILED` : "\nAll passed");
process.exit(failures ? 1 : 0);
