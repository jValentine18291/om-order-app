// John's flowchart, walked end to end on a scratch database.
// Run against a throwaway database, never the real one:
//
//   node tools/test-machine-states.js C:/temp/scratch.db
//
// The path is REQUIRED and is checked against the live file. Without this, a
// forgotten argument sends db.js to backend/om_orders.db and these tests write
// test slips straight into the workshop's records.
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
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${got}${ok ? "" : `  (expected ${want})`}`);
}

const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  // Two machines in together, and the customer wants the job quoted.
  let slip = await data.slips.createSlip({
    company: "TEST STATE MODEL",
    contact_name: "A", contact_number: "9",
    quote_first: true,
    machines: [
      { desc: "Chainsaw 372XP", serial: "S1", remarks: "won't start" },
      { desc: "Blower 580BTS", serial: "S2", remarks: "service" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const [saw, blower] = slip.machines;
  console.log(`\nSlip ${no}: ${slip.machines.map((m) => `${m.machine_desc} = ${m.state}`).join(", ")}`);
  // The counter records the request; it does not decide any machine's state.
  // Quoting before a technician has looked means quoting nothing.
  check("the customer's request is on the slip", slip.quote_first, 1);
  check("the quoted machine still starts received", saw.state, "RECEIVED");
  check("so does the other one", blower.state, "RECEIVED");
  check("and the slip is simply open", slip.status, "OPEN");

  // A technician works the blower, then finds the saw expensive and sends it.
  await data.slips.setMachineComment(blower.id, "cleaned carburettor");
  slip = await data.slips.getSlip(no);
  check("work started, nothing to quote yet", slip.status, "IN_PROGRESS");

  slip = await data.slips.setMachineState(no, saw.id, "AWAITING_QUOTE", "WJ");
  check("the technician's tick is what asks for a quote", slip.status, "NEED_QUOTE");

  // Sales quote it; the customer is now the one holding things up.
  slip = await data.slips.setMachineState(no, saw.id, "QUOTED", "Iris");
  check("quoted, waiting on the customer", slip.status, "QUOTED");
  check("who quoted it is recorded", slip.machines[0].decided_by, "Iris");

  // The customer says no.
  slip = await data.slips.setMachineState(no, saw.id, "CONDEMNED", "Iris");
  check("condemned", slip.machines[0].state, "CONDEMNED");
  check("slip back to the workshop", slip.status, "IN_PROGRESS");

  // The blower is billed. The slip is NOT finished: the condemned machine is
  // still physically in the workshop.
  await data.slips.createSlipOrder(no, [blower.id]);
  slip = await data.slips.getSlip(no);
  // Not "All Repaired": the condemned one is still sitting in the workshop.
  check("one billed, one condemned and still here", slip.status, "IN_PROGRESS");

  // Closing is refused while nobody has said where the condemned one went.
  let err = "";
  try { await data.slips.closeSlip(no, "DO-1234"); } catch (e) { err = e.message; }
  check("closing blocked", /Condemned but not yet accounted for/.test(err), true);
  console.log(`        ↳ "${err}"`);

  // The customer collects it. Now everything is accounted for.
  slip = await data.slips.setMachineDisposal(no, saw.id, "COLLECTED", "John");
  check("disposal recorded", slip.machines[0].disposal, "COLLECTED");
  check("nothing outstanding", slip.status, "CONVERTED");
  slip = await data.slips.closeSlip(no, "DO-1234");
  check("closes", slip.status, "CLOSED");

  // A closed slip is a finished record.
  err = "";
  try { await data.slips.setMachineState(no, saw.id, "TO_REPAIR", "X"); } catch (e) { err = e.message; }
  check("closed slip refuses changes", /already closed/.test(err), true);

  // ---- Un-condemning clears the disposal with it -----------------------------
  slip = await data.slips.createSlip({
    company: "TEST UNDO", contact_name: "B", contact_number: "8",
    machines: [{ desc: "Trimmer", serial: "S3", quote: true }], signature: sig,
  });
  const n2 = slip.slip_number, m2 = slip.machines[0].id;
  await data.slips.setMachineState(n2, m2, "QUOTED", "Iris");
  await data.slips.setMachineState(n2, m2, "CONDEMNED", "Iris");
  await data.slips.setMachineDisposal(n2, m2, "DISPOSED", "John");
  slip = await data.slips.setMachineState(n2, m2, "TO_REPAIR", "Iris");
  check("changed his mind: disposal cleared", slip.machines[0].disposal, "");
  check("and it is work again", slip.status, "IN_PROGRESS");

  // Only a condemned machine can be collected or scrapped.
  err = "";
  try { await data.slips.setMachineDisposal(n2, m2, "COLLECTED", "John"); } catch (e) { err = e.message; }
  check("disposal refused on a live machine", /Only a condemned machine/.test(err), true);

  // A rubbish state is refused rather than stored.
  err = "";
  try { await data.slips.setMachineState(n2, m2, "BANANA", "X"); } catch (e) { err = e.message; }
  check("invalid state refused", /Invalid machine state/.test(err), true);

  // ---- The whole slip at once ------------------------------------------------
  slip = await data.slips.createSlip({
    company: "TEST ALL", contact_name: "C", contact_number: "7",
    machines: [{ desc: "M1" }, { desc: "M2" }], signature: sig,
  });
  const n3 = slip.slip_number;
  check("nothing ticked: plain open slip", slip.status, "OPEN");
  slip = await data.slips.setAllMachineStates(n3, "AWAITING_QUOTE", "Iris");
  check("all sent for quoting", slip.machines.every((m) => m.state === "AWAITING_QUOTE"), true);
  check("slip says so", slip.status, "NEED_QUOTE");

  // A machine already billed is not dragged back by a slip-wide button.
  await data.slips.setAllMachineStates(n3, "TO_REPAIR", "Iris");
  await data.slips.setMachineLabour(slip.machines[0].id, 80);   // something to bill
  await data.slips.createSlipOrder(n3, [slip.machines[0].id]);
  slip = await data.slips.setAllMachineStates(n3, "AWAITING_QUOTE", "Iris");
  check("billed machine left alone", slip.machines[0].state, "TO_REPAIR");
  check("the other one moved", slip.machines[1].state, "AWAITING_QUOTE");

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("\nTHREW:", e); process.exit(1); });
