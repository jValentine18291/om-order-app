// CLOSING A SLIP WITH NO INVOICE. Run against a throwaway database:
//
//   node tools/test-close-without-invoice.js C:/temp/scratch.db
//
// John, 27 Oct 2026: sometimes a machine is checked, nothing is wrong, and it
// goes back to the customer with no charge - no Sales Order, no invoice. His
// answers: any machine, sales decide at Close Service; a free-of-charge
// machine can still go on a $0 Sales Order if somebody wants one; on a slip
// with a charged machine and a free one, both go on the same order as before.
//
// Checked: a slip of repaired machines with nothing billed is now in Close
// Service; it closes with no number and is marked as closed without invoice,
// its machines collected; a charge recorded on it does not stop sales closing
// it; a slip with a charged Sales Order is refused and closes the ordinary way; a
// machine still on the bench is refused; a condemned one is held to the usual
// signature and disposal; the ordinary close is unchanged and still refuses an
// unbilled machine. And (00030) a slip whose Sales Orders are all $0 closes
// the same way; one with a charge on any order is refused.
const fs = require("fs");
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
async function refused(what, fn, like) {
  try { await fn(); check(what, "allowed", "refused"); }
  catch (e) { check(what, like.test(e.message) ? "refused" : e.message, "refused"); }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const make = (company, descs) => data.slips.createSlip({
  company, contact_name: "A", contact_number: "1", signature: sig,
  machines: descs.map((desc) => ({ desc })),
});
const inClose = async (no) =>
  (await data.slips.searchSlips(no, "repaired", 20)).results.some((r) => r.slip_number === no)
  && (await data.slips.listSlips("repaired")).some((r) => r.slip_number === no);
const noInvoice = { noInvoice: true };

(async () => {
  console.log("-- checked, nothing wrong, free of charge --");
  const a = await make("NO FAULT", ["525BX"]);
  const am = a.machines[0].id;
  check("not in Close Service before it is finished", await inClose(a.slip_number), false);
  await data.slips.saveMachineWork(am, "repaired", "WJ", { foc: true });
  check("repaired, nothing billed: the status it always had", (await data.slips.getSlip(a.slip_number)).status, "REPAIRED");
  check("and now in Close Service", await inClose(a.slip_number), true);
  check("still on the technicians' list, so a mis-tick can be undone",
    (await data.slips.searchSlips(a.slip_number, "working", 20)).results.some((r) => r.slip_number === a.slip_number), true);
  check("the search row says it is free of charge",
    (await data.slips.searchSlips(a.slip_number, "repaired", 20)).results[0].machines[0].foc, 1);
  await refused("the ordinary close still wants a Sales Order",
    () => data.slips.closeSlip(a.slip_number, "", "KS"), /Not on a Sales Order yet/);
  let slip = await data.slips.closeSlip(a.slip_number, "", "KS", noInvoice);
  check("closes with no invoice", [slip.status, slip.closing_ref, slip.closed_no_invoice, slip.closed_by],
    ["CLOSED", "", 1, "KS"]);
  check("the machine is collected", [slip.machines[0].disposal, slip.machines[0].disposal_by], ["COLLECTED", "KS"]);
  check("and it is off Close Service", await inClose(a.slip_number), false);
  await refused("closing it twice is refused",
    () => data.slips.closeSlip(a.slip_number, "", "KS", noInvoice), /already closed/);

  console.log("\n-- a charge recorded, and sales decide not to bill it --");
  const b = await make("NOT CHARGED", ["MS180"]);
  await data.slips.setMachineLabour(b.machines[0].id, 30);
  await data.slips.setMachineState(b.slip_number, b.machines[0].id, "REPAIRED", "WJ");
  check("in Close Service", await inClose(b.slip_number), true);
  slip = await data.slips.closeSlip(b.slip_number, "", "KS", noInvoice);
  check("closes with no invoice", [slip.status, slip.closed_no_invoice], ["CLOSED", 1]);

  console.log("\n-- a machine still on the bench --");
  const c = await make("HALF DONE", ["MS180 - 1/2", "MS250 - 2/2"]);
  await data.slips.saveMachineWork(c.machines[0].id, "repaired", "WJ", { foc: true });
  await refused("refused, naming it",
    () => data.slips.closeSlip(c.slip_number, "", "KS", noInvoice), /Not finished yet: MS250 - 2\/2/);
  check("left open", (await data.slips.getSlip(c.slip_number)).status !== "CLOSED", true);

  console.log("\n-- 00030's shape: free of charge on a $0 Sales Order, already collected --");
  const z = await make("ZERO SO", ["Blastrac 1-10DPS75"]);
  await data.slips.saveMachineWork(z.machines[0].id, "repaired", "WJ", { foc: true });
  const zso = await data.slips.createSlipOrder(z.slip_number, [z.machines[0].id], "WJ");
  check("the slip carries the order's total, for the screen",
    (await data.slips.getSlip(z.slip_number)).orders.map((o) => o.total_amount), [0]);
  await refused("the ordinary close still wants its number",
    () => data.slips.closeSlip(z.slip_number, "", "KS"), /DO\/CS\/INV/);
  slip = await data.slips.closeSlip(z.slip_number, "", "KS", noInvoice);
  check("closes with no invoice", [slip.status, slip.closed_no_invoice], ["CLOSED", 1]);
  check("the order is left as it was", slip.orders.map((o) => [o.so_number, o.closing_ref]), [[zso.so_number, ""]]);

  console.log("\n-- a Sales Order with a charge on it --");
  const d = await make("CHARGED SO", ["MS180 - 1/2", "525BX - 2/2"]);
  const [d1, d2] = d.machines.map((m) => m.id);
  await data.slips.setMachineLabour(d1, 40);
  await data.slips.setMachineState(d.slip_number, d1, "REPAIRED", "WJ");
  await data.slips.saveMachineWork(d2, "repaired", "WJ", { foc: true });
  const dso = await data.slips.createSlipOrder(d.slip_number, [d1], "WJ");
  await data.slips.createSlipOrder(d.slip_number, [d2], "WJ");
  await refused("refused, naming the order and its total",
    () => data.slips.closeSlip(d.slip_number, "", "KS", noInvoice),
    new RegExp(`${dso.so_number} is \\$40\\.00\\. A Sales Order with a charge needs its DO/CS/INV`));
  await data.slips.setSlipInvoiced(d.slip_number, "DO-2610-0009", "KS", dso.so_number);
  await refused("still refused once that one is invoiced - every order has to be $0",
    () => data.slips.closeSlip(d.slip_number, "", "KS", noInvoice), /is \$40\.00/);
  check("left open", (await data.slips.getSlip(d.slip_number)).status !== "CLOSED", true);

  console.log("\n-- the ordinary way is untouched --");
  const o = await make("ORDINARY", ["MS180"]);
  await data.slips.setMachineLabour(o.machines[0].id, 40);
  await data.slips.setMachineState(o.slip_number, o.machines[0].id, "REPAIRED", "WJ");
  await data.slips.createSlipOrder(o.slip_number, [o.machines[0].id], "WJ");
  await data.slips.setSlipInvoiced(o.slip_number, "DO-2610-0010", "KS");
  slip = await data.slips.closeSlip(o.slip_number, "", "KS");
  check("closes with its number", [slip.status, slip.closing_ref, slip.closed_no_invoice],
    ["CLOSED", "DO-2610-0010", 0]);

  console.log("\n-- with a condemned machine --");
  const e = await make("WITH CONDEMNED", ["MS180 - 1/2", "BK3410 - 2/2"]);
  const [er, ec] = e.machines.map((m) => m.id);
  await data.slips.saveMachineWork(er, "repaired", "WJ", { foc: true });
  await data.slips.setMachineState(e.slip_number, ec, "CONDEMNED", "WJ");
  await refused("an unsigned condemned machine still stops it",
    () => data.slips.closeSlip(e.slip_number, "", "KS", noInvoice), /not signed for/);
  await data.slips.setCondemnSignature(e.slip_number, ec, { image: sig, who: "JT" });
  await refused("and one nobody has accounted for",
    () => data.slips.closeSlip(e.slip_number, "", "KS", noInvoice), /not yet accounted for/);
  await data.slips.setMachineDisposal(e.slip_number, ec, "DISPOSED", "KS");
  slip = await data.slips.closeSlip(e.slip_number, "", "KS", noInvoice);
  check("then closes", slip.status, "CLOSED");
  check("the repaired one collected, the condemned one left as recorded",
    slip.machines.map((m) => m.disposal).sort(), ["COLLECTED", "DISPOSED"]);

  console.log("\n-- the server only does it when asked in so many words --");
  const server = fs.readFileSync(path.resolve(__dirname, "..", "backend", "server.js"), "utf8");
  check("no_invoice must be true, not merely truthy",
    /closeSlip\(req\.params\.slip, closing_ref, who, \{ noInvoice: no_invoice === true \}\)/.test(server), true);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
