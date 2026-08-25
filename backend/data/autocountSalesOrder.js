// data/autocountSalesOrder.js
// ============================================================================
// Writes a Sales Order into AutoCount.
//
// This is the app's only write of a DOCUMENT, as opposed to a field, and it is
// treated accordingly. What makes it acceptable:
//
//   - SO is not a document OM uses day to day. It was a technician test
//     document years ago, so an order written here cannot disturb live
//     paperwork. Sales staff read the draft and convert it to a DO, invoice or
//     cash sale by hand inside AutoCount, so a person sees every order before
//     it becomes anything official.
//   - Everything below was read from OM's own database rather than assumed:
//     the columns, which are mandatory, how an existing order fills them in,
//     and how AutoCount allocates its keys.
//
// KEY ALLOCATION
// AutoCount has no counter table. Watching it create an order showed the next
// key is simply the highest key anywhere in the document system plus one -
// DocKey is a single sequence shared by every document type, so a Sales Order
// and the Delivery Order it becomes sit either side of the same run.
//
// Two people saving at the same moment could therefore pick the same key.
// AutoCount has that race itself; we do better by letting the primary key
// catch the clash and retrying with a fresh number. A collision costs a retry;
// it can never write a duplicate.
// ============================================================================

const { query, execute } = require("./autocountConnection");

const SR9 = { code: "SR9", rate: 9 };
const SEQ_STEP = 16;      // AutoCount numbers lines 16, 32, 48 - room to insert
const LOCATION = "HQ";
const CURRENCY = "SGD";

