// Shipments: the thing that travels and has a date.
//
//   node tools/test-shipments.js C:/temp/scratch.db
//
// Goods do not arrive by purchase order - one shipment carries parts of
// several POs, and one PO arrives across several shipments - so what is
// checked here is that a PO line can be split across shipments and still add
// up, and that the allocation figures do not double-count.
const path = require("path");
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
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));
const sh = data.shipments;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const line = (po, seq, code, qty, desc = "") =>
  ({ po_no: po, po_seq: seq, item_code: code, description: desc, uom: "UNIT", qty });

console.log("\n-- one shipment, two purchase orders --");
// The case that made shipments necessary in the first place.
let s1 = sh.create({
  invoice_no: "INV-88377", bl_no: "ONEY2210447", container_no: "TCNU9930118",
  status: "SHIPPED", destination: "EUNOS", eta_sg: "2026-09-11", eta_dest: "2026-09-15",
  lines: [line("PO-0418", 1, "SZEN 848BE058B2", 40, "GASKET"),
          line("PO-0418", 2, "SZEN 848CE037A0", 12, "CLUTCH DRUM"),
          line("PO-0421", 1, "SPUL KACC Z00126.03", 4, "TUBE PVC ROLL")],
}, "I");
check("it has an id of its own", typeof s1.id, "number");
check("known by the invoice number", s1.invoice_no, "INV-88377");
check("three lines", s1.lines.length, 3);
check("across two POs", [...new Set(s1.lines.map((l) => l.po_no))], ["PO-0418", "PO-0421"]);
check("one destination", s1.destination, "EUNOS");

console.log("\n-- a PO line split across two shipments --");
// PO-0421 line 1 is six rolls: four on the first shipment, two on the next.
let s2 = sh.create({
  invoice_no: "INV-88420", status: "SHIPPED", destination: "JOO_SENG", eta_sg: "2026-10-02",
  lines: [line("PO-0421", 1, "SPUL KACC Z00126.03", 2, "TUBE PVC ROLL")],
}, "I");
let alloc = sh.allocatedByPo(["PO-0421"]);
check("both halves counted against the one PO line", alloc.get("PO-0421#1"), 6);
check("and the other PO's lines are separate",
  [sh.allocatedByPo(["PO-0418"]).get("PO-0418#1"), sh.allocatedByPo(["PO-0418"]).get("PO-0418#2")], [40, 12]);

console.log("\n-- the same item twice on one PO --");
// A part ordered on two lines at two prices is a real thing, and the item code
// alone cannot say which line a shipment is carrying.
sh.create({
  invoice_no: "INV-88500", status: "SHIPPED", destination: "EUNOS",
  lines: [line("PO-0999", 1, "SZEN 848BE058B2", 10), line("PO-0999", 2, "SZEN 848BE058B2", 25)],
}, "I");
alloc = sh.allocatedByPo(["PO-0999"]);
check("kept apart by AutoCount's line sequence",
  [alloc.get("PO-0999#1"), alloc.get("PO-0999#2")], [10, 25]);

console.log("\n-- which shipments a PO is on --");
// Asked here, before the line-replacement test below takes PO-0421 off the
// first shipment - which it correctly does.
check("both of them, newest first",
  sh.forPo("PO-0421").map((x) => x.invoice_no), ["INV-88420", "INV-88377"]);

console.log("\n-- received stops counting against the PO --");
// Once goods are in, AutoCount's own outstanding drops to match. Counting them
// here as well would subtract them twice.
sh.update(s2.id, { status: "RECEIVED" }, "I");
check("only what is still travelling", sh.allocatedByPo(["PO-0421"]).get("PO-0421#1"), 4);
// And a cancelled shipment never carried anything.
sh.update(s1.id, { status: "CANCELLED" }, "I");
check("a cancelled one counts for nothing", sh.allocatedByPo(["PO-0418"]).get("PO-0418#1"), undefined);
sh.update(s1.id, { status: "SHIPPED" }, "I");

console.log("\n-- an update that is only a status must not empty it --");
// A phone running yesterday's copy of the app sends no lines at all.
const before = sh.get(s1.id).lines.length;
const after = sh.update(s1.id, { status: "ARRIVED_SG" }, "I");
check("lines untouched", after.lines.length, before);
check("status moved", after.status, "ARRIVED_SG");
check("and it says who", after.updated_by, "I");

console.log("\n-- sending lines DOES replace them --");
const replaced = sh.update(s1.id, {
  lines: [line("PO-0418", 1, "SZEN 848BE058B2", 40, "GASKET")],
}, "KS");
check("now one line", replaced.lines.length, 1);
check("the dropped line is no longer allocated", sh.allocatedByPo(["PO-0418"]).get("PO-0418#2"), undefined);

console.log("\n-- the list --");
// Soonest first, and a shipment with no ETA has been promised nothing so it
// waits at the bottom rather than jumping the queue.
sh.create({ invoice_no: "INV-NOETA", status: "SHIPPED", destination: "EUNOS",
            lines: [line("PO-0500", 1, "X", 1)] }, "I");
const live2 = sh.list({ scope: "live" });
check("received and cancelled are not on it",
  live2.every((x) => x.status === "SHIPPED" || x.status === "ARRIVED_SG"), true);
// The property, rather than naming a row: several shipments can be waiting on
// a date, and which of those happens to be last is not the point.
const firstNoEta = live2.findIndex((x) => !x.eta_sg);
check("everything with a date comes before everything without",
  firstNoEta === -1 || live2.slice(firstNoEta).every((x) => !x.eta_sg), true);
check("and the soonest is at the top", live2[0].eta_sg, "2026-09-11");
check("all shows everything", sh.list({ scope: "all" }).length >= live2.length + 1, true);
check("and each carries its counts", typeof live2[0].lines, "number");

console.log("\n-- what it refuses --");
const refuse = (what, fn, re) => {
  let err = "";
  try { fn(); } catch (e) { err = e.message; }
  check(what, re.test(err), true);
};
refuse("a shipment with no invoice number",
  () => sh.create({ status: "SHIPPED", lines: [line("PO-1", 1, "X", 1)] }, "I"), /invoice number/);
refuse("a shipment with nothing on it",
  () => sh.create({ invoice_no: "INV-X", lines: [] }, "I"), /at least one line/);
refuse("a status that is not one of ours",
  () => sh.create({ invoice_no: "INV-X", status: "IN ORBIT", lines: [line("PO-1", 1, "X", 1)] }, "I"),
  /Invalid shipment status/);
refuse("a destination that is neither",
  () => sh.create({ invoice_no: "INV-X", destination: "MARS", lines: [line("PO-1", 1, "X", 1)] }, "I"),
  /Joo Seng or Eunos/);
refuse("a date nothing could sort by",
  () => sh.create({ invoice_no: "INV-X", eta_sg: "next Tuesday", lines: [line("PO-1", 1, "X", 1)] }, "I"),
  /must be a date/);
refuse("a change nobody signed",
  () => sh.create({ invoice_no: "INV-X", lines: [line("PO-1", 1, "X", 1)] }, "  "), /Missing initials/);

console.log("\n-- a line with no quantity is not on the shipment --");
// The picker's way of saying "not this one", rather than a zero to store.
const picked = sh.create({
  invoice_no: "INV-ZERO", status: "SHIPPED", destination: "EUNOS",
  lines: [line("PO-1", 1, "A", 5), line("PO-1", 2, "B", 0), line("PO-1", 3, "C", 3)],
}, "I");
check("only the ones with a quantity", picked.lines.map((l) => l.item_code), ["A", "C"]);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
