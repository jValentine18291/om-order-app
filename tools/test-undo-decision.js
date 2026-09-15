// Putting a machine's status back, for the decision nobody meant to make.
//
//   node tools/test-undo-decision.js C:/temp/scratch.db
//
// WHERE THIS CAME FROM
// Slip 00053, 15 Sep 2026. "Need to Quote" was pressed instead of the button
// beside it, then "Mark as Quoted" on top of that. Nothing had been done to
// the machine. Every action the app offered afterwards moved it FURTHER along
// - "Confirm Repair", "Send for quoting again" - so the only way back was to
// reach into the database by hand.
//
// THE RULE THIS GUARDS
// The undo exists only while there is nothing to lose. A status is somebody's
// record of a decision; the moment a technician has acted on it - a part
// scanned, labour charged, a comment written, an order raised - putting the
// status back would be rewriting what happened rather than correcting a
// mis-tap. So it refuses, and says what is in the way.
//
// The refusal is the half worth testing. A button that does the right thing
// when everything is fine and the wrong thing under pressure is worse than no
// button, because somebody will trust it.
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
async function refuses(what, fn, wantStatus, wantIn) {
  let status = "no error", msg = "";
  try { await fn(); } catch (e) { status = e.status || 0; msg = e.message || ""; }
  check(what, status, wantStatus);
  if (wantIn) check(`  and says what is in the way ("${wantIn}")`, msg.includes(wantIn), true);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// A fresh slip with one untouched machine, so each case starts from the same
// place the mis-tap started from.
async function freshMachine(company) {
  const slip = await data.slips.createSlip({
    company, machines: [{ desc: "EBZ4800", serial: "", remarks: "No power" }], signature: sig,
  });
  return { no: slip.slip_number, id: slip.machines[0].id };
}
const stateOf = async (no) => (await data.slips.getSlip(no)).machines[0].state;
const canUndo = async (no) => (await data.slips.getSlip(no)).machines[0].can_undo;

(async () => {
  console.log("-- slip 00053, exactly as it happened --");
  const a = await freshMachine("CHANG SENG SERVICES PTE LTD");
  check("registered, nothing decided", await stateOf(a.no), "RECEIVED");
  check("and the slip is Open", (await data.slips.getSlip(a.no)).status, "OPEN");

  // The two clicks.
  await data.slips.setMachineState(a.no, a.id, "AWAITING_QUOTE", "CY");
  check("after \u201cNeed to Quote\u201d, the slip is on Sales' list",
    (await data.slips.getSlip(a.no)).status, "NEED_QUOTE");
  await data.slips.setMachineState(a.no, a.id, "QUOTED", "CY");
  check("after \u201cMark as Quoted\u201d", (await data.slips.getSlip(a.no)).status, "QUOTED");

  // The way back that did not exist.
  check("the app offers to put it back", await canUndo(a.no), true);
  const back = await data.slips.undoMachineDecision(a.no, a.id, "JT");
  check("the machine is where it started", back.machines[0].state, "RECEIVED");
  check("and so is the slip", back.status, "OPEN");
  check("with who did it recorded", back.machines[0].decided_by, "JT");
  check("and nothing left to undo", await canUndo(a.no), false);

  console.log("\n-- it works from every state a mis-tap can reach --");
  for (const st of ["AWAITING_QUOTE", "QUOTED", "TO_REPAIR", "REPAIRED", "CONDEMNED"]) {
    const m = await freshMachine(`FROM ${st} PTE LTD`);
    await data.slips.setMachineState(m.no, m.id, st, "CY");
    await data.slips.undoMachineDecision(m.no, m.id, "JT");
    check(`from ${st}`, await stateOf(m.no), "RECEIVED");
  }

  console.log("\n-- a condemned machine loses its disposal with it --");
  // It is staying after all, so how it was going to leave means nothing. The
  // same rule setMachineState follows when a machine stops being condemned.
  const c = await freshMachine("CONDEMNED THEN NOT PTE LTD");
  await data.slips.setMachineState(c.no, c.id, "CONDEMNED", "CY");
  await data.slips.setMachineDisposal(c.no, c.id, "COLLECTED", "CY");
  check("the disposal is on it", (await data.slips.getSlip(c.no)).machines[0].disposal, "COLLECTED");
  // A disposal IS something recorded, so it has to be taken off first - the
  // undo will not quietly discard a fact about where a machine went.
  await refuses("and it will not be discarded quietly",
    () => data.slips.undoMachineDecision(c.no, c.id, "JT"), 409, "a disposal");

  console.log("\n-- what it refuses, which is the point --");

  const p = await freshMachine("HAS A PART PTE LTD");
  await data.slips.setMachineState(p.no, p.id, "QUOTED", "CY");
  await data.slips.addPartToMachine(p.id, {
    item_code: "A8 SPARE PARTS", description: "Impeller", uom: "PC",
    unit_price: 22.50, quantity: 1, technician: "KS" });
  check("a machine with a part is not offered it", await canUndo(p.no), false);
  await refuses("and refuses if asked anyway",
    () => data.slips.undoMachineDecision(p.no, p.id, "JT"), 409, "1 part");
  check("and the status is untouched", await stateOf(p.no), "QUOTED");

  const l = await freshMachine("HAS LABOUR PTE LTD");
  await data.slips.setMachineState(l.no, l.id, "QUOTED", "CY");
  await data.slips.setMachineLabour(l.id, 45);
  check("labour counts as work", await canUndo(l.no), false);
  await refuses("and says so", () => data.slips.undoMachineDecision(l.no, l.id, "JT"),
    409, "a labour charge");

  const r = await freshMachine("HAS A COMMENT PTE LTD");
  await data.slips.setMachineState(r.no, r.id, "QUOTED", "CY");
  await data.slips.setMachineComment(r.id, "Stripped down, piston scored");
  check("so does a repair comment", await canUndo(r.no), false);
  await refuses("and says so", () => data.slips.undoMachineDecision(r.no, r.id, "JT"),
    409, "a repair comment");

  const o = await freshMachine("ON AN ORDER PTE LTD");
  await data.slips.setMachineState(o.no, o.id, "TO_REPAIR", "CY");
  await data.slips.setMachineLabour(o.id, 30);
  await data.slips.createSlipOrder(o.no, [o.id]);
  check("a machine already on a Sales Order is not offered it", await canUndo(o.no), false);
  await refuses("and refuses, naming the order",
    () => data.slips.undoMachineDecision(o.no, o.id, "JT"), 409, "a Sales Order");

  console.log("\n-- and the ordinary refusals --");
  const n = await freshMachine("NOTHING TO UNDO PTE LTD");
  await refuses("a machine nobody has decided anything about",
    () => data.slips.undoMachineDecision(n.no, n.id, "JT"), 409, "Nothing has been decided");
  await refuses("a machine that is not on this slip",
    () => data.slips.undoMachineDecision(n.no, 999999, "JT"), 404);
  await refuses("a slip that does not exist",
    () => data.slips.undoMachineDecision("99999", n.id, "JT"), 404);

  // Closed comes from machineOnSlip, the same guard every other machine action
  // uses - a finished record is a finished record.
  const d = await freshMachine("FINISHED PTE LTD");
  await data.slips.setMachineLabour(d.id, 30);
  await data.slips.createSlipOrder(d.no, [d.id]);
  await data.slips.setSlipInvoiced(d.no, "INV-9101", "JT");
  await data.slips.closeSlip(d.no, "DO-9101", "JT");
  await refuses("a closed slip",
    () => data.slips.undoMachineDecision(d.no, d.id, "JT"), 400);

  console.log("\n-- one machine going back does not move the others --");
  // The slip's status is worked out from ALL its machines, so putting one back
  // must not drag the rest with it.
  const slip = await data.slips.createSlip({
    company: "TWO MACHINES PTE LTD",
    machines: [{ desc: "EBZ4800" }, { desc: "HB2302" }],
    signature: sig,
  });
  const [m1, m2] = slip.machines;
  await data.slips.setMachineState(slip.slip_number, m1.id, "QUOTED", "CY");
  await data.slips.setMachineState(slip.slip_number, m2.id, "AWAITING_QUOTE", "CY");
  const after = await data.slips.undoMachineDecision(slip.slip_number, m1.id, "JT");
  check("the mis-tapped one is back",
    after.machines.find((m) => m.id === m1.id).state, "RECEIVED");
  check("the other one has not moved",
    after.machines.find((m) => m.id === m2.id).state, "AWAITING_QUOTE");
  check("and the slip still says Sales have to ring about it", after.status, "NEED_QUOTE");

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
