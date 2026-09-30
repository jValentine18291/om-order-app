// SAVE, SAID THREE WAYS - and what follows from it.
// Run against a throwaway database, never the real one:
//
//   node tools/test-save-outcomes.js C:/temp/scratch.db
//
// John, 30 Sep 2026. The machine sheet's one Save button became three, so the
// technician says what the save means:
//
//   not done yet        the machine is in progress, and the app says so
//   fully repaired      finished - refused on a quote-first slip until the
//                       customer has actually answered the quote
//   send for quotation  off to Sales
//
// And two rules around the same lifecycle: only a repaired or condemned
// machine goes on a Sales Order, and a machine is collected against that
// order - two of five at a time if that is what the customer takes - with
// "Collected & Closed" sweeping up whatever was not ticked off one by one.
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
const stateOf = async (no, id) => (await data.slips.getSlip(no)).machines.find((m) => m.id === id).state;

(async () => {
  // ==========================================================================
  console.log("-- an ordinary slip: three saves, three meanings --");
  let slip = await data.slips.createSlip({
    company: "ORDINARY PTE LTD", contact_name: "A", contact_number: "1",
    machines: [{ desc: "HBZ260EZ Blower", serial: "A1", remarks: "" }],
    signature: sig,
  });
  const no = slip.slip_number;
  const id = slip.machines[0].id;

  // Nothing on it yet: "not done yet" changes nothing, because there is no
  // work to be in progress with.
  let r = await data.slips.saveMachineWork(id, "progress", "KM");
  check("not done yet, with nothing recorded: stays received", [r.moved, await stateOf(no, id)], [false, "RECEIVED"]);

  await data.slips.setMachineLabour(id, 40);
  r = await data.slips.saveMachineWork(id, "progress", "KM");
  check("not done yet, with work on it: In Progress", [r.moved, await stateOf(no, id)], [true, "TO_REPAIR"]);
  r = await data.slips.saveMachineWork(id, "progress", "KM");
  check("  and saying so again moves nothing", r.moved, false);

  r = await data.slips.saveMachineWork(id, "repaired", "KM");
  check("fully repaired", [r.moved, await stateOf(no, id)], [true, "REPAIRED"]);

  console.log("\n-- send for quotation --");
  slip = await data.slips.createSlip({
    company: "QUOTE ME PTE LTD", contact_name: "A", contact_number: "1",
    machines: [{ desc: "525BX Blower", serial: "B1", remarks: "" }], signature: sig,
  });
  const qn = slip.slip_number, qid = slip.machines[0].id;
  await data.slips.setMachineLabour(qid, 60);
  r = await data.slips.saveMachineWork(qid, "quote", "KM");
  check("goes to Sales", [r.moved, await stateOf(qn, qid)], [true, "AWAITING_QUOTE"]);
  r = await data.slips.saveMachineWork(qid, "quote", "KM");
  check("  asking twice is not two requests", r.moved, false);
  await refuse("a machine out for quoting cannot be called repaired",
    () => data.slips.saveMachineWork(qid, "repaired", "KM"), /./);
  check("  and is still waiting", await stateOf(qn, qid), "AWAITING_QUOTE");

  // ==========================================================================
  console.log("\n-- quote first: no 'fully repaired' until the customer has answered --");
  slip = await data.slips.createSlip({
    company: "QUOTE FIRST PTE LTD", contact_name: "A", contact_number: "1", quote_first: true,
    machines: [{ desc: "572XP Chainsaw", serial: "C1", remarks: "" }], signature: sig,
  });
  const fn = slip.slip_number, fid = slip.machines[0].id;
  await data.slips.setMachineLabour(fid, 90);
  await refuse("refused straight off the bench",
    () => data.slips.saveMachineWork(fid, "repaired", "KM"), /quote first/i);
  // A technician's own "not done yet" is not the customer's answer.
  await data.slips.saveMachineWork(fid, "progress", "KM");
  check("in progress by the technician's own hand", await stateOf(fn, fid), "TO_REPAIR");
  await refuse("still refused - In Progress is not approval",
    () => data.slips.saveMachineWork(fid, "repaired", "KM"), /quote first/i);
  // Off to Sales, quoted, and the customer says yes.
  await data.slips.saveMachineWork(fid, "quote", "KM");
  await data.slips.setMachineState(fn, fid, "QUOTED", "CY");
  await data.slips.setMachineState(fn, fid, "TO_REPAIR", "CY");
  check("the go-ahead is remembered on the machine",
    !!(await data.slips.getSlip(fn)).machines[0].quote_approved_at, true);
  r = await data.slips.saveMachineWork(fid, "repaired", "KM");
  check("and NOW it can be fully repaired", [r.moved, await stateOf(fn, fid)], [true, "REPAIRED"]);
  // Sent back for a revised price: the answer no longer stands.
  await data.slips.setMachineState(fn, fid, "AWAITING_QUOTE", "CY");
  check("re-quoting withdraws the go-ahead",
    (await data.slips.getSlip(fn)).machines[0].quote_approved_at, "");

  // ==========================================================================
  console.log("\n-- only a finished machine goes on a Sales Order --");
  slip = await data.slips.createSlip({
    company: "FIVE MACHINES PTE LTD", contact_name: "A", contact_number: "1",
    machines: [1, 2, 3, 4, 5].map((n) => ({ desc: `BK3410 - ${n}/5`, serial: `Z${n}`, remarks: "" })),
    signature: sig,
  });
  const sn = slip.slip_number;
  const ids = slip.machines.map((m) => m.id);
  for (const mid of ids) await data.slips.setMachineLabour(mid, 30);
  await data.slips.saveMachineWork(ids[0], "progress", "KM");                       // in progress
  await data.slips.saveMachineWork(ids[1], "repaired", "KM");                       // done
  await data.slips.saveMachineWork(ids[2], "repaired", "KM");                       // done
  await data.slips.setMachineState(sn, ids[3], "CONDEMNED", "CY");                  // done, the other way
  // ids[4] untouched
  await refuse("an in-progress machine is refused by name",
    () => data.slips.createSlipOrder(sn, [ids[0], ids[1]], "KS"), /Not finished yet: BK3410 - 1\/5/);
  await refuse("so is one nobody has started",
    () => data.slips.createSlipOrder(sn, [ids[4]], "KS"), /Not finished yet: BK3410 - 5\/5/);
  const so1 = await data.slips.createSlipOrder(sn, [ids[1], ids[2]], "KS");
  check("the two repaired ones go on together", so1.machines_converted.length, 2);
  const so2 = await data.slips.createSlipOrder(sn, [ids[3]], "KS");
  check("and the condemned one on its own, at nothing", so2.machines_converted.length, 1);

  // ==========================================================================
  console.log("\n-- the customer collects two of five --");
  await refuse("a machine not on an order cannot be collected",
    () => data.slips.setMachineDisposal(sn, ids[0], "COLLECTED", "CY"), /Only a repaired or condemned/);
  await data.slips.saveMachineWork(ids[0], "repaired", "KM");
  await refuse("  nor once it is repaired but still unbilled",
    () => data.slips.setMachineDisposal(sn, ids[0], "COLLECTED", "CY"), /Sales Order first/);
  await refuse("a repaired machine is never 'disposed of'",
    () => data.slips.setMachineDisposal(sn, ids[1], "DISPOSED", "CY"), /Only a condemned machine is disposed/);

  slip = await data.slips.setMachineDisposal(sn, ids[1], "COLLECTED", "CY");
  check("one repaired machine handed back", slip.machines.find((m) => m.id === ids[1]).disposal, "COLLECTED");
  check("  by whom", slip.machines.find((m) => m.id === ids[1]).disposal_by, "CY");
  check("  the other billed one is still here", slip.machines.find((m) => m.id === ids[2]).disposal, "");
  await data.slips.setCondemnSignature(sn, ids[3], { image: sig, who: "CY" });
  slip = await data.slips.setMachineDisposal(sn, ids[3], "COLLECTED", "CY");
  check("and the condemned one, against its $0 order", slip.machines.find((m) => m.id === ids[3]).disposal, "COLLECTED");

  // ==========================================================================
  console.log("\n-- closing: the ones nobody ticked are collected by the Close button --");
  await data.slips.saveMachineWork(ids[4], "repaired", "KM");
  await data.slips.createSlipOrder(sn, [ids[0], ids[4]], "KS");
  // Every order gets its document number, in one invoice as the office does it.
  for (const o of await data.slips.getSlipOrders(sn)) {
    await data.slips.setSlipInvoiced(sn, "INV-2609-0200", "CY", o.so_number);
  }
  slip = await data.slips.closeSlip(sn, "INV-2609-0200", "CY");
  check("closed", slip.status, "CLOSED");
  const left = slip.machines.filter((m) => m.disposal !== "COLLECTED").map((m) => m.machine_desc);
  check("every machine reads collected afterwards", left, []);
  check("the ones ticked earlier keep their own record",
    slip.machines.find((m) => m.id === ids[1]).disposal_by, "CY");

  console.log("\n-- but a condemned machine is never swept up by Close --");
  slip = await data.slips.createSlip({
    company: "STILL HERE PTE LTD", contact_name: "A", contact_number: "1",
    machines: [{ desc: "Old mower", serial: "M1", remarks: "" }, { desc: "Good saw", serial: "M2", remarks: "" }],
    signature: sig,
  });
  const cn = slip.slip_number, [mow, saw] = slip.machines.map((m) => m.id);
  await data.slips.setMachineLabour(saw, 30);
  await data.slips.saveMachineWork(saw, "repaired", "KM");
  await data.slips.setMachineState(cn, mow, "CONDEMNED", "CY");
  await data.slips.setCondemnSignature(cn, mow, { image: sig, who: "CY" });
  await data.slips.createSlipOrder(cn, [mow, saw], "KS");
  await data.slips.setSlipInvoiced(cn, "INV-2609-0201", "CY");
  await refuse("it has to be said where the condemned one went",
    () => data.slips.closeSlip(cn, "INV-2609-0201", "CY"), /not yet accounted for/);
  check("  and the saw was not touched by the refused close",
    (await data.slips.getSlip(cn)).machines.find((m) => m.id === saw).disposal, "");

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
