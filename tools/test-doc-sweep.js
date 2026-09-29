// WHICH SLIPS THE SERVER ASKS AUTOCOUNT ABOUT, WITHOUT BEING ASKED.
// Run against a throwaway database, never the real one:
//
//   node tools/test-doc-sweep.js C:/temp/scratch.db
//
// John, 29 Sep 2026: he transferred SO-2609-059 and SO-2609-062 to delivery
// orders and the app went on showing neither. The lookup was never broken - it
// found both the instant it was asked - but it was only ever asked when
// somebody opened that particular slip, and nobody had. Fourteen slips out of
// eighty-six were sitting in that state.
//
// slipsAwaitingDocuments() is what the timer walks. Everything the sweep does
// afterwards is the same code the screen already ran, so the question worth
// testing is which slips it picks up and, just as much, which it leaves alone:
// too wide and every sweep is a pile of pointless queries to SQL Server, too
// narrow and John is back to opening slips one at a time to find out.
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// A slip with one machine, worked on, on a Sales Order. Returns what the sweep
// would need to know about it.
async function slipOnOrder(company) {
  const slip = await data.slips.createSlip({
    company, contact_name: "A", contact_number: "1",
    machines: [{ desc: "ZENOAH HBZ260EZ Handheld Blower", serial: "Z1", remarks: "" }],
    signature: sig,
  });
  const id = slip.machines[0].id;
  await data.slips.setMachineLabour(id, 40);
  await data.slips.finishRepair(id, "KM");
  const order = await data.slips.createSlipOrder(slip.slip_number, [id], "KS");
  return { no: slip.slip_number, so: order.so_number };
}

(async () => {
  console.log("-- a Sales Order that reached AutoCount and has nothing back yet --");
  // John's two, in the state they were actually in.
  const a = await slipOnOrder("SPLENDOR HORTICULTURAL A");
  const b = await slipOnOrder("SPLENDOR HORTICULTURAL B");
  await data.slips.setOrderAutocountDocNo(a.so, "SO-2609-059");
  await data.slips.setOrderAutocountDocNo(b.so, "SO-2609-062");

  let waiting = await data.slips.slipsAwaitingDocuments(200);
  check("both are asked about", [waiting.includes(a.no), waiting.includes(b.no)], [true, true]);

  console.log("\n-- an order that never reached AutoCount is not asked about --");
  // Nothing to look up: there is no Sales Order number to start a chain from.
  const c = await slipOnOrder("NEVER SENT PTE LTD");
  waiting = await data.slips.slipsAwaitingDocuments(200);
  check("it is left out", waiting.includes(c.no), false);

  console.log("\n-- and once a document is recorded, it stops being asked about --");
  // autoInvoiceFromDocuments() will not replace a number that is already
  // there, so asking again would cost a query and change nothing.
  await data.slips.setSlipInvoiced(a.no, "DO-2609-258", "KS");
  waiting = await data.slips.slipsAwaitingDocuments(200);
  check("the one with a DO drops out", waiting.includes(a.no), false);
  check("the one still waiting stays", waiting.includes(b.no), true);

  console.log("\n-- a closed slip is a finished record --");
  // Whatever AutoCount does afterwards, nothing here should change.
  const d = await slipOnOrder("CLOSED ALREADY PTE LTD");
  await data.slips.setOrderAutocountDocNo(d.so, "SO-2609-100");
  check("waiting while it is open", (await data.slips.slipsAwaitingDocuments(200)).includes(d.no), true);
  await data.slips.setSlipInvoiced(d.no, "INV-2609-0140", "KS");
  await data.slips.closeSlip(d.no, "INV-2609-0140", "KS");
  check("and never once it is closed", (await data.slips.slipsAwaitingDocuments(200)).includes(d.no), false);

  console.log("\n-- the sweep is bounded --");
  // A limit that did nothing would be a limit nobody noticed was broken.
  check("the limit is honoured", (await data.slips.slipsAwaitingDocuments(1)).length, 1);

  console.log("\n-- and it reaches the facade --");
  // dataSource.js lists every method by hand, so one added to the repository
  // and not to the facade is missing at runtime and only at runtime.
  check("dataSource exposes it", typeof data.slips.slipsAwaitingDocuments, "function");

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
