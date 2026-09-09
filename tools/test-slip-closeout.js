// The end of a slip's life: SO Created, Invoice Created, Collected & Closed.
//
//   node tools/test-slip-closeout.js C:/temp/scratch.db
//
// Two of the three are set by a person, because nothing in this app can see
// AutoCount's invoice or the customer's car. What is checked here is that they
// go in John's order, that neither can be undone by a later edit to a machine,
// and that the screens looking for work still find the slip at each step.
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
const refuse = async (what, fn, re) => {
  let err = "";
  try { await fn(); } catch (e) { err = e.message; }
  const ok = re.test(err);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(err)}`);
};
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const seen = async (scope, no) =>
  (await data.slips.listSlips(scope)).some((s) => s.slip_number === no);

(async () => {
  const build = async (name, descs) => data.slips.createSlip({
    company: name, contact_name: "A", contact_number: "9",
    machines: descs.map((d, i) => ({ desc: d, serial: `S${i}`, remarks: "" })),
    signature: sig,
  });

  console.log("\n-- the whole way through --");
  let slip = await build("TEST CLOSEOUT A", ["Chainsaw 572XP", "Blower 580BTS"]);
  const no = slip.slip_number;
  const ids = slip.machines.map((m) => m.id);

  for (const id of ids) {
    await data.slips.setMachineLabour(id, 40);
    await data.slips.finishRepair(id, "WJ");
  }
  slip = await data.slips.getSlip(no);
  check("the workshop is finished", slip.status, "REPAIRED");
  check("and the technicians still see it", await seen("working", no), true);

  // 1. Create Sales Order.
  await data.slips.createSlipOrder(no, ids, "KS");
  slip = await data.slips.getSlip(no);
  check("creating the Sales Order gives the slip its own status", slip.status, "CONVERTED");
  check("off the technicians' list", await seen("working", no), false);
  check("and onto the one sales work from", await seen("repaired", no), true);

  // 2. Sales key it into AutoCount and record what came back.
  slip = await data.slips.setSlipInvoiced(no, "DO-2609-0142", "KS");
  check("invoiced", slip.status, "INVOICED");
  check("with the number on it", slip.closing_ref, "DO-2609-0142");
  check("and who recorded it", slip.invoiced_by, "KS");
  check("still on the sales list, now waiting to be collected", await seen("repaired", no), true);
  check("and still not on the technicians'", await seen("working", no), false);

  // 3. The customer comes, collects and pays.
  slip = await data.slips.closeSlip(no, "", "KS");
  check("collected and closed", slip.status, "CLOSED");
  check("the number is still the one recorded at the invoice step", slip.closing_ref, "DO-2609-0142");
  check("and who closed it", slip.closed_by, "KS");
  check("gone from the working lists", [await seen("working", no), await seen("repaired", no)], [false, false]);

  console.log("\n-- the order cannot be skipped --");
  slip = await build("TEST CLOSEOUT B", ["Hedge trimmer 522HDR"]);
  const noB = slip.slip_number, idB = slip.machines[0].id;
  await refuse("nothing to invoice before there is a Sales Order",
    () => data.slips.setSlipInvoiced(noB, "DO-1", "KS"), /Sales Order first/);
  await data.slips.setMachineLabour(idB, 25);
  await data.slips.finishRepair(idB, "WJ");
  await refuse("still nothing, even once it is repaired",
    () => data.slips.setSlipInvoiced(noB, "DO-1", "KS"), /Sales Order first/);
  await data.slips.createSlipOrder(noB, [idB], "KS");
  await refuse("and it cannot be collected before it is invoiced",
    () => data.slips.closeSlip(noB, "", "KS"), /only collected after it has been invoiced/);
  await refuse("nor by handing closing a number, which used to be enough",
    () => data.slips.closeSlip(noB, "DO-1", "KS"), /invoiced/);
  await refuse("an invoice with no number is not an invoice",
    () => data.slips.setSlipInvoiced(noB, "   ", "KS"), /number is required/);

  console.log("\n-- correcting a mistyped number --");
  await data.slips.setSlipInvoiced(noB, "DO-WRONG", "KS");
  slip = await data.slips.setSlipInvoiced(noB, "DO-2609-0143", "KS");
  check("re-recording replaces it", slip.closing_ref, "DO-2609-0143");
  check("and it is still invoiced, not unwound", slip.status, "INVOICED");

  console.log("\n-- an edit afterwards does not undo it --");
  // The status is a person's word about something outside this app. A part
  // corrected on a machine must not quietly send the slip back to SO Created.
  await data.slips.setMachineComment(idB, "note added after invoicing");
  slip = await data.slips.getSlip(noB);
  check("still invoiced", slip.status, "INVOICED");
  await data.slips.setMachineLabour(idB, 30);
  slip = await data.slips.getSlip(noB);
  check("still invoiced after a labour change too", slip.status, "INVOICED");

  console.log("\n-- a condemned machine nobody has accounted for --");
  slip = await build("TEST CLOSEOUT C", ["Mower LC19", "Pole saw 525PT5S"]);
  const noC = slip.slip_number, [mow, pole] = slip.machines.map((m) => m.id);
  await data.slips.setMachineComment(mow, "crankcase cracked");
  await data.slips.setMachineState(noC, mow, "CONDEMNED", "WJ");
  await data.slips.setMachineLabour(pole, 30);
  await data.slips.finishRepair(pole, "WJ");
  await data.slips.createSlipOrder(noC, [pole], "KS");
  // The condemned machine holds the slip at IN_PROGRESS - it is still in the
  // workshop and still somebody's job. That must NOT stop sales recording an
  // invoice they really raised for the rest of it, so the invoice step asks
  // the machines whether anything is on an order rather than asking the slip's
  // status.
  slip = await data.slips.getSlip(noC);
  check("the condemned machine holds the slip open", slip.status, "IN_PROGRESS");
  slip = await data.slips.setSlipInvoiced(noC, "INV-77", "KS");
  check("and the rest can still be invoiced", slip.status, "INVOICED");
  await refuse("but it cannot be closed with a machine still in the workshop",
    () => data.slips.closeSlip(noC, "", "KS"), /Condemned but not yet accounted for/);
  await data.slips.setMachineDisposal(noC, mow, "COLLECTED", "KS");
  slip = await data.slips.closeSlip(noC, "", "KS");
  check("and once it has left, it closes", slip.status, "CLOSED");

  console.log("\n-- a slip that is only part-way onto an order --");
  // Two machines, one billed. Sales can still record an invoice for what they
  // raised: refusing would leave them unable to record something that really
  // happened.
  slip = await build("TEST CLOSEOUT D", ["Brushcutter 545RX", "Blower 525BX"]);
  const noD = slip.slip_number, idsD = slip.machines.map((m) => m.id);
  for (const id of idsD) { await data.slips.setMachineLabour(id, 20); await data.slips.finishRepair(id, "WJ"); }
  await data.slips.createSlipOrder(noD, [idsD[0]], "KS");
  slip = await data.slips.getSlip(noD);
  check("half of it is billed", slip.status, "ALL_REPAIRED");
  slip = await data.slips.setSlipInvoiced(noD, "INV-88", "KS");
  check("and an invoice can be recorded against it", slip.status, "INVOICED");

  console.log("\n-- closing twice --");
  await refuse("says so rather than moving the date",
    () => data.slips.closeSlip(noC, "", "KS"), /already closed/);
  await refuse("and a closed slip cannot be re-invoiced",
    () => data.slips.setSlipInvoiced(noC, "INV-99", "KS"), /already closed/);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
