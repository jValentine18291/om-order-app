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

    // The two shapes that have actually taken this query down, both only
    // reachable with NO machine - which is every search on Find Part.
    //
    // "CASE ELSE 2 END" is not SQL at all. And a bare number in the ORDER BY
    // list is not the constant it looks like: SQL Server either refuses it or
    // reads it as a column position. This one shipped, and because the route
    // turns a failed query into an empty result, it looked exactly like a
    // search that found nothing.
    check("no CASE without a WHEN", /CASE\s+ELSE/.test(sql), false);
    const orderTerms = (t) => t.split("ORDER BY")[1].split(/,(?![^()]*\))/)
      .map((x) => x.replace(/\s+/g, " ").trim());
    check("and nothing in ORDER BY is a bare number",
      orderTerms(sql).filter((t) => /^\d+$/.test(t)), []);
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

    // Every shape the four combinations of machine context can produce, held
    // to the same two rules. The one that broke was reachable only by the
    // combination nothing was checking.
    for (const [label, fit] of [
      ["no machine", {}],
      ["brand only", { brand: "SZEN" }],
      ["book only", { prefer: ["848CE037A0"] }],
      ["both", { brand: "SZEN", prefer: ["848CE037A0"] }],
    ]) {
      const t = (await captureSql("carb", 15, fit)).sql;
      check(`${label}: no bare number in ORDER BY`,
        orderTerms(t).filter((x) => /^\d+$/.test(x)), []);
      check(`${label}: no CASE without a WHEN`, /CASE\s+ELSE/.test(t), false);
    }

    // The A-series service items. Typing one names it exactly, and it is not
    // a part of any machine, so it goes above the fit ranking rather than
    // under it. Same four combinations, because the term is what decides.
    for (const [label, fit] of [
      ["no machine", {}],
      ["brand only", { brand: "SZEN" }],
      ["book only", { prefer: ["848CE037A0"] }],
      ["both", { brand: "SZEN", prefer: ["848CE037A0"] }],
    ]) {
      const t = await captureSql("A8", 15, fit);
      check(`A8, ${label}: promoted above the fit ranking`, /THEN -1/.test(t.sql), true);
      check(`A8, ${label}: on the code the technician typed`, t.params.acode, "A8");
      check(`A8, ${label}: still no bare number in ORDER BY`,
        orderTerms(t.sql).filter((x) => /^\d+$/.test(x)), []);
      check(`A8, ${label}: every parameter it names is one it supplies`,
        (t.sql.match(/@[a-zA-Z]\w*/g) || []).every((x) => x.slice(1) in (t.params || {})), true);
    }

    // And only for a term that named one. A description that happens to
    // mention oil must not drag the service item over the machine's parts,
    // and "A" on its own names nothing.
    for (const term of ["carb", "oil", "engine oil", "A", "SZEN 848"]) {
      const t = await captureSql(term, 15, { brand: "SZEN", prefer: ["848CE037A0"] });
      check(`"${term}" does not promote a service item`, /THEN -1/.test(t.sql), false);
      check(`"${term}" supplies no acode`, "acode" in (t.params || {}), false);
    }
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

  console.log("\n-- the A-series service items --");
  // What the technician actually sees. These are the real answers AutoCount
  // gives to "A6", "A7" and "A8", in the order it gave them BEFORE this
  // change - with a BK3410 in front of the technician, "A8" put three Zenoah
  // codes above A8 SPARE PARTS, because they contain "A8" somewhere in the
  // code and they are the right brand.
  const sv = new DatabaseSync(":memory:");
  sv.exec(`CREATE TABLE Item (ItemCode TEXT, Description TEXT)`);
  const svRows = [
    ["A6 SVR ENGINE OIL", "Change engine oil"],
    ["M1205SP A68", "Bando V-Belt A68"],
    ["SZEN 848L0A65G0", "Handle 2-28"],
    ["A7 SVR WAREHOUSE", "Warehouse Service"],
    ["SZEN SKS90SA73R", "Belt (Bando SA73)"],
    ["SZEN 848E0A7123", "Coil Assy"],
    ["A8 SPARE PARTS", "Spare Parts Of Equipment"],
    ["M1205SP A88", "Bando V-Belt A88"],
    ["SZEN 848E0A8102", "Carburetor-A (WYL-190) #4-8"],
    ["SZEN 848E0A83F0", "Element #5-37"],
    ["SZEN 644013002R", "Gearcase Assy 24X7 (A8)"],
  ];
  const inssv = sv.prepare("INSERT INTO Item VALUES (?, ?)");
  for (const r of svRows) inssv.run(...r);

  // The same rules as the query, transcribed: the service promotion, then the
  // machine's own part, then its brand.
  function svSearch(term, { brand = "", prefer = [] } = {}) {
    const acode = term.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const whens = [];
    const params = [];
    if (/^A\d/.test(acode)) { whens.push(`WHEN ${CODE} LIKE ?||'%' THEN -1`); params.push(acode); }
    if (prefer.length) {
      whens.push(`WHEN ${prefer.map(() => `${CODE} LIKE '%'||?`).join(" OR ")} THEN 0`);
      for (const n of prefer) params.push(n);
    }
    if (brand) { whens.push(`WHEN ${CODE} LIKE ?||'%' THEN 1`); params.push(brand); }
    const rank = whens.length ? `CASE ${whens.join(" ")} ELSE 2 END` : "2";
    const like = `%${acode}%`;
    return sv.prepare(
      `SELECT ItemCode, ${rank} AS fit FROM Item
        WHERE UPPER(ItemCode) NOT LIKE 'U%'
          AND (UPPER(Description) LIKE ? OR ${CODE} LIKE ?)
        ORDER BY ${rank}, Description`
      // Placeholders bind in the order they appear in the text: the rank in
      // the SELECT, the two in the WHERE, then the rank again in ORDER BY.
    ).all(...params, like, like, ...params);
  }

  const onZenoah = { brand: "SZEN", prefer: ["848CE037A0"] };
  check("A6 comes first on a Zenoah", svSearch("A6", onZenoah)[0].ItemCode, "A6 SVR ENGINE OIL");
  check("A7 comes first on a Zenoah", svSearch("A7", onZenoah)[0].ItemCode, "A7 SVR WAREHOUSE");
  check("A8 comes first on a Zenoah", svSearch("A8", onZenoah)[0].ItemCode, "A8 SPARE PARTS");

  // Nothing is hidden by it - the Zenoah codes that contain "A8" are still
  // there, just underneath, and still ahead of the other brands.
  const a8 = svSearch("A8", onZenoah);
  check("the rest are still listed", a8.length, 5);
  check("with the machine's brand next",
    a8.slice(1, 4).every((r) => r.ItemCode.startsWith("SZEN")), true);

  // With no machine at all it is unchanged from what it always did, because
  // the service item was already winning on the exact-code rule there.
  check("A8 first with no machine either", svSearch("A8")[0].ItemCode, "A8 SPARE PARTS");

  console.log("\n-- the model AutoCount records against the part --");
  // Desc2 says which model a part is for, across 82% of the catalogue. These
  // are the real shapes it comes in, copied off the live database searching
  // "BK3410": plain, comma-separated, and a model with words after it.
  const d2 = new DatabaseSync(":memory:");
  d2.exec(`CREATE TABLE Item (ItemCode TEXT, Description TEXT, Desc2 TEXT)`);
  const d2rows = [
    ["SZEN T115181001", "Carburetor Assy 2-73", "BK3410"],
    ["M0812GC SGR-3080", "2T Cutting Blade (Rhinomec)", "BK3410"],
    ["M1618GC T115486110R", "9.5mm Black/Grey Fuel Hose", "BK3410, TL33"],
    ["M0619GC AZR HOSE", "AZR HOSE 20 BAR TYPE 25mm", "BK3410 TK HOSE"],
    ["SZEN 455081000", "Carb Assy 2-67", "BK4310"],
    ["SHUQ 503701502", "Clutch Assy", "365, 372XP"],
    ["SHUQ 999999999", "Something", "3650"],
    ["SBNS 391065", "Carburetor", ""],
    ["SPUL K10SP G00294", "Air non-return valve", "K10SP"],
    ["SZEN 587862802", "Case", "LHTZ-A"],
  ];
  const insd2 = d2.prepare("INSERT INTO Item VALUES (?, ?, ?)");
  for (const r of d2rows) insd2.run(...r);

  // The same expression the query builds, transcribed. SQLite has REPLACE and
  // UPPER too, so the tokenising is checked rather than described.
  // Hyphens removed, not split on: they sit inside a model name rather than
  // between two of them. "LHTZ-A" is one model, not "LHTZ" and "A".
  const D2 = `',' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(IFNULL(Desc2,'')),'-',''),'/',','),'&',','),' ',','),',,',',') || ','`;
  const byModel = (models) => d2.prepare(
    `SELECT ItemCode FROM Item WHERE ` +
    models.map(() => `${D2} LIKE '%,'||?||',%'`).join(" OR ") + ` ORDER BY ItemCode`
  ).all(...models).map((r) => r.ItemCode);

  check("a plain model matches",
    byModel(["BK4310"]), ["SZEN 455081000"]);
  // All four BK3410 shapes, including the two aftermarket parts a parts book
  // would never have listed - which is the whole reason Desc2 beats the book.
  check("plain, comma-separated and model-plus-words all match",
    byModel(["BK3410"]),
    ["M0619GC AZR HOSE", "M0812GC SGR-3080", "M1618GC T115486110R", "SZEN T115181001"]);
  check("the thick-hose variant is still a BK3410",
    byModel(["BK3410"]).includes("M0619GC AZR HOSE"), true);
  check("the second model in a pair matches too", byModel(["TL33"]),
    ["M1618GC T115486110R"]);
  check("and so does one in the middle of a list", byModel(["372XP"]), ["SHUQ 503701502"]);
  check("a fogger finds its own", byModel(["K10SP"]), ["SPUL K10SP G00294"]);
  // A model whose name carries a hyphen. Both sides drop it, so they meet.
  check("a hyphenated model matches", byModel(["LHTZA"]), ["SZEN 587862802"]);

  // The reason models are matched whole and never as a prefix.
  check("3650 is not 365", byModel(["3650"]), ["SHUQ 999999999"]);
  check("nor is 365 a 3650", byModel(["365"]), ["SHUQ 503701502"]);
  check("a part with no model recorded matches nothing",
    byModel(["BK3410", "K10SP", "365"]).includes("SBNS 391065"), false);

  console.log("\n-- what a machine sends as its model --");
  // Only words carrying a digit are sent, which is what keeps the words staff
  // write around the model from ever matching one.
  const MI = require(path.resolve(__dirname, "..", "frontend", "machine-ipl.js"));
  const words = (desc) => MI.modelWordsFor({ machine_code: "", machine_desc: desc });
  check("the model alone", words("BK3410"), ["BK3410"]);
  check("the model with words around it", words("BK3410 Backpack Brushcutter"), ["BK3410"]);
  check("the model in brackets", words("BK3410 (thick hose)"), ["BK3410"]);
  check("a fogger", words("K10SP Thermal Fogger"), ["K10SP"]);
  check("nothing that is only words", words("Old red mower"), []);
  // The case that started this: a suffix glued on is a different word, and
  // matches nothing. That is what the staff instruction is for.
  check("a suffix glued on is not the model", words("BK3410FL51 Brushcutter"), ["BK3410FL51"]);
  check("and it finds no parts", byModel(words("BK3410FL51 Brushcutter")), []);

  console.log("\n-- with no machine, nothing is reordered --");
  const none = search();
  check("everything ranks the same", [...new Set(none.map((r) => r.fit))], [2]);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
