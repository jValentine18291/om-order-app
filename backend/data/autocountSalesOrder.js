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
  // nvarchar(10), and a foreign key onto AutoCount's Users table - so it must
  // be a user that really exists. "OMAPP" was invented and AutoCount rejected
  // the insert, correctly.
  return (process.env.AUTOCOUNT_SO_USER || "").slice(0, 10);
}

// ---- Pre-flight ------------------------------------------------------------
// SO and SODTL carry two dozen foreign keys. Meeting them one failed insert at
// a time is slow and leaves half-built documents behind, so everything is
// checked first and every problem reported together.
//
// The one that matters most is SODTL(ItemCode, UOM) -> ItemUOM: a COMPOSITE
// key, so a part whose unit of measure in the app does not match the unit
// AutoCount holds for it is rejected even though the item code is perfectly
// valid. Rather than fail, the real unit is looked up and used.
async function preflight(details, header) {
  const problems = [];

  const one = async (sql, params, what) => {
    try {
      const rows = await query(sql, params);
      if (!rows.length) problems.push(what);
    } catch (e) {
      problems.push(`${what} (could not check: ${e.message})`);
    }
  };

  await one("SELECT TOP 1 CurrencyCode FROM CURRENCY WHERE CurrencyCode = @v",
            { v: header.CurrencyCode }, `currency "${header.CurrencyCode}" is not in AutoCount`);
  await one("SELECT TOP 1 DisplayTerm FROM Terms WHERE DisplayTerm = @v",
            { v: header.DisplayTerm }, `credit term "${header.DisplayTerm}" is not in AutoCount's Terms`);
  await one("SELECT TOP 1 Location FROM Location WHERE Location = @v",
            { v: header.SalesLocation }, `location "${header.SalesLocation}" is not in AutoCount`);
  await one("SELECT TOP 1 AccNo FROM GLMast WHERE AccNo = @v",
            { v: header.DebtorCode }, `debtor "${header.DebtorCode}" is not a GL account`);
  await one("SELECT TOP 1 TaxType FROM TaxType WHERE TaxType = @v",
            { v: SR9.code }, `tax type "${SR9.code}" is not in AutoCount`);

  // Every priced line: the item and unit must exist together in ItemUOM.
  for (const d of details) {
    if (!d.ItemCode) continue;
    const rows = await query(
      "SELECT UOM FROM ItemUOM WHERE ItemCode = @code",
      { code: d.ItemCode }
    );
    if (!rows.length) { problems.push(`part "${d.ItemCode}" is not in AutoCount`); continue; }
    const units = rows.map((r) => String(r.UOM));
    if (!units.includes(String(d.UOM))) {
      // The app stored a unit AutoCount does not use for this part. Take
      // AutoCount's own, rather than refusing over a difference we can settle.
      const chosen = units[0];
      d.UOM = chosen;
      d.UserUOM = chosen;
    }
  }

  return problems;
}

