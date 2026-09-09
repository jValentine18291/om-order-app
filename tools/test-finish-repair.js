// Pressing Save on a machine marks it Repaired - and the cases where it must not.
//
//   node tools/test-finish-repair.js C:/temp/scratch.db
//
// The risk here is not the happy path. It is a machine quietly leaving a state
// somebody else is waiting on: a machine sent for quoting that marks itself
// repaired drops off the Need to Quote list, and nobody rings the customer.
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
  const makeSlip = async (name, machines) => data.slips.createSlip({
    company: name, contact_name: "A", contact_number: "9",
    machines: machines.map((d, i) => ({ desc: d, serial: `S${i}`, remarks: "" })),
    signature: sig,
  });
  const stateOf = (slip, id) => slip.machines.find((m) => m.id === id).state;

  console.log("\n-- a machine that came in and was worked on --");
  let slip = await makeSlip("TEST FINISH A", ["Chainsaw 572XP", "Blower 580BTS"]);
  const [saw, blower] = slip.machines;
  check("it starts received", stateOf(slip, saw.id), "RECEIVED");
  await data.slips.setMachineComment(saw.id, "cleaned carburettor, new plug");
  let r = await data.slips.finishRepair(saw.id, "WJ");
  check("Save finishes it", r.moved, true);
  check("and it is repaired", stateOf(r.slip, saw.id), "REPAIRED");
  check("who did it is recorded", r.slip.machines.find((m) => m.id === saw.id).decided_by, "WJ");
  check("the other machine is untouched", stateOf(r.slip, blower.id), "RECEIVED");
  check("and the slip is still being worked on", r.slip.status, "IN_PROGRESS");

  console.log("\n-- pressing Save again --");
  r = await data.slips.finishRepair(saw.id, "WJ");
  check("nothing to say the second time", r.moved, false);
  check("and it stays repaired", stateOf(r.slip, saw.id), "REPAIRED");

  console.log("\n-- Save with nothing recorded --");
  // Opening a machine, pressing Save and walking away is not a repair. A
  // machine marked repaired with no parts, no labour and no note is a machine
  // nobody can account for afterwards.
  r = await data.slips.finishRepair(blower.id, "WJ");
  check("it does not move", r.moved, false);
  check("still received", stateOf(r.slip, blower.id), "RECEIVED");
  // Any ONE of the three counts as work.
  await data.slips.setMachineLabour(blower.id, 45);
  r = await data.slips.finishRepair(blower.id, "WJ");
  check("labour alone is enough", [r.moved, stateOf(r.slip, blower.id)], [true, "REPAIRED"]);
  check("and now the whole slip is repaired", r.slip.status, "REPAIRED");

  console.log("\n-- a machine sales are still ringing about --");
  // The one that matters. A machine sent for quoting has somebody waiting on
  // it. If Save marked it repaired, the slip would leave NEED_QUOTE and the
  // customer would never be called.
  slip = await makeSlip("TEST FINISH B", ["Hedge trimmer 522HDR"]);
  const hedge = slip.machines[0];
  await data.slips.setMachineComment(hedge.id, "stripped down to price the job");
  slip = await data.slips.setMachineState(slip.slip_number, hedge.id, "AWAITING_QUOTE", "WJ");
  check("the slip is waiting on sales", slip.status, "NEED_QUOTE");
  r = await data.slips.finishRepair(hedge.id, "WJ");
  check("Save leaves it where it is", r.moved, false);
  check("still awaiting a quote", stateOf(r.slip, hedge.id), "AWAITING_QUOTE");
  check("and the slip still asks sales to ring", r.slip.status, "NEED_QUOTE");

  console.log("\n-- a machine the customer has not answered on --");
  slip = await data.slips.setMachineState(slip.slip_number, hedge.id, "QUOTED", "KS");
  r = await data.slips.finishRepair(hedge.id, "WJ");
  check("quoted stays quoted", [r.moved, stateOf(r.slip, hedge.id)], [false, "QUOTED"]);

  console.log("\n-- and once they say go ahead --");
  slip = await data.slips.setMachineState(slip.slip_number, hedge.id, "TO_REPAIR", "KS");
  r = await data.slips.finishRepair(hedge.id, "WJ");
  check("Save finishes it", [r.moved, stateOf(r.slip, hedge.id)], [true, "REPAIRED"]);

  console.log("\n-- a machine that is beyond repair --");
  slip = await makeSlip("TEST FINISH C", ["Mower LC19"]);
  const mower = slip.machines[0];
  await data.slips.setMachineComment(mower.id, "crankcase cracked");
  slip = await data.slips.setMachineState(slip.slip_number, mower.id, "CONDEMNED", "WJ");
  r = await data.slips.finishRepair(mower.id, "WJ");
  check("writing a note on it does not repair it",
    [r.moved, stateOf(r.slip, mower.id)], [false, "CONDEMNED"]);

  console.log("\n-- a machine already on a sales order --");
  slip = await makeSlip("TEST FINISH D", ["Pole saw 525PT5S"]);
  const pole = slip.machines[0];
  await data.slips.setMachineLabour(pole.id, 30);
  await data.slips.finishRepair(pole.id, "WJ");
  await data.slips.createSlipOrder(slip.slip_number, [pole.id], "KS");
  slip = await data.slips.getSlip(slip.slip_number);
  check("it has been billed", !!slip.machines[0].converted_at, true);
  r = await data.slips.finishRepair(pole.id, "WJ");
  check("nothing is written to a billed machine", r.moved, false);

  console.log("\n-- a closed slip --");
  slip = await makeSlip("TEST FINISH E", ["Brushcutter 545RX"]);
  const cutter = slip.machines[0];
  await data.slips.setMachineLabour(cutter.id, 20);
  await data.slips.finishRepair(cutter.id, "WJ");
  await data.slips.createSlipOrder(slip.slip_number, [cutter.id], "KS");
  await data.slips.setSlipInvoiced(slip.slip_number, "INV-1234", "KS");
  await data.slips.closeSlip(slip.slip_number, "", "KS");
  r = await data.slips.finishRepair(cutter.id, "WJ");
  check("a closed slip is not reopened by a stray Save", r.moved, false);
  check("and it is still closed", r.slip.status, "CLOSED");

  console.log("\n-- a machine that does not exist --");
  let err = "";
  try { await data.slips.finishRepair(999999, "WJ"); } catch (e) { err = e.message; }
  check("says so rather than failing quietly", /Machine not found/.test(err), true);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
