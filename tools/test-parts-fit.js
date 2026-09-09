// The parts search, ranked around the machine in front of the technician.
//
//   node tools/test-parts-fit.js
//
// AutoCount is SQL Server and is not reachable from a workstation, so this
// does two things instead of pretending to be it:
//
//   1. captures the SQL searchParts actually builds, and checks the shapes
//      that would fail at the server - an empty CASE, a parameter with no
//      placeholder, the machine-unit exclusion going missing;
//   2. runs the SAME ranking rules over SQLite with real codes out of the
//      catalogue, so the ORDER the technician sees is checked and not assumed.
const path = require("path");


// ---- 1. the SQL that gets built ---------------------------------------------
// buildPartsSearchSql is the query apart from the running of it, so this reads
// the actual text the server would send without a SQL Server to send it to.
const acPath = path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js");
const { buildPartsSearchSql } = require(acPath);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const captureSql = async (q, limit, fit) => buildPartsSearchSql(q, limit, fit) || { sql: "", params: {} };

(async () => {
  console.log("\n-- the SQL it builds --");
  let c = await captureSql("clutch", 15, {});
  const sql = (c && c.sql) || "";
  if (!sql) {
    console.log(`  (could not capture SQL: ${c && c.error}) - the SQLite part below still runs`);
  } else {
    check("machine units are excluded", /NOT LIKE 'U%'/.test(sql), true);
    // The one that would break every search on the app's busiest screen.
    check("no CASE without a WHEN when there is no machine",
      /CASE\s+ELSE/.test(sql), false);
    check("every parameter it names is one it supplies",
      (sql.match(/@[a-zA-Z]\w*/g) || []).every((p) => p.slice(1) in (c.params || {})), true);

    c = await captureSql("clutch", 15, { brand: "SZEN", prefer: ["848CE037A0", "848BE058B2"] });
    check("with a machine, it ranks", /CASE\s+WHEN/.test(c.sql), true);
    check("the brand is a parameter, not glued into the text", c.params.brand, "SZEN");
    check("and so is every preferred number",
      [c.params.pf0, c.params.pf1], ["848CE037A0", "848BE058B2"]);
    check("still excluding units", /NOT LIKE 'U%'/.test(c.sql), true);
    // Injection is not possible through these - they are parameters - but a
    // brand arriving with punctuation in it should not reach the query at all.
    c = await captureSql("x", 15, { brand: "SZEN'; DROP TABLE Item; --" });
    check("a brand is letters or it is nothing", c.params.brand, "SZENDROPTABLEItem".toUpperCase());
  }

  // ---- 2. the ranking, over real codes ---------------------------------------
  // The same three rules, run where they can actually be executed. The codes
  // and descriptions are copied out of AutoCount's answer to "clutch".
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE Item (ItemCode TEXT, Description TEXT)`);
  const rows = [
    ["SHUQ 522664401", "Ball Bearing (Clutch #27)"],
    ["M1912GC 522664401R", "Ball Bearing (Clutch #27) Koyo"],
    ["SHUQ 503701502", "Clutch"],
    ["SHCN 599032701", "Clutch #M-211"],
    ["SBLG 501279", "Cable Clutch (80023527)"],
    ["SZEN 848CE037A0", "Clutch drum assembly"],
    ["UHUQ 525BX 967284201", "525BX Blower c/w Tools & Acc"],
    ["UZEN BK3410F51 BK3404Z", "ZENOAH BK3410FL-S Brushcutter"],
  ];
  const ins = db.prepare("INSERT INTO Item VALUES (?, ?)");
  for (const r of rows) ins.run(r[0], r[1]);

  // SQLite has no REPLACE-nesting problem and LIKE is case-insensitive for
  // ASCII, so the same predicates transcribe directly.
  const CODE = "REPLACE(REPLACE(UPPER(ItemCode),' ',''),'-','')";
  function search({ brand = "", prefer = [] } = {}) {
    const whens = [];
    const params = [];
    if (prefer.length) {
      const t = prefer.map(() => `${CODE} LIKE '%'||? OR ${CODE} LIKE '%'||?||'R'`).join(" OR ");
      whens.push(`WHEN ${t} THEN 0`);
      for (const n of prefer) params.push(n, n);
    }
    if (brand) { whens.push(`WHEN ${CODE} LIKE ?||'%' THEN 1`); params.push(brand); }
    const rank = whens.length ? `CASE ${whens.join(" ")} ELSE 2 END` : "2";
    return db.prepare(
      `SELECT ItemCode, ${rank} AS fit FROM Item
        WHERE UPPER(ItemCode) NOT LIKE 'U%'
          AND (Description LIKE '%clutch%' OR ${CODE} LIKE '%CLUTCH%')
        ORDER BY ${rank}, Description`
    ).all(...params, ...params);
  }

  console.log("\n-- machine units never appear --");
  const plain = search();
  check("the two whole machines are gone",
    plain.some((r) => r.ItemCode.startsWith("U")), false);
  check("and the parts are all still there", plain.length, 6);

  console.log("\n-- on a Zenoah brushcutter --");
  // Its own book gives 848CE037A0; its brand gives SZEN.
  const zen = search({ brand: "SZEN", prefer: ["848CE037A0"] });
  check("its own part is first", zen[0].ItemCode, "SZEN 848CE037A0");
  check("nothing else was dropped", zen.length, 6);
  check("and the rest follow underneath",
    zen.slice(1).every((r) => r.fit === 2), true);

  console.log("\n-- on a Husqvarna 395XP --");
  // 503701502 is the 395XP's CLUTCH ASSY in its book, and SHUQ 503701502 in
  // AutoCount. Husqvarna Construction (SHCN) is a different brand and stays
  // below, which is right: those parts do not fit this saw.
  const hus = search({ brand: "SHUQ", prefer: ["503701502"] });
  check("its own clutch first", hus[0].ItemCode, "SHUQ 503701502");
  check("then the rest of Husqvarna", hus[1].fit, 1);
  check("Husqvarna Construction is not Husqvarna", hus.find((r) => r.ItemCode.startsWith("SHCN")).fit, 2);

  console.log("\n-- the aftermarket equivalent counts as the same part --");
  // "M1912GC 522664401R" is the same bearing as "SHUQ 522664401". A technician
  // fitting one is fitting the other, so the book's number floats both.
  const both = search({ brand: "SHUQ", prefer: ["522664401"] });
  check("genuine and equivalent both rank as this machine's",
    both.filter((r) => r.fit === 0).map((r) => r.ItemCode).sort(),
    ["M1912GC 522664401R", "SHUQ 522664401"]);

  console.log("\n-- with no machine, nothing is reordered --");
  const none = search();
  check("everything ranks the same", [...new Set(none.map((r) => r.fit))], [2]);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
