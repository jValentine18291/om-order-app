// The listing and detail routes, with AutoCount stubbed.
//
//   node tools/test-po-progress-route.js C:/temp/scratch.db
//
// backend/poStatus.js is tested on its own; what this checks is the wiring
// around it - that the route feeds it real shipment allocations, that the
// derived status arrives on the field the screen reads, and that a PO whose
// lines cannot be read still comes back as a card rather than an error.
const path = require("path");
const Module = require("module");

const target = process.argv[2];
const live = path.resolve(__dirname, "..", "backend", "om_orders.db");
if (!target) {
  console.error("Give a scratch database path, e.g. node " + path.basename(__filename) + " C:/temp/scratch.db");
  process.exit(2);
}
if (path.resolve(target) === live) {
  console.error("Refusing to run against the live database: " + live);
  process.exit(2);
}
process.env.OM_DB_PATH = target;
process.env.ITEMS_SOURCE = "autocount";

// ---- AutoCount, stubbed -----------------------------------------------------
// The route reaches for ./data/autocountRepo by name, so it is intercepted
// here rather than the server being handed a different object: what is under
// test is the route as it is written, including which repo it asks.
const acPath = path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js");
const ORDERS = [
  { doc_no: "PO-A", date: "2026-08-01", supplier: "Husqvarna AB, Sweden", supplier_code: "HUSQ",
    lines: 3, ordered_qty: 18, outstanding_qty: 18 },
  { doc_no: "PO-B", date: "2026-08-04", supplier: "Zenoah / Komatsu", supplier_code: "ZEN",
    lines: 2, ordered_qty: 10, outstanding_qty: 4 },
  { doc_no: "PO-C", date: "2026-08-09", supplier: "Zenoah / Komatsu", supplier_code: "ZEN",
    lines: 1, ordered_qty: 5, outstanding_qty: 5 },
];
const LINES = {
  "PO-A": [{ seq: 1, qty: 2, outstanding: 2 }, { seq: 2, qty: 6, outstanding: 6 }, { seq: 3, qty: 10, outstanding: 10 }],
  "PO-B": [{ seq: 1, qty: 6, outstanding: 0 }, { seq: 2, qty: 4, outstanding: 4 }],
  "PO-C": [{ seq: 1, qty: 5, outstanding: 5 }],
};
let lineReadFails = false;
const stub = {
  listPurchaseOrders: async () => ORDERS.map((o) => ({ ...o })),
  listPurchaseOrderLines: async (docNos) => {
    if (lineReadFails) throw new Error("AutoCount went away");
    return docNos.flatMap((d) => (LINES[d] || []).map((l) => ({ ...l, doc_no: d })));
  },
  getPurchaseOrder: async (docNo) => {
    const o = ORDERS.find((x) => x.doc_no === docNo);
    if (!o) return { found: false };
    return {
      found: true, ...o, cancelled: false,
      items: LINES[docNo].map((l) => ({
        ...l, item_code: `ITEM-${l.seq}`, description: `Part ${l.seq}`, uom: "UNIT",
      })),
    };
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch (e) { return request; } })();
  if (resolved === acPath) return stub;
  return realLoad.apply(this, arguments);
};

