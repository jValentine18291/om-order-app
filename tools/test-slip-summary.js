// A SLIP AT A GLANCE - the long-press card in Close Service.
// Run against a throwaway database, never the real one:
//
//   node tools/test-slip-summary.js C:/temp/scratch.db
//
// John, 1 Oct 2026: company, who to call, every machine with its status and
// what its repair came to before GST, then Subtotal, GST 9% and Total, and
// whether each machine is with the customer or still here.
//
// Checked: a machine's figure is its parts at their quantities plus labour; a
// condemned machine is $0 whatever was priced on it; GST is the quotation's
// rule (9% of the rounded subtotal, rounded); collected shows as COLLECTED;
// a slip that does not exist is a 404, not a crash.
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

(async () => {
  const s = await data.slips.createSlip({
    company: "Summary Test Pte Ltd", contact_name: "Mr Tan", contact_number: "91234567",
    contact2_name: "Ms Lim", contact2_number: "98765432", signature: sig,
    machines: [
      { desc: "EBZ5100", serial: "S1" },
      { desc: "MS180", serial: "" },
      { desc: "HBZ260EZ", serial: "S3" },
    ],
  });
  const [a, b, c] = s.machines.map((m) => m.id);

  // A: two plugs at 4.35 and 25.50 labour = 34.20, repaired, billed, collected.
  await data.slips.addPartToMachine(a, { item_code: "WS7F", description: "Spark plug", unit_price: 4.35, quantity: 2, technician: "WJ" });
  await data.slips.setMachineLabour(a, 25.5);
  await data.slips.setMachineState(s.slip_number, a, "REPAIRED", "WJ");
  // B: priced, then condemned - $0.
  await data.slips.addPartToMachine(b, { item_code: "CARB", description: "Carburettor", unit_price: 88, quantity: 1, technician: "WJ" });
  await data.slips.setMachineState(s.slip_number, b, "CONDEMNED", "JT");
  // C: in progress, one part, no labour.
  await data.slips.addPartToMachine(c, { item_code: "FLT", description: "Air filter", unit_price: 7.1, quantity: 1, technician: "WJ" });
  await data.slips.setMachineState(s.slip_number, c, "TO_REPAIR", "JT");

  await data.slips.createSlipOrder(s.slip_number, [a, b], "KS");
  await data.slips.setMachineDisposal(s.slip_number, a, "COLLECTED", "CY");

  const sum = data.slips.slipSummary(s.slip_number);
  check("company", sum.company, "Summary Test Pte Ltd");
  check("both contacts", [sum.contact_name, sum.contact_number, sum.contact2_name, sum.contact2_number],
    ["Mr Tan", "91234567", "Ms Lim", "98765432"]);
  check("every machine, in slip order", sum.machines.map((m) => m.machine_desc), ["EBZ5100", "MS180", "HBZ260EZ"]);
  check("parts x quantity + labour", sum.machines[0].cost, 34.2);
  check("condemned is $0", sum.machines[1].cost, 0);
  check("in progress counts its parts so far", sum.machines[2].cost, 7.1);
  check("states", sum.machines.map((m) => m.state), ["REPAIRED", "CONDEMNED", "TO_REPAIR"]);
  check("collected or still here", sum.machines.map((m) => m.disposal), ["COLLECTED", "", ""]);
  check("subtotal", sum.subtotal, 41.3);
  check("GST 9% of the subtotal, rounded", sum.gst, 3.72);
  check("total", sum.total, 45.02);
  check("rate", sum.gst_rate, 0.09);

  let status = 0;
  try { data.slips.slipSummary("99999"); } catch (e) { status = e.status; }
  check("unknown slip is a 404", status, 404);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
