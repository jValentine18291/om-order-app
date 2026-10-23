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
const all = ac.buildQuotationSearchSql({});
check("cancelled left out", /ISNULL\(m\.Cancelled, 'F'\) <> 'T'/.test(all.sql), true);
check("no date limit", /@since/.test(all.sql), false);
check("newest first", /ORDER BY m\.DocDate DESC, m\.DocNo DESC/.test(all.sql), true);
check("a page at a time", /OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY/.test(all.sql), true);
check("reads only", /\b(INSERT|UPDATE|DELETE|MERGE|EXEC|DROP)\b/i.test(all.sql), false);
check("no parameters", all.params, {});

console.log("\n-- the debtor / quotation no. box --");
const s = ac.buildQuotationSearchSql({ q: "  tan   2610 ", since: "2026-07-23" });
check("one condition per word, every word must match",
  (s.sql.match(/m\.DocNo LIKE '%' \+ @w\d \+ '%' OR m\.DebtorName LIKE '%' \+ @w\d \+ '%'/g) || []).length, 2);
check("the words as parameters, not in the SQL", [s.params.w0, s.params.w1], ["tan", "2610"]);
check("does not look at the items", /QTDTL x/.test(s.sql), false);
check("the date chip", [/m\.DocDate >= @since/.test(s.sql), s.params.since], [true, "2026-07-23"]);
check("nothing typed reaches the SQL", /tan|2610/i.test(s.sql.replace(/QT-?\d*/g, "")), false);
const many = ac.buildQuotationSearchSql({ q: "a b c d e f g" });
check("at most five words", Object.keys(many.params).filter((k) => k.startsWith("w")).length, 5);
const quote = ac.buildQuotationSearchSql({ q: "O'Brien" });
check("a quote mark stays a parameter", [quote.params.w0, /O'Brien/.test(quote.sql)], ["O'Brien", false]);

console.log("\n-- the item box, typed --");
const it = ac.buildQuotationSearchSql({ item: "shoe bk 3410" });
check("one EXISTS: every word on the same line", (it.sql.match(/EXISTS/g) || []).length, 1);
check("the words as parameters", [it.params.iw0, it.params.iw1, it.params.iw2], ["shoe", "bk", "3410"]);
check("codes compared without spaces", /REPLACE\(UPPER\(ISNULL\(x\.ItemCode, ''\)\), ' ', ''\) LIKE '%' \+ @in1 \+ '%'/.test(it.sql), true);
check("and descriptions", /x\.Description LIKE '%' \+ @iw0 \+ '%'/.test(it.sql), true);
check("not the debtor", /m\.DebtorName LIKE/.test(it.sql), false);

console.log("\n-- the item box, a suggestion tapped --");
const ex = ac.buildQuotationSearchSql({ q: "donjon", item: "ignored", code: "SZEN 140051111" });
check("exactly that code", [/x\.ItemCode = @code/.test(ex.sql), ex.params.code], [true, "SZEN 140051111"]);
check("the typed words give way to it", /@iw0/.test(ex.sql), false);
check("and the debtor box still applies", /m\.DebtorName LIKE '%' \+ @w0/.test(ex.sql), true);

console.log("\n-- the item box's suggestions --");
check("nothing typed, nothing asked", ac.buildQuotedItemsSql("  "), null);
const sg = ac.buildQuotedItemsSql("shoe 3410");
check("only quoted items, cancelled left out",
  /FROM QTDTL d JOIN QT m/.test(sg.sql) && /ISNULL\(m\.Cancelled, 'F'\) <> 'T'/.test(sg.sql), true);
check("one row per part, most quoted first",
  /GROUP BY d\.ItemCode/.test(sg.sql) && /ORDER BY COUNT\(DISTINCT d\.DocKey\) DESC/.test(sg.sql), true);
check("every word on the line", [sg.params.w0, sg.params.n1], ["shoe", "3410"]);
check("reads only", /\b(INSERT|UPDATE|DELETE|MERGE|EXEC|DROP)\b/i.test(sg.sql + ex.sql + it.sql), false);

console.log(failures ? `\n${failures} FAILED` : "\nAll passed");
process.exit(failures ? 1 : 0);
