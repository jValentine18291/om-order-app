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
  // Part of it is billed, so the slip says Partial SO rather than In Progress.
  // Either way it is not finished, and the invoice step asks the MACHINES
  // whether anything is on an order rather than reading the status.
  check("the condemned machine holds the slip open", slip.status, "PART_SO");
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

  console.log("\n-- a slip stays correctable right up to the moment it closes --");
  // View Slips can now hand any slip that is not closed back to the workshop
  // screen, so a part scanned onto the wrong machine can be taken off again.
  // What that must not reach is a CLOSED slip: those parts have been billed,
  // collected and paid for, and a line changed afterwards puts this app at
  // odds with the invoice the customer holds, with nothing to show it moved.
  let s = await build("TEST STILL EDITABLE", ["Brushcutter 545RX"]);
  const noE = s.slip_number, mE = s.machines[0].id;
  await data.slips.setMachineLabour(mE, 30);
  await data.slips.addPartToMachine(mE, {
    item_code: "SZEN 848BE058B2", description: "GASKET", unit_price: 4.5, quantity: 1, technician: "WJ",
  });
  // Billed, and still correctable - this is the case the technicians asked for.
  await data.slips.finishRepair(mE, "WJ");
  await data.slips.createSlipOrder(noE, [mE], "KS");
  let ps = (await data.slips.getSlip(noE)).machines[0].parts;
  check("a billed machine still takes a correction", ps.length, 1);
  await data.slips.addPartToMachine(mE, {
    item_code: "SZEN 165151220", description: "Clutch Spring", unit_price: 2.5, quantity: 1, technician: "WJ",
  });
  ps = (await data.slips.getSlip(noE)).machines[0].parts;
  check("  the part goes on", ps.length, 2);
  await data.slips.setPartQuantity(ps[1].id, 0);
  ps = (await data.slips.getSlip(noE)).machines[0].parts;
  check("  and comes off again", ps.length, 1);

  // The order it was raised with is untouched by any of that, which is why
  // correcting a billed machine is safe and why the screen says AutoCount will
  // not follow.
  const soLines = (await data.slips.getSlipOrder(noE)).lines.filter((l) => l.item_code === "SZEN 848BE058B2");
  check("the Sales Order keeps what it was raised with", soLines.length, 1);

  // Now close it, and the same three edits are refused.
  await data.slips.setSlipInvoiced(noE, "INV-77", "KS");
  await data.slips.closeSlip(noE, "INV-77", "KS");
  check("closed", (await data.slips.getSlip(noE)).status, "CLOSED");
  await refuse("a closed slip takes no new part",
    () => data.slips.addPartToMachine(mE, {
      item_code: "SZEN 140051111", description: "Shoe Clutch", unit_price: 9.5, quantity: 1, technician: "WJ",
    }), /closed/);
  await refuse("  none removed",
    () => data.slips.setPartQuantity(ps[0].id, 0), /closed/);
  await refuse("  no price changed",
    () => data.slips.setPartPrice(ps[0].id, 99), /closed/);
  await refuse("  no labour changed",
    () => data.slips.setMachineLabour(mE, 999), /closed/);
  await refuse("  and no comment written",
    () => data.slips.setMachineComment(mE, "after the fact"), /closed/);
  check("so nothing on it moved", (await data.slips.getSlip(noE)).machines[0].parts.length, 1);

  console.log("\n-- closing twice --");
  await refuse("says so rather than moving the date",
    () => data.slips.closeSlip(noC, "", "KS"), /already closed/);
  await refuse("and a closed slip cannot be re-invoiced",
    () => data.slips.setSlipInvoiced(noC, "INV-99", "KS"), /already closed/);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
