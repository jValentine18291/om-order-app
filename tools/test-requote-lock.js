// ONE QUOTE PER CHANGE.
// Run against a throwaway database, never the real one:
//
//   node tools/test-requote-lock.js C:/temp/scratch.db
//
// John, 6 Nov 2026. Once the customer has approved a machine's quote, "Send
// for quoting" stays greyed - and the server refuses it - until something the
// customer would pay for has changed: a part added or removed, a quantity, a
// price, or the labour. It holds through Repaired; nobody can override it.
//
// Checked: the lock after "Proceed with repair" and after "No quote needed";
// both ways in (the state change and the technician's Save) refused; each kind
// of change lifts it, and putting the change back restores it; it holds when
// Repaired; a machine never quoted is never locked; reopening for another
// repair clears it.
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
async function refused(what, fn) {
  try { await fn(); check(what, "allowed", "refused"); }
  catch (e) { check(what, e.status === 409 && /Quoted and approved/.test(e.message) ? "refused" : `${e.status} ${e.message}`, "refused"); }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  const s = await data.slips.createSlip({ company: "REQUOTE TEST", signature: sig,
    machines: [{ desc: "EBZ5100" }, { desc: "BK3410" }] });
  const no = s.slip_number, [a, b] = s.machines.map((m) => m.id);
  const machine = async (id) => (await data.slips.getSlip(no)).machines.find((m) => m.id === id);
  const locked = async (id) => !!(await machine(id)).requote_block;

  const filter = await data.slips.addPartToMachine(a, { item_code: "SZEN 585604902", description: "Air filter", unit_price: 18, quantity: 1 });
  await data.slips.addPartToMachine(a, { item_code: "SZEN 140051111", description: "Spark plug", unit_price: 9, quantity: 1 });
  await data.slips.setMachineLabour(a, 45);

  console.log("-- before anyone has approved anything --");
  await data.slips.setMachineState(no, a, "AWAITING_QUOTE", "WJ");
  check("sent for quoting, not locked", await locked(a), false);
  await data.slips.setMachineState(no, a, "QUOTED", "CY");
  check("quoted, waiting on the customer: not locked", await locked(a), false);

  console.log("\n-- Proceed with repair --");
  await data.slips.setMachineState(no, a, "TO_REPAIR", "CY");
  check("approved and unchanged: locked", await locked(a), true);
  await refused("Sales' Send for quoting is refused", () => data.slips.setMachineState(no, a, "AWAITING_QUOTE", "CY"));
  await refused("and so is the technician's Save - send for quotation", () => data.slips.saveMachineWork(a, "quote", "WJ"));
  check("and the machine has not moved", (await machine(a)).state, "TO_REPAIR");

  console.log("\n-- what lifts it, and what puts it back --");
  const plug = (await machine(a)).parts.find((p) => p.item_code === "SZEN 140051111");
  await data.slips.setPartQuantity(plug.id, 2);
  check("a quantity changed: unlocked", await locked(a), false);
  await data.slips.setPartQuantity(plug.id, 1);
  check("changed back: locked again - it is what was agreed", await locked(a), true);
  await data.slips.setPartPrice(filter.id || (await machine(a)).parts.find((p) => p.item_code === "SZEN 585604902").id, 20);
  check("a price changed: unlocked", await locked(a), false);
  await data.slips.setPartPrice((await machine(a)).parts.find((p) => p.item_code === "SZEN 585604902").id, 18);
  check("price back: locked", await locked(a), true);
  await data.slips.setMachineLabour(a, 60);
  check("the labour changed: unlocked", await locked(a), false);
  await data.slips.setMachineLabour(a, 45);
  check("labour back: locked", await locked(a), true);
  const carb = await data.slips.addPartToMachine(a, { item_code: "SZEN T115181001", description: "Carburettor", unit_price: 76.8, quantity: 1 });
  check("a part added: unlocked", await locked(a), false);
  await data.slips.setMachineState(no, a, "AWAITING_QUOTE", "WJ");
  check("so it can be sent again", (await machine(a)).state, "AWAITING_QUOTE");

  console.log("\n-- the second approval, and Repaired --");
  await data.slips.setMachineState(no, a, "TO_REPAIR", "CY");
  check("approved again, with the carburettor: locked", await locked(a), true);
  await data.slips.setMachineState(no, a, "REPAIRED", "WJ");
  check("still locked once Repaired", await locked(a), true);
  await refused("and Send for quoting from Repaired is refused", () => data.slips.setMachineState(no, a, "AWAITING_QUOTE", "CY"));

  console.log("\n-- No quote needed counts as an answer --");
  await data.slips.addPartToMachine(b, { item_code: "SZEN 585605001", description: "Air filter, urethane", unit_price: 6, quantity: 1 });
  await data.slips.setMachineState(no, b, "AWAITING_QUOTE", "WJ");
  await data.slips.setMachineState(no, b, "TO_REPAIR", "CY");
  check("locked", await locked(b), true);

  console.log("\n-- the slip-wide \"Need to Quote\" --");
  // It writes every unfinished machine at once, so it had its own way round
  // the rule. Machine a is Repaired (locked); b is In Progress (locked).
  await refused("with every machine approved and unchanged, it is refused",
    () => data.slips.setAllMachineStates(no, "AWAITING_QUOTE", "CY"));
  // A third machine, never quoted, on a slip with an approved one.
  const s3 = await data.slips.createSlip({ company: "MIXED", signature: sig, machines: [{ desc: "G3800" }, { desc: "HBZ260" }] });
  const [d1, d2] = s3.machines.map((m) => m.id);
  await data.slips.addPartToMachine(d1, { item_code: "SZEN 1", description: "Chain", unit_price: 30, quantity: 1 });
  await data.slips.addPartToMachine(d2, { item_code: "SZEN 2", description: "Filter", unit_price: 5, quantity: 1 });
  await data.slips.setMachineState(s3.slip_number, d1, "AWAITING_QUOTE", "WJ");
  await data.slips.setMachineState(s3.slip_number, d1, "TO_REPAIR", "CY");
  await data.slips.setAllMachineStates(s3.slip_number, "AWAITING_QUOTE", "CY");
  const after = (await data.slips.getSlip(s3.slip_number)).machines;
  check("quote all: the approved one is left alone, the other goes",
    after.map((m) => m.state), ["TO_REPAIR", "AWAITING_QUOTE"]);
  await data.slips.setAllMachineStates(s3.slip_number, "TO_REPAIR", "CY");
  check("slip-wide No quote needed records the approval, as one machine's would",
    !!(await data.slips.getSlip(s3.slip_number)).machines[1].requote_block, true);

  console.log("\n-- never quoted: never locked --");
  const s2 = await data.slips.createSlip({ company: "NO QUOTE", signature: sig, machines: [{ desc: "HBZ260" }] });
  const c = s2.machines[0].id;
  await data.slips.addPartToMachine(c, { item_code: "SZEN 577901801", description: "Gasket kit", unit_price: 12, quantity: 1 });
  await data.slips.setMachineState(s2.slip_number, c, "TO_REPAIR", "WJ");
  check("In Progress straight from the bench, no quote: free to send",
    !!(await data.slips.getSlip(s2.slip_number)).machines[0].requote_block, false);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
