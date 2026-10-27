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

// Numbered the way OM's other documents are: SO-YYMM-NNN, so August 2026 runs
// SO-2608-001, -002 and so on, starting again each month. It used to be the
// slip number with a suffix, which read nothing like their DO-2608-160.
//
// The running number is taken from what is already in AutoCount for this month
// rather than counted locally, so a document keyed by hand cannot collide with
// one written by the app.
function docNoPrefix(when) {
  const yy = String(when.getFullYear()).slice(2);
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  return `SO-${yy}${mm}-`;
}

async function nextDocNo(when) {
  const prefix = docNoPrefix(when);
  const rows = await query("SELECT DocNo FROM SO WHERE DocNo LIKE @like", { like: `${prefix}%` });
  let highest = 0;
  for (const r of rows) {
    // No dynamic regular expression here: the prefix contains hyphens and
    // building a pattern out of it invites exactly the escaping mistakes that
    // silently match nothing. Comparing strings is plainer and cannot misfire.
    const no = String(r.DocNo || "");
    if (!no.startsWith(prefix)) continue;
    const tail = no.slice(prefix.length);
    if (!/^[0-9]+$/.test(tail)) continue;
    highest = Math.max(highest, Number(tail));
  }
  const next = highest + 1;
  // Three digits normally; a month that somehow passes 999 keeps counting
  // rather than wrapping back onto a number already used.
  return prefix + String(next).padStart(3, "0");
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

// ITEM PACKAGES (27 Oct 2026, John). A technician can put an AutoCount Item
// Package on a machine as one line ("SZEN 140082002 Cleaner Assy 4-35").
// AutoCount writes a package onto a document in a shape of its own, read off
// OM's own cash sales and DOs (tools/show-package-lines.js):
//
//   the PACKAGE line   no ItemCode, the package's name, qty and price,
//                      PackageDocKey = Package.DocKey, no TaxType but its Tax;
//                      the only one of the set the document total counts
//   one line per ITEM  DtlType "P", ParentDtlKey = the package line's DtlKey,
//                      SubQty = how many per package, Qty = SubQty x the
//                      package qty, the package's own prices; these are the
//                      lines that move stock. Seq 16, 32... of their own,
//                      their tax adding up to the package line's.
//
// Which lines are packages is carried on the line (is_package), never guessed
// from the code: SZEN 140082002 is a package AND an ordinary item.
async function packagesFor(codes) {
  const out = {};
  for (const code of codes) {
    const p = await query(
      "SELECT TOP 1 DocKey, PackageCode, Description, UserUOM FROM Package WHERE PackageCode = @c AND IsActive = 'T'",
      { c: code });
    if (!p.length) continue;
    const items = await query(
      `SELECT Seq, ItemCode, Description, UOM, Qty, UnitPrice FROM PackageDTL
        WHERE DocKey = @k AND ItemCode IS NOT NULL AND ItemCode <> '' ORDER BY Seq`,
      { k: p[0].DocKey });
    if (items.length) out[code] = { ...p[0], items };
  }
  return out;
}

// The lines of one package: the package line, then its items. Their prices are
// the package's own; if the slip's price for the package differs from the sum
// of them, they are scaled to it and the last item takes the odd cent, so the
// items always add up to the package line exactly - as AutoCount's do.
function packageRows(l, pkg, seq, date, desc2) {
  const qty = Number(l.quantity) || 0;
  const price = money(l.unit_price);
  const sub = money(qty * price);
  const tax = gstOn(sub, SR9.rate);

  const base = money(pkg.items.reduce((t, i) => t + money((Number(i.Qty) || 0) * money(i.UnitPrice)), 0));
  const scale = base > 0 && base !== price ? price / base : 1;
  const kids = pkg.items.map((i) => {
    const per = Number(i.Qty) || 0;
    const kq = per * qty;
    const kp = money(money(i.UnitPrice) * scale);
    return { i, per, kq, kp, sub: money(kq * kp) };
  });
  const last = kids[kids.length - 1];
  const off = money(sub - kids.reduce((t, k) => t + k.sub, 0));
  if (off !== 0) {
    last.sub = money(last.sub + off);
    last.kp = last.kq > 0 ? money(last.sub / last.kq) : last.kp;
  }
  kids.forEach((k) => { k.tax = gstOn(k.sub, SR9.rate); });
  const taxOff = money(tax - kids.reduce((t, k) => t + k.tax, 0));
  if (taxOff !== 0) last.tax = money(last.tax + taxOff);

  const parent = {
    Seq: seq, MainItem: "T", Location: LOCATION,
    Description: clean(l.description || pkg.Description, 200),
    ...(pkg.UserUOM ? { UserUOM: pkg.UserUOM } : {}),
    Qty: qty, Rate: 1, SmallestQty: qty,
    UnitPrice: price, SmallestUnitPrice: price,
    SubTotal: sub, LocalSubTotal: sub, SubTotalExTax: sub, LocalSubTotalExTax: sub,
    Tax: tax, LocalTax: tax, TaxCurrencyTax: tax,
    TaxableAmt: sub, LocalTaxableAmt: sub, TaxCurrencyTaxableAmt: sub,
    Transferable: "T", PrintOut: "T", DtlType: "N", AddToSubTotal: "T",
    PackageDocKey: pkg.DocKey,
    StockReceived: "F", TransferedQty: 0,
    DeliveryDate: date, Guid: guid(),
  };
  const children = kids.map((k, n) => ({
    Seq: (n + 1) * SEQ_STEP, MainItem: "T",
    ItemCode: k.i.ItemCode, Location: LOCATION,
    Description: clean(k.i.Description || k.i.ItemCode, 200),
    Desc2: desc2[k.i.ItemCode] || "",
    UOM: k.i.UOM || "UNIT", UserUOM: k.i.UOM || "UNIT",
    Qty: k.kq, Rate: 1, SmallestQty: k.kq, SubQty: k.per,
    UnitPrice: k.kp, SmallestUnitPrice: k.kp,
    SubTotal: k.sub, LocalSubTotal: k.sub, SubTotalExTax: k.sub, LocalSubTotalExTax: k.sub,
    TaxType: SR9.code, TaxRate: SR9.rate,
    Tax: k.tax, LocalTax: k.tax, TaxCurrencyTax: k.tax,
    TaxableAmt: k.sub, LocalTaxableAmt: k.sub, TaxCurrencyTaxableAmt: k.sub,
    PrintOut: "T", DtlType: "P", AddToSubTotal: "T",
    StockReceived: "F", TransferedQty: 0,
    Guid: guid(),
  }));
  return { parent, children, sub, tax };
}

// The rows as they are inserted: DtlKeys in order from the DocKey, and each
// package item pointed at its package line's key.
function keyedRows(details, docKey) {
  return details.map((d, i) => {
    const { _parent, ...row } = d;
    return {
      DtlKey: docKey + i + 1, DocKey: docKey, ...row,
      ...(_parent !== undefined ? { ParentDtlKey: docKey + _parent + 1 } : {}),
    };
  });
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
  //
  // The opener is one of AutoCount's A-series service items, and WHICH one
  // depends on the machine - A1 for landscaping equipment, A2 for a fogger.
  // So the test is the shape of the code, not one particular code.
  const hasOpener = lines.some((l) => /^A\d+\s+SVR\b/i.test(String(l.item_code || "")));
  const hasHeading = lines.some((l) => !l.item_code && /S\/S:/.test(String(l.description || "")));
  if (!hasOpener || !hasHeading) {
    const e = new Error(
      "This order predates the AutoCount block format - it has no " +
      (hasOpener ? "" : "A1/A2 SVR opening line") +
      (!hasOpener && !hasHeading ? " and no " : "") +
      (hasHeading ? "" : "machine heading") +
      ". Convert the slip again to produce a current order."
    );
    e.status = 400; throw e;
  }

  const pkgCodes = [...new Set(lines.filter((l) => Number(l.is_package) && l.item_code).map((l) => l.item_code))];
  const packages = await packagesFor(pkgCodes);
  const gone = pkgCodes.filter((c) => !packages[c]);
  if (gone.length) {
    const e = new Error(`Item package ${gone.join(", ")} is not in AutoCount, or is no longer active.`);
    e.status = 400; throw e;
  }
  const codes = [...new Set([
    ...lines.filter((l) => l.item_code && !Number(l.is_package)).map((l) => l.item_code),
    ...Object.values(packages).flatMap((p) => p.items.map((i) => i.ItemCode)),
  ])];
  const desc2 = await desc2For(codes);

  // The date has to come first: the document number is derived from it.
  const today = new Date();
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const docNo = await nextDocNo(date);

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

    if (Number(l.is_package)) {
      const r = packageRows(l, packages[l.item_code], seq, date, desc2);
      const at = details.length;
      details.push(r.parent);
      for (const c of r.children) details.push({ ...c, _parent: at });
      totalExTax = money(totalExTax + r.sub);
      totalTax = money(totalTax + r.tax);
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
    // Never a package's item line: those are not counted in the total. A
    // package line may take it, and then its last item does too, so the items
    // still add up to it.
    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i];
      if ((d.ItemCode || d.PackageDocKey) && d.DtlType !== "P" && d.Tax !== undefined) {
        d.Tax = money(d.Tax + drift);
        d.LocalTax = d.Tax;
        d.TaxCurrencyTax = d.Tax;
        if (d.PackageDocKey) {
          const kid = details.filter((x) => x._parent === i).pop();
          if (kid) {
            kid.Tax = money(kid.Tax + drift);
            kid.LocalTax = kid.Tax;
            kid.TaxCurrencyTax = kid.Tax;
          }
        }
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
    if (d.DtlType === "P") continue;    // inside its package line's figure already
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
      details: keyedRows(built.details, docKey),
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

      for (const row of keyedRows(built.details, docKey)) {
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

module.exports = { createSalesOrder, buildRows, nextKey, nextDocNo, writebackEnabled, keyedRows };