const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));
const poStatus = require(path.resolve(__dirname, "..", "backend", "poStatus.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// ---- the app's own facts ----------------------------------------------------
// PO-A: line 1 fully on a shipment, line 2 partly, line 3 not at all.
data.shipments.create({
  invoice_no: "INV-1", status: "SHIPPED", destination: "EUNOS", eta_sg: "2026-09-24",
  lines: [
    { po_no: "PO-A", po_seq: 1, item_code: "ITEM-1", qty: 2, po_qty: 2 },
    { po_no: "PO-A", po_seq: 2, item_code: "ITEM-2", qty: 3, po_qty: 6 },
  ],
}, "I");
// PO-C is entirely on a shipment, and Iris has ticked it as sent.
data.shipments.create({
  invoice_no: "INV-2", status: "ARRIVED_SG", destination: "JOO_SENG",
  lines: [{ po_no: "PO-C", po_seq: 1, item_code: "ITEM-1", qty: 5, po_qty: 5 }],
}, "I");
data.purchaseOrders.setStatus("PO-C", "ORDERED", "I");

// ---- the listing ------------------------------------------------------------
// The route's own body, run here: requiring server.js would start a listener,
// open AutoCount and bind a port, none of which this is about.
//
// The six lines that turn facts into a status are NOT copied out of the route
// any more - poStatus.attach() is the function the route itself calls, so what
// is checked below is the real one rather than a transcription of it that
// would agree until somebody edited one of the two.
async function gather() {
  const acRepo = require(acPath);
  const orders = await acRepo.listPurchaseOrders({ scope: "open" });
  const docNos = orders.map((o) => o.doc_no);
  let lines = [];
  try { lines = (await acRepo.listPurchaseOrderLines(docNos)) || []; } catch (e) { lines = []; }
  return { orders, docNos, lines };
}

async function listing() {
  const { orders, docNos, lines } = await gather();
  return poStatus.attach(orders, {
    tracking: data.purchaseOrders.tracking(docNos),
    lines,
    allocated: data.shipments.allocatedByPo(docNos),
    delivered: data.shipments.receivedByPo(docNos),
  });
}

// What the "already on order" panel asks for. Same orders, same function -
// the point of the check is that a technician about to request more of a part
// is told the same thing the Purchase Orders screen would tell Iris.
async function onOrderPanel(docNo) {
  const { orders, docNos, lines } = await gather();
  const mine = orders.filter((o) => o.doc_no === docNo)
    .map((o) => ({ doc_no: o.doc_no, date: o.date, qty: o.outstanding_qty }));
  return poStatus.attach(mine, {
    tracking: data.purchaseOrders.tracking(docNos),
    lines,
    allocated: data.shipments.allocatedByPo(docNos),
    delivered: data.shipments.receivedByPo(docNos),
  })[0];
}

(async () => {
  console.log("\n-- the listing --");
  let list = await listing();
  const by = (no) => list.find((o) => o.doc_no === no);

  // PO-A: some lines on a container, one not. Nothing received.
  check("part of it is on a ship", by("PO-A").progress, "PART_SHIPPED");
  check("in words", by("PO-A").progress_label, "Partially shipped");
  check("and counted for the card",
    [by("PO-A").progress_counts.shipped, by("PO-A").progress_counts.part_shipped,
     by("PO-A").progress_counts.total], [1, 1, 3]);

  // PO-B: AutoCount says one line is fully received, the other is not. No
  // shipment records it at all - goods do turn up without one - and the status
  // still has to be right, because AutoCount is what says a thing has landed.
  check("half in, with no shipment ever recorded", by("PO-B").progress, "PART_RECEIVED");
  check("counted", [by("PO-B").progress_counts.received, by("PO-B").progress_counts.total], [1, 2]);

  // PO-C: the whole order on one shipment.
  check("all of it is on a ship", by("PO-C").progress, "SHIPPED");

  console.log("\n-- Iris's tick and the progress are different fields --");
  // The PATCH route writes `status`; nothing writes `progress`. Collapsing the
  // two would mean a screen that lets somebody set "Received" by hand.
  check("her tick, untouched", [by("PO-A").status, by("PO-C").status], ["NOT_ORDERED", "ORDERED"]);
  check("progress is its own answer", by("PO-A").progress !== by("PO-A").status, true);

  console.log("\n-- a shipment that never sailed does not move anything --");
  const s = data.shipments.list({ scope: "all" }).find((x) => x.invoice_no === "INV-2");
  data.shipments.update(s.id, { status: "CANCELLED" }, "I");
  list = await listing();
  check("PO-C falls back to Iris's tick", by2(list, "PO-C").progress, "ORDERED");
  data.shipments.update(s.id, { status: "SHIPPED" }, "I");

  console.log("\n-- signed for on the door, AutoCount not yet keyed --");
  // The gap that matters in practice. Iris marks INV-1 received the day the
  // container reaches Eunos; the stock goes into AutoCount later. In between,
  // the shipment has left the in-transit figure and AutoCount still shows
  // everything outstanding - so without her signature counting for something,
  // an order with goods on the floor would read "Not ordered yet".
  const s1 = data.shipments.list({ scope: "all" }).find((x) => x.invoice_no === "INV-1");
  data.shipments.update(s1.id, { status: "RECEIVED" }, "I");
  list = await listing();
  check("the goods on the floor are counted", by2(list, "PO-A").progress, "PART_RECEIVED");
  check("as far as they go, and no further",
    [by2(list, "PO-A").progress_counts.received, by2(list, "PO-A").progress_counts.total], [1, 3]);
  data.shipments.update(s1.id, { status: "SHIPPED" }, "I");
  check("and putting it back puts the status back",
    by2(await listing(), "PO-A").progress, "PART_SHIPPED");

  console.log("\n-- AutoCount's lines cannot be read --");
  // The cards must still come back. A listing that loads with only Iris's tick
  // on it is worth more than an error page.
  lineReadFails = true;
  list = await listing();
  check("every order still listed", list.length, 3);
  check("falling back to the tick alone",
    list.map((o) => o.progress).sort(), ["NOT_ORDERED", "NOT_ORDERED", "ORDERED"]);
  lineReadFails = false;

  console.log("\n-- one order, line by line --");
  const acRepo = require(acPath);
  const po = await acRepo.getPurchaseOrder("PO-A");
  const t = data.purchaseOrders.status(po.doc_no);
  const alloc = data.shipments.allocatedByPo([po.doc_no]);
  const d = poStatus.derive({ docNo: po.doc_no, lines: po.items, allocated: alloc,
                              delivered: data.shipments.receivedByPo([po.doc_no]), tracked: t.status });
  check("a chip for each line", d.lines.map((l) => l.status),
    ["SHIPPED", "PART_SHIPPED", "NOT_ORDERED"]);
  check("agreeing with the one at the top of the screen", d.status, by2(await listing(), "PO-A").progress);
  // The line chips and the quantities beside them come from the same
  // allocation, so they cannot tell two different stories.
  check("and with the figures shown beside them",
    po.items.map((it) => alloc.get(`PO-A#${it.seq}`) || 0), [2, 3, 0]);

  console.log("\n-- and the panel a technician sees before ordering more --");
  // The panel used to show only "PO-C - 5", which reads the same whether the
  // order was raised this morning and forgotten or is sitting on a container
  // that docks on Tuesday. Those are the difference between waiting and
  // chasing, so it says which.
  let panel = await onOrderPanel("PO-C");
  check("the order the part is on", panel.doc_no, "PO-C");
  check("carries where it has got to", panel.progress, "SHIPPED");
  check("in the same words the Purchase Orders screen uses", panel.progress_label, "Shipped");
  check("and Iris's own tick alongside it", panel.status, "ORDERED");

  panel = await onOrderPanel("PO-A");
  check("a part-shipped order says so", panel.progress, "PART_SHIPPED");
  // Nothing the panel already had is disturbed by any of it.
  check("the quantity is untouched", panel.qty, 18);
  check("so is the date", panel.date, "2026-08-01");

  // The failure that matters: AutoCount answers for the order but not for its
  // lines. The panel must still say something true - Iris's tick - rather than
  // claiming an order is shipped because nothing came back to say otherwise.
  lineReadFails = true;
  panel = await onOrderPanel("PO-C");
  check("with no lines readable, it falls back to the tick", panel.progress, "ORDERED");
  panel = await onOrderPanel("PO-A");
  check("and an unticked order reads as not ordered", panel.progress, "NOT_ORDERED");
  lineReadFails = false;

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function by2(list, no) { return list.find((o) => o.doc_no === no); }
