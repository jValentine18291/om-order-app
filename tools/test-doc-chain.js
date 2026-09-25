// Following a Sales Order through to its Delivery Order and Invoice.
//
//   node tools/test-doc-chain.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// John asked (24 Sep 2026) whether the app can notice by itself that an SO has
// become DO-2609-229 and record it, instead of somebody typing the number in.
// Reading AutoCount said yes - and said something more useful besides.
//
// AN INVOICE ALMOST NEVER POINTS AT THE SALES ORDER. It points at the DELIVERY
// ORDER. Measured on OM's own database: 169,314 invoice lines came from a DO
// and 46 came straight from an SO. So the app has to follow a chain -
// SO -> DO -> INV - and a one-step lookup would find delivery orders and
// silently miss nearly every invoice, which is the document that matters most.
//
// WHAT IS CHECKED, worst consequence first
//  1. An edit is never undone. The automatic half only ever fills a BLANK, so
//     a number Sales corrected stays corrected however many times the slip is
//     opened. "Automatic" and "editable" only hold together if the automatic
//     half knows when to stop.
//  2. The chain is followed to the end, so invoices are found at all.
//  3. A slip does not CLOSE on a billing document. That waits for somebody to
//     press "Collected & Closed" when the machine has actually gone back.
//  4. It can be run for ever without churning: the second run changes nothing.
//
// The AutoCount query itself cannot be tested here - SQL Server is not
// reachable from a workstation - so chainFrom() takes its step function as an
// argument and is driven below by a stub standing in for OM's real documents.
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
const ac = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// OM's documents, as the real ones behave: the invoice hangs off the delivery
// order, not off the sales order.
const WORLD = {
  "SO-2609-048": [{ kind: "DO", doc_no: "DO-2609-229", doc_date: "2026-09-24", from_doc_no: "SO-2609-048", from_type: "SO" }],
  "DO-2609-229": [{ kind: "INV", doc_no: "INV-2609-0140", doc_date: "2026-09-26", from_doc_no: "DO-2609-229", from_type: "DO" }],
  // A second order that went straight to a cash sale, which does happen.
  "SO-2609-050": [{ kind: "CS", doc_no: "CS-2609-0149", doc_date: "2026-09-24", from_doc_no: "SO-2609-050", from_type: "SO" }],
};
let asked = [];
async function stub(docNos) {
  asked.push([...docNos]);
  const out = [];
  for (const n of docNos) for (const d of WORLD[n] || []) out.push(d);
  return out;
}