const on = (v) => String(v || "false").toLowerCase() === "true";
function writebackEnabled() {
  return on(process.env.AUTOCOUNT_SO_WRITEBACK);
}
function userId() {
  // nvarchar(10). Deliberately identifiable: an order written by the app
  // should be obvious in AutoCount's own audit columns.
  return (process.env.AUTOCOUNT_SO_USER || "OMAPP").slice(0, 10);
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const guid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();

// Every table that shares the DocKey sequence. Missing one would risk handing
// out a key another document already holds.
const KEY_TABLES = [
  ["SO", "DocKey"], ["SODTL", "DtlKey"], ["DO", "DocKey"], ["DODTL", "DtlKey"],
  ["IV", "DocKey"], ["IVDTL", "DtlKey"], ["CS", "DocKey"], ["CSDTL", "DtlKey"],
  ["DN", "DocKey"], ["DNDTL", "DtlKey"], ["CN", "DocKey"], ["CNDTL", "DtlKey"],
  ["PO", "DocKey"], ["PODTL", "DtlKey"], ["GR", "DocKey"], ["GRDTL", "DtlKey"],
  ["PI", "DocKey"], ["PIDTL", "DtlKey"], ["QT", "DocKey"], ["QTDTL", "DtlKey"],
  ["ARInvoice", "DocKey"], ["ARPayment", "DocKey"], ["ARCN", "DocKey"], ["ARDN", "DocKey"],
  ["APInvoice", "DocKey"], ["APPayment", "DocKey"], ["JE", "DocKey"], ["JEDTL", "DtlKey"],
  ["ADJ", "DocKey"], ["ADJDTL", "DtlKey"], ["XFER", "DocKey"], ["XFERDTL", "DtlKey"],
  ["ISS", "DocKey"], ["ISSDTL", "DtlKey"], ["RCV", "DocKey"], ["RCVDTL", "DtlKey"],
  ["StockDTL", "DocKey"], ["StockTake", "DocKey"], ["XS", "DocKey"], ["XP", "DocKey"],
];

async function nextKey() {
  const parts = KEY_TABLES.map(([t, c]) => `SELECT MAX([${c}]) AS k FROM [${t}]`);
  const rows = await query(parts.join(" UNION ALL "));
  const top = rows.reduce((m, r) => (r.k !== null && Number(r.k) > m ? Number(r.k) : m), 0);
  if (!top) throw new Error("Could not read AutoCount's document keys.");
  return top + 1;
}

// The order number is the slip number with a suffix, the way OM already writes
// them: slip 32255 converted twice gives 32255-1 and 32255-2.
async function nextDocNo(slipNumber) {
  const rows = await query(
    "SELECT DocNo FROM SO WHERE DocNo = @exact OR DocNo LIKE @like",
    { exact: String(slipNumber), like: `${slipNumber}-%` }
  );
  let highest = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(String(r.DocNo || ""));
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${slipNumber}-${highest + 1}`;
}

// Read the customer's own details rather than assuming column names: pick the
// fields off the row if AutoCount has them, and leave them out if it does not.
async function debtor(code) {
  const rows = await query("SELECT TOP 1 * FROM Debtor WHERE AccNo = @code", { code });
  if (!rows.length) return null;
  const d = rows[0];
  const pick = (...names) => {
    for (const n of names) if (d[n] !== undefined && d[n] !== null && d[n] !== "") return d[n];
    return "";
  };
  return {
    name: pick("CompanyName", "Name"),
    term: pick("DisplayTerm", "CreditTerm", "Term"),
    addr1: pick("Address1", "InvAddr1"),
    addr2: pick("Address2", "InvAddr2"),
    addr3: pick("Address3", "InvAddr3"),
    addr4: pick("Address4", "InvAddr4"),
    phone: pick("Phone1", "Phone"),
    agent: pick("SalesAgent"),
  };
}

// A part's second description, as AutoCount shows it (the models a part fits).
async function desc2For(itemCodes) {
  if (!itemCodes.length) return {};
  const params = {};
  const names = itemCodes.map((c, i) => { params["c" + i] = c; return "@c" + i; });
  const rows = await query(
    `SELECT ItemCode, Desc2 FROM Item WHERE ItemCode IN (${names.join(",")})`,
    params
  );
  return Object.fromEntries(rows.map((r) => [r.ItemCode, r.Desc2 || ""]));
}

// ---------------------------------------------------------------------------
// Build the rows. Split out from the writing so a dry run can show exactly
// what would go in without touching anything.
// ---------------------------------------------------------------------------
async function buildRows({ slipNumber, debtorCode, contactName, contactNumber, salesAgent, lines }) {
  const cust = await debtor(debtorCode);
  if (!cust) {
    const e = new Error(`Debtor ${debtorCode} was not found in AutoCount.`);
    e.status = 400; throw e;
  }

  const codes = [...new Set(lines.filter((l) => l.item_code).map((l) => l.item_code))];
  const desc2 = await desc2For(codes);

  const docNo = await nextDocNo(slipNumber);
  const today = new Date();
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  let totalExTax = 0;
  let totalTax = 0;
  const details = [];

  lines.forEach((l, i) => {
    const seq = (i + 1) * SEQ_STEP;
    const isNote = !l.item_code;

    if (isNote) {
      // Note rows carry no item, quantity or price, but AutoCount still fills
      // in the tax code and the flags - an existing order shows exactly this.
      details.push({
        Seq: seq, MainItem: "T", Description: String(l.description || ""),
        Rate: 1, TaxType: SR9.code, TaxRate: SR9.rate,
        Transferable: "T", PrintOut: "T", DtlType: "N", AddToSubTotal: "T",
        StockReceived: "F", TransferedQty: 0,
        DeliveryDate: date, Guid: guid(),
      });
      return;
    }

    const qty = Number(l.quantity) || 0;
    const price = money(l.unit_price);
    const sub = money(qty * price);
    const tax = money(sub * (SR9.rate / 100));
    totalExTax = money(totalExTax + sub);
    totalTax = money(totalTax + tax);

    details.push({
      Seq: seq, MainItem: "T",
      ItemCode: l.item_code, Location: LOCATION,
      Description: String(l.description || ""),
      Desc2: desc2[l.item_code] || "",
      UOM: l.uom || "UNIT", UserUOM: l.uom || "UNIT",
      Qty: qty, Rate: 1, SmallestQty: qty,
      UnitPrice: price, SmallestUnitPrice: price,
      SubTotal: sub, LocalSubTotal: sub, SubTotalExTax: sub, LocalSubTotalExTax: sub,
      TaxType: SR9.code, TaxRate: SR9.rate,
      Tax: tax, LocalTax: tax, TaxCurrencyTax: tax,
      TaxableAmt: sub, LocalTaxableAmt: sub, TaxCurrencyTaxableAmt: sub,
      Transferable: "T", PrintOut: "T", DtlType: "N", AddToSubTotal: "T",
      StockReceived: "F", TransferedQty: 0,
      DeliveryDate: date, Guid: guid(),
    });
  });

  const net = money(totalExTax + totalTax);
  const header = {
    DocNo: docNo,
    DocDate: date,
    DebtorCode: debtorCode,
    DebtorName: cust.name || "",
    Description: "SALES ORDER",
    DisplayTerm: cust.term || "C.O.D",
    SalesAgent: salesAgent || cust.agent || "",
    InvAddr1: cust.addr1, InvAddr2: cust.addr2, InvAddr3: cust.addr3, InvAddr4: cust.addr4,
    Phone1: cust.phone || "",
    Attention: [contactName, contactNumber].filter(Boolean).join(" ").trim(),
    CurrencyCode: CURRENCY, CurrencyRate: 1, ToTaxCurrencyRate: 1,
    Total: totalExTax, TotalExTax: totalExTax,
    TaxableAmt: totalExTax, LocalTaxableAmt: totalExTax, TaxCurrencyTaxableAmt: totalExTax,
    AnalysisNetTotal: totalExTax, LocalAnalysisNetTotal: totalExTax,
    Tax: totalTax, LocalTax: totalTax, TaxCurrencyTax: totalTax,
    ExTax: totalTax, LocalExTax: totalTax,
    NetTotal: net, LocalNetTotal: net, FinalTotal: net,
    Transferable: "T", Cancelled: "F", PrintCount: 0,
    InclusiveTax: "F", IsRoundAdj: "F", CalcDiscountOnUnitPrice: "F",
    RoundingMethod: 4, MultiPrice: "P1", SalesLocation: LOCATION,
    CanSync: "F", LastUpdate: 0,
    Guid: guid(),
  };

  return { header, details, docNo, totalExTax, totalTax, net };
}

// ---------------------------------------------------------------------------
// Write it. One transaction: the header, its lines, and nothing half-written.
// ---------------------------------------------------------------------------
function insertSql(table, row) {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO [${table}] (${cols.map((c) => `[${c}]`).join(", ")}) ` +
         `VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    params: row,
  };
}

async function createSalesOrder(payload, { dryRun = false } = {}) {
  if (!writebackEnabled() && !dryRun) {
    const e = new Error("Writing Sales Orders to AutoCount is switched off.");
    e.status = 403; throw e;
  }
  const built = await buildRows(payload);

  if (dryRun) {
    const docKey = await nextKey();
    return {
      dry_run: true,
      doc_no: built.docNo,
      would_use_doc_key: docKey,
      header: built.header,
      details: built.details,
      totals: { ex_tax: built.totalExTax, tax: built.totalTax, net: built.net },
    };
  }

  // Optimistic allocation: take the next key, and if another document claimed
  // it in the meantime the primary key rejects the insert and we try again.
  // A clash costs a retry; it can never write a duplicate.
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const docKey = await nextKey();
    const header = { DocKey: docKey, ...built.header,
      LastModified: new Date(), CreatedTimeStamp: new Date(),
      LastModifiedUserID: userId(), CreatedUserID: userId() };
    try {
      const h = insertSql("SO", header);
      await execute(h.sql, h.params);

      let dtlKey = docKey;
      for (const d of built.details) {
        dtlKey += 1;
        const row = { DtlKey: dtlKey, DocKey: docKey, ...d };
        const q = insertSql("SODTL", row);
        await execute(q.sql, q.params);
      }
      return {
        dry_run: false,
        doc_no: built.docNo,
        doc_key: docKey,
        lines: built.details.length,
        totals: { ex_tax: built.totalExTax, tax: built.totalTax, net: built.net },
        attempts: attempt,
      };
    } catch (e) {
      lastError = e;
      const clash = /duplicate|primary key|unique/i.test(e.message || "");
      if (!clash) throw e;
      // Someone else took the key between reading and writing. Try again.
    }
  }
  throw new Error(`Could not allocate a document key after 4 tries: ${lastError && lastError.message}`);
}

module.exports = { createSalesOrder, buildRows, nextKey, nextDocNo, writebackEnabled };
