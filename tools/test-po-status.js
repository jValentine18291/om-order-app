// Where a purchase order has got to, worked out rather than typed in.
//
//   node tools/test-po-status.js
//
// The rules are easy to state and easy to get subtly wrong, and getting them
// wrong is expensive: a PO reading "Received" when half of it is still at sea
// is worse than no status at all, because somebody stops chasing it.
const po = require(require("path").resolve(__dirname, "..", "backend", "poStatus.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// qty ordered, outstanding still owed, how much is on a ship
const L = (qty, outstanding) => ({ qty, outstanding });
// lineStatus(line, onShipsInTransit, irisTick, signedForOnDelivery)

console.log("\n-- one line at a time --");
check("nothing done to it yet", po.lineStatus(L(10, 10), 0, "NOT_ORDERED"), "NOT_ORDERED");
check("Iris has emailed the PO", po.lineStatus(L(10, 10), 0, "ORDERED"), "ORDERED");
check("some of it is on a container", po.lineStatus(L(10, 10), 4, "ORDERED"), "PART_SHIPPED");
check("all of it is", po.lineStatus(L(10, 10), 10, "ORDERED"), "SHIPPED");
check("some of it has landed", po.lineStatus(L(10, 4), 4, "ORDERED"), "PART_RECEIVED");
check("all of it has", po.lineStatus(L(10, 0), 0, "ORDERED"), "RECEIVED");

console.log("\n-- the awkward ones --");
// Received beats everything: AutoCount says the goods are in the building.
check("received, even if nobody ever ticked the PO",
  po.lineStatus(L(10, 0), 0, "NOT_ORDERED"), "RECEIVED");
// A supplier who sends more than was ordered has still sent the lot.
check("over-shipped is still shipped", po.lineStatus(L(10, 10), 12, "ORDERED"), "SHIPPED");
// A shipment marked received drops out of `allocated` AND AutoCount's
// outstanding falls, so both halves agree: nothing left, all in.
check("received shipment, outstanding gone", po.lineStatus(L(10, 0), 0, "ORDERED"), "RECEIVED");
// Half received, and the other half is on the water. What has LANDED is the
// question being asked, so that is the half that names it.
check("half in, half still at sea", po.lineStatus(L(10, 5), 5, "ORDERED"), "PART_RECEIVED");
// Zero allocated must not read as "shipped" through a >= comparison.
check("nothing owed, nothing shipped, is not Shipped",
  po.lineStatus(L(0, 0), 0, "ORDERED"), "RECEIVED");

console.log("\n-- signed for, but not yet keyed into AutoCount --");
// Iris marks a container received the day it reaches the workshop; the stock
// goes into AutoCount afterwards. In that window AutoCount still shows the
// whole line outstanding, and the shipment has left the in-transit figure. Her
// signature is what says the goods are on the floor.
check("she has signed for all of it", po.lineStatus(L(10, 10), 0, "ORDERED", 10), "RECEIVED");
check("and for some of it", po.lineStatus(L(10, 10), 0, "ORDERED", 4), "PART_RECEIVED");
check("the rest of it still at sea",
  po.lineStatus(L(10, 10), 6, "ORDERED", 4), "PART_RECEIVED");
// The two sources usually describe the SAME goods, so the larger is taken and
// never the sum. 6 keyed in and a container of 4 signed for is at least 6 in -
// saying 10 would mark the line complete while the supplier still owes 4.
check("AutoCount and Iris are not added together",
  po.lineStatus(L(10, 4), 0, "ORDERED", 4), "PART_RECEIVED");
check("nor when that would tip it over the whole quantity",
  po.lineStatus(L(10, 2), 0, "ORDERED", 8), "PART_RECEIVED");
// AutoCount catching up must not then read as MORE than was ordered.
check("once AutoCount agrees, it is simply received",
  po.lineStatus(L(10, 0), 0, "ORDERED", 10), "RECEIVED");

console.log("\n-- rolling the lines up --");
check("all in", po.rollUp(["RECEIVED", "RECEIVED"], "ORDERED"), "RECEIVED");
check("one line still to come", po.rollUp(["RECEIVED", "SHIPPED"], "ORDERED"), "PART_RECEIVED");
check("everything on the water", po.rollUp(["SHIPPED", "SHIPPED"], "ORDERED"), "SHIPPED");
check("one line not on it", po.rollUp(["SHIPPED", "ORDERED"], "ORDERED"), "PART_SHIPPED");
check("nothing has moved", po.rollUp(["ORDERED", "ORDERED"], "ORDERED"), "ORDERED");
check("not even sent", po.rollUp(["NOT_ORDERED", "NOT_ORDERED"], "NOT_ORDERED"), "NOT_ORDERED");
// A PO is only as far along as its least finished line. This is the one that
// matters: "Received" on an order still owing goods stops people chasing it.
check("one unreceived line keeps the whole order off Received",
  po.rollUp(["RECEIVED", "RECEIVED", "RECEIVED", "NOT_ORDERED"], "ORDERED"), "PART_RECEIVED");
check("an order with no lines falls back to the tick",
  po.rollUp([], "ORDERED"), "ORDERED");

console.log("\n-- John's own shipment, as a purchase order --");
// PO-2609-016: joint 1 of 2 shipped, hose all 3 shipped, reel 8 of 10 shipped,
// and a fourth line nobody has touched.
const d = po.derive({
  docNo: "PO-2609-016",
  lines: [
    { seq: 1, qty: 2, outstanding: 2 },
    { seq: 2, qty: 3, outstanding: 3 },
    { seq: 3, qty: 10, outstanding: 10 },
    { seq: 4, qty: 5, outstanding: 5 },
  ],
  allocated: new Map([
    ["PO-2609-016#1", 1],
    ["PO-2609-016#2", 3],
    ["PO-2609-016#3", 8],
  ]),
  tracked: "ORDERED",
});
check("line by line", d.lines.map((l) => l.status),
  ["PART_SHIPPED", "SHIPPED", "PART_SHIPPED", "ORDERED"]);
check("and the order as a whole", d.status, "PART_SHIPPED");
check("with words on it", d.label, "Partially shipped");
check("counted for the screen", [d.counts.total, d.counts.shipped, d.counts.part_shipped], [4, 1, 2]);

console.log("\n-- the allocation map is keyed on the LINE --");
// The same part on two lines of one PO. Keying on the item code would put all
// six against whichever line was read first and call the other one unshipped.
const two = po.derive({
  docNo: "PO-0999",
  lines: [{ seq: 1, qty: 4, outstanding: 4 }, { seq: 2, qty: 6, outstanding: 6 }],
  allocated: { "PO-0999#1": 4, "PO-0999#2": 6 },
  tracked: "ORDERED",
});
check("both lines shipped, separately", two.lines.map((l) => l.status), ["SHIPPED", "SHIPPED"]);
check("so the order is shipped", two.status, "SHIPPED");
// A plain object works as well as a Map, because the route has one of each.
check("an allocation it has never heard of counts as none",
  po.derive({ docNo: "PO-X", lines: [{ seq: 1, qty: 1, outstanding: 1 }],
              allocated: null, tracked: "ORDERED" }).status, "ORDERED");
// A line with no sequence at all still gets looked up under the same key the
// shipments repo writes.
check("a line with no sequence",
  po.derive({ docNo: "PO-Y", lines: [{ seq: null, qty: 2, outstanding: 2 }],
              allocated: { "PO-Y#": 2 }, tracked: "ORDERED" }).status, "SHIPPED");

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