// Check the user before writing anything. Failing here costs nothing; failing
// half way through leaves a header with no lines behind it.
async function resolveUser() {
  const want = userId();
  const rows = await query("SELECT UserID FROM Users");
  const valid = rows.map((r) => String(r.UserID));
  if (want && valid.includes(want)) return want;

  const e = new Error(
    want
      ? `AUTOCOUNT_SO_USER is "${want}", which is not an AutoCount user. Valid users: ${valid.join(", ")}`
      : `AUTOCOUNT_SO_USER is not set. It must be an AutoCount user ID. Valid users: ${valid.join(", ")}`
  );
  e.status = 400;
  throw e;
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// GST computed in whole cents, not floating point. 79.50 x 9% is exactly 7.155
// and should round to 7.16, but in binary floating point it comes out as
// 7.154999999999999 and rounds DOWN to 7.15. That is a cent adrift on a tax
// figure, and worse, it depends on the number - so the same calculation is
// right on one line and wrong on the next. Integer cents make it exact.
function gstOn(amount, ratePercent) {
  const cents = Math.round((Number(amount) || 0) * 100);
  return Math.round((cents * ratePercent) / 100) / 100;
}

// AutoCount fields are plain nvarchar and its reports are not forgiving: the
// Cash Sales debtor's Phone1 came back with line breaks embedded in it, and
// those would have gone straight into the order.
function clean(v, max = 200) {
  return String(v == null ? "" : v)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}
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

  // An order from before the block format existed is just a list of parts: no
  // A1 opener, no machine heading, no SubTotal. Writing that into AutoCount
  // would produce a document nobody could read back to a machine, so refuse it
  // rather than quietly write a worse version of the right thing.
  const hasOpener = lines.some((l) => String(l.item_code || "").toUpperCase().startsWith("A1 SVR"));
  const hasHeading = lines.some((l) => !l.item_code && /S\/S:/.test(String(l.description || "")));
  if (!hasOpener || !hasHeading) {
    const e = new Error(
      "This order predates the AutoCount block format - it has no " +
      (hasOpener ? "" : "A1 SVR LANDSCAPE opening line") +
      (!hasOpener && !hasHeading ? " and no " : "") +
      (hasHeading ? "" : "machine heading") +
      ". Convert the slip again to produce a current order."
    );
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
  const subtotalAt = [];   // indexes of the subtotal rows, filled in afterwards

  lines.forEach((l, i) => {
    const seq = (i + 1) * SEQ_STEP;
    const isNote = !l.item_code;
    const isSubTotal = isNote && String(l.description || "").trim().toLowerCase() === "subtotal";

    if (isSubTotal) {
      // Filled in below, once the line taxes are settled.
      subtotalAt.push(details.length);
      // A real AutoCount subtotal, not a row with the word typed into it:
      // DtlType "S", and AddToSubTotal "F" so the subtotal is not itself
      // counted into the next one. The amount is what has accumulated since
      // the previous subtotal, computed from the lines actually written rather
      // than taken on trust - so the document always adds up to itself.
      details.push({
        Seq: seq, MainItem: "T",
        Description: "SubTotal ",
        DtlType: "S", AddToSubTotal: "F",
        Rate: 1, TaxType: SR9.code, TaxRate: SR9.rate,
        Transferable: "T", PrintOut: "T", StockReceived: "F", TransferedQty: 0,
        DeliveryDate: date, Guid: guid(),
      });
      return;
    }

    if (isNote) {
      // Note rows carry no item, quantity or price, but AutoCount still fills
      // in the tax code and the flags - an existing order shows exactly this.
      details.push({
        Seq: seq, MainItem: "T", Description: clean(l.description, 200),
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
    const tax = gstOn(sub, SR9.rate);
    totalExTax = money(totalExTax + sub);
    totalTax = money(totalTax + tax);

    details.push({
      Seq: seq, MainItem: "T",
      ItemCode: l.item_code, Location: LOCATION,
      Description: clean(l.description, 200),
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

  // AutoCount computes GST on the document TOTAL and then makes the lines add
  // up to it, rather than rounding each line on its own. In OM's own delivery
  // order the same part at 1.80 carries 0.16 on one machine and 0.17 on
  // another for exactly this reason. Rounding each line independently gives
  // 19.48 on that document where AutoCount gives 19.49 - and 19.49 is the
  // right figure, since GST is charged on the total.
  const documentTax = gstOn(totalExTax, SR9.rate);
  const drift = money(documentTax - totalTax);
  if (drift !== 0) {
    // Put the difference on the last priced line, the way AutoCount does.
    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i];
      if (d.ItemCode && d.Tax !== undefined) {
        d.Tax = money(d.Tax + drift);
        d.LocalTax = d.Tax;
        d.TaxCurrencyTax = d.Tax;
        break;
      }
    }
    totalTax = documentTax;
  }

  // Now the subtotals, summed from the lines as they finally stand - so each
  // block adds up to itself and the blocks add up to the document.
  let blockExTax = 0, blockTax = 0;
  for (let i = 0; i < details.length; i++) {
    const d = details[i];
    if (d.DtlType === "S") {
      Object.assign(d, {
        SubTotal: money(blockExTax), LocalSubTotal: money(blockExTax),
        SubTotalExTax: money(blockExTax), LocalSubTotalExTax: money(blockExTax),
        Tax: money(blockTax), LocalTax: money(blockTax), TaxCurrencyTax: money(blockTax),
        TaxableAmt: money(blockExTax), LocalTaxableAmt: money(blockExTax),
        TaxCurrencyTaxableAmt: money(blockExTax),
      });
      blockExTax = 0; blockTax = 0;
      continue;
    }
    if (d.SubTotal !== undefined) blockExTax = money(blockExTax + d.SubTotal);
    if (d.Tax !== undefined) blockTax = money(blockTax + d.Tax);
  }

  const net = money(totalExTax + totalTax);
  const header = {
    DocNo: docNo,
    DocDate: date,
    DebtorCode: debtorCode,
    DebtorName: clean(cust.name, 100),
    Description: "SALES ORDER",
    DisplayTerm: clean(cust.term, 30) || "C.O.D",
    // Left to the customer's own default, or blank. "KM/WJ" is not an
    // AutoCount sales agent - it is two technician initials joined together,
    // and writing it would put an invalid value on the document. Sales set the
    // agent when they review the draft.
    SalesAgent: clean(cust.agent, 12),
    InvAddr1: clean(cust.addr1, 100), InvAddr2: clean(cust.addr2, 100),
    InvAddr3: clean(cust.addr3, 100), InvAddr4: clean(cust.addr4, 100),
    Phone1: clean(cust.phone, 40),
    Attention: clean([contactName, contactNumber].filter(Boolean).join(" "), 100),
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
// Columns that hold a code rather than free text. AutoCount checks these
// against other tables, and an empty string is not a valid code - leaving the
// column out entirely lets the default or NULL apply instead.
const CODED = new Set(["SalesAgent", "BranchCode", "ShipVia", "ProjNo", "DeptNo", "Area", "SalesExemptionNo"]);

function insertSql(table, row) {
  const cols = Object.keys(row).filter((c) => !(CODED.has(c) && String(row[c] || "") === ""));
  return {
    sql: `INSERT INTO [${table}] (${cols.map((c) => `[${c}]`).join(", ")}) ` +
         `VALUES (${cols.map((c) => "@" + c).join(", ")})`,
    params: Object.fromEntries(cols.map((c) => [c, row[c]])),
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
    const dryProblems = await preflight(built.details, built.header).catch((e) => [e.message]);
    return {
      dry_run: true,
      problems: dryProblems,
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
  const who = await resolveUser();

  const problems = await preflight(built.details, built.header);
  if (problems.length) {
    const e = new Error("AutoCount would reject this order: " + problems.join("; "));
    e.status = 400; throw e;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const docKey = await nextKey();
    const header = { DocKey: docKey, ...built.header,
      LastModified: new Date(), CreatedTimeStamp: new Date(),
      LastModifiedUserID: who, CreatedUserID: who };
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
