// A SALES ORDER GOES INTO AUTOCOUNT WHOLE, OR NOT AT ALL. No database needed:
//
//   node tools/test-so-write-safety.js
//
// Slip 00289, 10 Nov 2026. The RG13's repair comment ran to 160 characters
// over three paragraphs; AutoCount's SODTL.Description is narrower, and line
// 8 of the order was refused with "String or binary data would be
// truncated". The writer had inserted the header and each line separately,
// so the header and seven lines stayed in AutoCount as SO-2611-040 while the
// app reported a failure and kept its placeholder SO-2026-00304.
//
// Checked, with AutoCount faked:
//   1. a long note becomes as many lines as it needs, none wider than the
//      column, every word kept and in order, its paragraphs kept apart;
//   2. those lines take the Seq numbers after their own, before the next row;
//   3. a part's description is clamped to the column too;
//   4. the write is one transaction: a refused line rolls back the header
//      and every line before it, and nothing is committed.
const path = require("path");
process.env.AUTOCOUNT_SO_WRITEBACK = "true";
process.env.AUTOCOUNT_SO_USER = "ADMIN";

const WIDTH = 100;   // what INFORMATION_SCHEMA is made to answer
// AutoCount's key counter (Registry 32768) and the highest key in its tables.
// The counter BEHIND the tables is what really happened on 10 Nov 2026.
let counter = 2254929, maxInTables = 2254949;
async function query(sql, params = {}) {
  if (/INFORMATION_SCHEMA/.test(sql)) return [{ Len: WIDTH }];
  if (/FROM Registry/.test(sql)) return [{ RegValue: String(counter) }];
  if (/FROM Debtor/.test(sql)) return [{ CompanyName: "GREEN FOREST LANDSCAPE PTE LTD", DisplayTerm: "30 DAYS" }];
  if (/SELECT ItemCode, Desc2 FROM Item/.test(sql)) return [];
  if (/SELECT DocNo FROM SO/.test(sql)) return [{ DocNo: "SO-2611-042" }];
  if (/SELECT UserID FROM Users/.test(sql)) return [{ UserID: "ADMIN" }];
  if (/MAX\(\[/.test(sql)) return [{ k: maxInTables }, { k: null }];
  if (/FROM ItemUOM WHERE/.test(sql)) return [{ UOM: "NOS" }];
  if (/SELECT TOP 1/.test(sql)) return [{ ok: 1 }];   // currency, terms, location, GL, tax
  throw new Error("unexpected query: " + sql.slice(0, 80));
}

// A transaction that records what happened to it, and refuses the Nth line.
// The counter is only moved if the transaction commits, as in SQL Server.
let refuseLine = 0, linesSeen = 0, committed = false, rolledBack = false, inserted = [], keys = [], locked = false;
async function inTransaction(fn) {
  committed = false; rolledBack = false; linesSeen = 0; inserted = []; keys = []; locked = false;
  let pending = counter;
  const run = async (sql, params = {}) => {
    if (/SELECT RegValue FROM Registry/.test(sql)) {
      locked = /UPDLOCK/.test(sql);
      return { rowsAffected: 1, recordset: [{ RegValue: String(pending) }] };
    }
    if (/MAX\(\[/.test(sql)) return { rowsAffected: 0, recordset: [{ k: maxInTables }, { k: null }] };
    if (/UPDATE Registry/.test(sql)) { pending = Number(params.v); return { rowsAffected: 1 }; }
    if (/INSERT INTO \[SODTL\]/.test(sql)) {
      linesSeen++;
      if (linesSeen === refuseLine) throw new Error("String or binary data would be truncated.");
    }
    if (/INSERT INTO/.test(sql)) keys.push(params.DtlKey !== undefined ? params.DtlKey : params.DocKey);
    inserted.push(sql.slice(0, 22));
    return { rowsAffected: 1 };
  };
  try { const out = await fn(run); counter = pending; committed = true; return out; }
  catch (e) { rolledBack = true; inserted = []; throw e; }
}
const conn = path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js");
require.cache[conn] = { id: conn, filename: conn, loaded: true,
  exports: { query, inTransaction, execute: async () => { throw new Error("written outside the transaction"); } } };
const so = require(path.resolve(__dirname, "..", "backend", "data", "autocountSalesOrder.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// Slip 00289's order, as the app built it - the comment word for word.
const COMMENT = "*The starter cover was dented due to human error. We have repaired and reshaped it accordingly. \n\n" +
  "Labour charges are waived (FOC) for this time. \n(Informed Mr Simon)";
const LINES = [
  { item_code: "A1 SVR LANDSCAPE", description: "Being repair & replacement of part :-", uom: "NOS", unit_price: 0, quantity: 1 },
  { item_code: "", description: "G2200 Chainsaw, S/S: 37230 / 00289 - 1/2" },
  { item_code: "", description: "*Condemned - too expensive to repair" },
  { item_code: "", description: "SubTotal" },
  { item_code: "", description: "" },
  { item_code: "A1 SVR LANDSCAPE", description: "Being repair & replacement of part :-", uom: "NOS", unit_price: 0, quantity: 1 },
  { item_code: "", description: "RG13, S/S: 37230 / 00289 - 2/2" },
  { item_code: "", description: COMMENT },
  { item_code: "", description: "*FOC" },
  { item_code: "", description: "SubTotal" },
  { item_code: "", description: "" },
  { item_code: "", description: "Mr Razib 8924 9672" },
  { item_code: "", description: "Mr Jaga 8747 0192" },
];
const PAYLOAD = { slipNumber: "00289", debtorCode: "C0260", lines: LINES };

(async () => {
  console.log("-- the long comment --");
  const built = await so.buildRows(PAYLOAD);
  const at = built.details.findIndex((d) => /^\*The starter cover/.test(d.Description));
  const comment = [];
  for (let i = at; i < built.details.length && built.details[i].Description !== "*FOC"; i++) comment.push(built.details[i]);
  check("split into lines, none wider than the column",
    [comment.length > 1, comment.every((d) => d.Description.length <= WIDTH)], [true, true]);
  check("every word kept, in order",
    comment.map((d) => d.Description).join(" ").split(/\s+/).join(" "),
    COMMENT.replace(/\s+/g, " ").trim());
  check("its paragraphs start lines of their own",
    comment.map((d) => d.Description.slice(0, 10)), ["*The start", "Labour cha", "(Informed "]);
  check("numbered on from its own Seq, before the next row's",
    [comment.map((d) => d.Seq), built.details[at + comment.length].Seq], [[128, 129, 130], 144]);

  console.log("\n-- a part's description --");
  const long = await so.buildRows({ ...PAYLOAD, lines: [LINES[0], LINES[6],
    { item_code: "SZEN 1", description: "X".repeat(150), uom: "NOS", unit_price: 1, quantity: 1 }] });
  check("clamped to the column", long.details.find((d) => d.ItemCode === "SZEN 1").Description.length, WIDTH);

  console.log("\n-- one transaction --");
  refuseLine = 8;
  let err = "";
  try { await so.createSalesOrder(PAYLOAD); } catch (e) { err = e.message; }
  check("AutoCount's refusal is reported", err, "String or binary data would be truncated.");
  check("and the header and earlier lines are rolled back, nothing committed",
    [rolledBack, committed, inserted.length], [true, false, 0]);

  check("and AutoCount's key counter is left where it was", counter, 2254929);

  refuseLine = 0;
  const ok = await so.createSalesOrder(PAYLOAD);
  check("with nothing refused, it all goes in and is committed",
    [committed, rolledBack, ok.doc_no, inserted.filter((s) => /\[SO\]/.test(s)).length], [true, false, "SO-2611-043", 1]);

  console.log("\n-- keys come from AutoCount's own counter (SO-2611-041, 11 Nov 2026) --");
  // The counter was BEHIND keys already in use: start above both.
  const n = keys.length;
  check("the counter row is locked while the keys are taken", locked, true);
  check("keys start above the highest in use, not at the stale counter",
    [ok.doc_key, keys[0], keys[1]], [2254950, 2254950, 2254951]);
  check("one key each, in a single unbroken run",
    keys.every((k, i) => k === keys[0] + i), true);
  check("the counter is moved past them all, with one to spare",
    counter, keys[0] + n);

  // The other way round: AutoCount's counter AHEAD of anything in the tables
  // (keys it has handed out but not used yet). They must not be taken.
  counter = 2260000; maxInTables = 2254949;
  const ahead = await so.createSalesOrder(PAYLOAD);
  check("with the counter ahead, keys start above the counter", ahead.doc_key, 2260001);
  check("and it moves on again", counter, 2260001 + keys.length);

  check("the dry run's preview starts where a real write would, and moves nothing",
    [await so.nextKey(), counter], [counter + 1, 2260001 + keys.length]);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