(async () => {
  console.log("-- rule 2: the chain is followed to the end --");
  asked = [];
  let chain = await ac.chainFrom(["SO-2609-048"], stub);
  check("both documents found, not just the first",
    chain.map((d) => [d.kind, d.doc_no, d.depth]),
    [["DO", "DO-2609-229", 1], ["INV", "INV-2609-0140", 2]]);
  check("the invoice was reached by asking about the DELIVERY ORDER",
    asked.slice(0, 2), [["SO-2609-048"], ["DO-2609-229"]]);
  // A third round asks about the invoice and learns there is nothing after it,
  // which is how it knows to stop. It cannot know an invoice is the end
  // without asking - an invoice can itself be credited.
  check("then asks once more and finds nothing, which is how it stops",
    [asked[2], asked.length], [["INV-2609-0140"], 3]);

  console.log("\n-- a document that pointed back at its own source cannot loop --");
  const LOOPY = { A: [{ kind: "DO", doc_no: "B", from_doc_no: "A" }], B: [{ kind: "INV", doc_no: "A", from_doc_no: "B" }] };
  const looped = await ac.chainFrom(["A"], async (ns) => ns.flatMap((n) => LOOPY[n] || []));
  check("it comes back rather than going round", looped.map((d) => d.doc_no), ["B"]);
  check("nothing at all is a fine answer too", await ac.chainFrom([], stub), []);

  // A slip with one order, converted the way OM converts them.
  const slip = await data.slips.createSlip({
    company: "ATL MAINTENANCE PTE LTD", contact_name: "Mr Tariqul", contact_number: "97293454",
    machines: [{ desc: "EBZ5100 Backpack Blower", serial: "B1", remarks: "service" }],
    signature: sig,
  });
  const no = slip.slip_number;
  await data.slips.setMachineLabour(slip.machines[0].id, 50);
  const so = await data.slips.createSlipOrder(no, [slip.machines[0].id]);
  const orders = await data.slips.getSlipOrders(no);
  const orderId = orders[0].id;

  console.log("\n-- what the app writes down --");
  chain = await ac.chainFrom(["SO-2609-048"], stub);
  check("two documents recorded", data.slips.recordOrderDocuments(orderId, chain), 2);
  check("in the order they were reached",
    data.slips.orderDocuments(orderId).map((d) => [d.doc_type, d.doc_no, d.from_doc_no]),
    [["DO", "DO-2609-229", "SO-2609-048"], ["INV", "INV-2609-0140", "DO-2609-229"]]);

  console.log("\n-- a document's date --");
  // The driver hands back a Date, and slicing ten characters off its String()
  // gives "Fri Sep 18" with no year. That shipped, and was caught on the first
  // live call, 25 Sep 2026.
  check("a driver Date becomes a real date", ac.docDate(new Date(2026, 8, 18)), "2026-09-18");
  // Built from LOCAL parts, not toISOString(): AutoCount dates documents at
  // midnight Singapore time, which in UTC is the previous afternoon, so a
  // delivery order would come back dated the day before it was raised.
  check("and not the day before, which UTC would have given",
    [ac.docDate(new Date(2026, 8, 18)), new Date(2026, 8, 18).toISOString().slice(0, 10)],
    ["2026-09-18", "2026-09-17"]);
  check("a string is left alone", ac.docDate("2026-09-18 00:00:00"), "2026-09-18");
  check("and nothing is nothing", [ac.docDate(null), ac.docDate("")], ["", ""]);

  console.log("\n-- a date written down wrong does not stay wrong --");
  // INSERT OR IGNORE would have kept the bad one for ever, so a document
  // already known has its date corrected on the next sync.
  data.slips.recordOrderDocuments(orderId, [
    { kind: "DO", doc_no: "DO-2609-229", doc_date: "Fri Sep 24", from_doc_no: "SO-2609-048", depth: 1 }]);
  check("the wrong one is what got stored",
    data.slips.orderDocuments(orderId).find((d) => d.doc_no === "DO-2609-229").doc_date, "Fri Sep 24");
  data.slips.recordOrderDocuments(orderId, [
    { kind: "DO", doc_no: "DO-2609-229", doc_date: "2026-09-24", from_doc_no: "SO-2609-048", depth: 1 }]);
  check("and the next sync put it right",
    data.slips.orderDocuments(orderId).find((d) => d.doc_no === "DO-2609-229").doc_date, "2026-09-24");

  console.log("\n-- rule 4: running it again changes nothing --");
  check("nothing added the second time", data.slips.recordOrderDocuments(orderId, chain), 0);
  check("and still two documents", data.slips.orderDocuments(orderId).length, 2);

  console.log("\n-- which of them is the billing document --");
  // The invoice, where there is one: it is what the customer pays against and
  // what Sales would have typed in by hand.
  check("the invoice wins over the delivery order",
    data.slips.billingDocument(data.slips.orderDocuments(orderId)).doc_no, "INV-2609-0140");
  check("a delivery order stands in when it is all there is",
    data.slips.billingDocument([{ doc_type: "DO", doc_no: "DO-2609-229" }]).doc_no, "DO-2609-229");
  check("a cash sale counts too",
    data.slips.billingDocument([{ doc_type: "CS", doc_no: "CS-2609-0149" }]).doc_no, "CS-2609-0149");
  check("and nothing billable is nothing", data.slips.billingDocument([]), null);

  console.log("\n-- the slip moves to Invoice Created by itself --");
  const before = (await data.slips.getSlip(no)).status;
  const r1 = data.slips.autoInvoiceFromDocuments(no, "AutoCount");
  check("it says what it filled in", r1.filled.map((f) => [f.doc_type, f.doc_no]),
    [["INV", "INV-2609-0140"]]);
  let now = await data.slips.getSlip(no);
  check(`the slip moved from ${before}`, now.status, "INVOICED");
  check("and carries the invoice number", now.closing_ref, "INV-2609-0140");
  check("recorded as the app's doing, not a person's", now.invoiced_by, "AutoCount");

  console.log("\n-- rule 3: it has NOT closed --");
  // Billing is not collection. The machine is still in the workshop until
  // somebody says otherwise.
  check("the slip is still open for collection", now.status !== "CLOSED", true);

  console.log("\n-- rule 1: a correction is never undone --");
  // Sales notice the number is wrong and fix it. Every later sync must leave
  // that alone - an edit that reverts the next time the slip is opened is not
  // an edit.
  await data.slips.setSlipInvoiced(no, "INV-2609-0141", "CY", so.so_number);
  check("their number is stored", (await data.slips.getSlip(no)).closing_ref, "INV-2609-0141");
  const r2 = data.slips.autoInvoiceFromDocuments(no, "AutoCount");
  check("the sync fills nothing, because nothing is blank", r2.filled, []);
  now = await data.slips.getSlip(no);
  check("their correction stands", now.closing_ref, "INV-2609-0141");
  check("and it is still their name against it", now.invoiced_by, "CY");
  // Even when AutoCount later reports another document.
  data.slips.recordOrderDocuments(orderId, [
    { kind: "INV", doc_no: "INV-2609-0199", doc_date: "2026-09-30", from_doc_no: "DO-2609-229", depth: 2 }]);
  data.slips.autoInvoiceFromDocuments(no, "AutoCount");
  check("a newer document does not overwrite it either",
    (await data.slips.getSlip(no)).closing_ref, "INV-2609-0141");

  console.log("\n-- a closed slip is never touched --");
  const db = require(path.resolve(__dirname, "..", "backend", "db"));
  db.prepare("UPDATE service_slips SET status = 'CLOSED' WHERE slip_number = ?").run(no);
  check("nothing is filled in on it", data.slips.autoInvoiceFromDocuments(no, "AutoCount").filled, []);
  check("and it stays closed", (await data.slips.getSlip(no)).status, "CLOSED");

  console.log("\n-- an order nobody has billed yet --");
  const fresh = await data.slips.createSlip({
    company: "NOTHING BILLED PTE LTD", contact_name: "Mr Goh", contact_number: "90001111",
    machines: [{ desc: "525LK Combi Trimmer", serial: "T1", remarks: "service" }], signature: sig,
  });
  await data.slips.setMachineLabour(fresh.machines[0].id, 20);
  await data.slips.createSlipOrder(fresh.slip_number, [fresh.machines[0].id]);
  check("stays where it was", data.slips.autoInvoiceFromDocuments(fresh.slip_number, "AutoCount").filled, []);
  check("and is not invoiced", (await data.slips.getSlip(fresh.slip_number)).status !== "INVOICED", true);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
