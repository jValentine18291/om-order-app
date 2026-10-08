// REOPENING A MACHINE FOR ANOTHER REPAIR. Run against a throwaway database:
//
//   node tools/test-reopen-machine.js C:/temp/scratch.db
//
// John, 8 Oct 2026: a customer came to collect a machine already on an SO and
// a DO, and it had another fault. Sales or John reopen it; it goes back to the
// workshop on the same line with its parts, labour and comment still on it and
// editable, and the new SO carries the first repair and the second together -
// Sales move that whole SO to a new DO. The old SO and DO are left as they are.
// A closed slip is not reopened: a machine back after that starts a new slip.
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
const { translate } = require(path.resolve(__dirname, "..", "backend", "notify-i18n.js"));

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
const part = (code, price, tech) => ({ item_code: code, description: `Part ${code}`, unit_price: price, quantity: 1, technician: tech });

(async () => {
  console.log("-- repaired, on an SO, invoiced, collected - then found with another fault --");
  const s = await data.slips.createSlip({ company: "COMEBACK", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "525BX - 1/2" }, { desc: "HBZ260 - 2/2" }] });
  const [a, b] = s.machines.map((m) => m.id);
  await data.slips.addPartToMachine(a, part("P-OLD", 40, "WJ"));
  await data.slips.setMachineLabour(a, 30);
  await data.slips.setMachineComment(a, "Cleaned carb");
  await data.slips.setMachineState(s.slip_number, a, "REPAIRED", "WJ");
  await data.slips.addPartToMachine(b, part("P-B", 10, "XL"));
  await data.slips.setMachineState(s.slip_number, b, "REPAIRED", "XL");
  const so1 = await data.slips.createSlipOrder(s.slip_number, [a, b], "KS");
  await data.slips.setSlipInvoiced(s.slip_number, "DO-1", "KS");
  await data.slips.setMachineDisposal(s.slip_number, a, "COLLECTED", "KS");

  const before = (await data.slips.getSlip(s.slip_number)).machines.find((m) => m.id === a);
  check("it can be reopened", before.reopen_block, "");
  await refused("not with a state other than In Progress / Waiting to quote",
    () => data.slips.reopenMachine(s.slip_number, a, { state: "REPAIRED", who: "KS" }), /In Progress or Waiting to quote/);

  const after = await data.slips.reopenMachine(s.slip_number, a, { state: "TO_REPAIR", note: "Hard to start when hot", who: "KS" });
  const m = after.machines.find((x) => x.id === a);
  check("back in the workshop", m.state, "TO_REPAIR");
  check("off its SO", [m.converted_at || "", m.so_number], ["", ""]);
  check("no longer collected", m.disposal, "");
  check("its parts are still on it", m.parts.map((p) => p.item_code), ["P-OLD"]);
  check("and its labour and comment", [m.labour_charge, m.repair_comment], [30, "Cleaned carb"]);
  check("the reopening is recorded, with the old SO and DO", m.rounds.map((r) => [r.round, r.so_number, r.closing_ref, r.reopened_by, r.reopen_note]),
    [[1, so1.so_number, "DO-1", "KS", "Hard to start when hot"]]);
  check("the slip is no longer Invoice Created", after.status !== "INVOICED", true);
  check("the old order is left as it is", (await data.orders.getOrder(so1.so_number)).closing_ref, "DO-1");
  check("the other machine is untouched", after.machines.find((x) => x.id === b).so_number, so1.so_number);
  check("the trail says it was reopened, and why",
    m.history.filter((h) => h.field === "reopen").map((h) => h.note), ["Hard to start when hot"]);
  check("the first technician is still the one told", data.slips.firstTechnicianForMachine(a), "WJ");
  await refused("not twice while it is being worked on",
    () => data.slips.reopenMachine(s.slip_number, a, { who: "KS" }), /Only a repaired machine/);

  console.log("\n-- the second repair, and the new SO carrying both --");
  await data.slips.addPartToMachine(a, part("P-NEW", 25, "WJ"));
  await data.slips.setMachineState(s.slip_number, a, "REPAIRED", "WJ");
  const so2 = await data.slips.createSlipOrder(s.slip_number, [a], "KS");
  const lines = (await data.orders.getOrder(so2.so_number)).lines;
  const codes = lines.map((l) => l.item_code).filter((c) => c && c.startsWith("P-"));
  check("old and new parts both on the new SO", codes, ["P-OLD", "P-NEW"]);
  check("the labour too", lines.some((l) => Number(l.unit_price) === 30), true);
  check("waiting on its DO: SO Created", (await data.slips.getSlip(s.slip_number)).status, "CONVERTED");
  await data.slips.setSlipInvoiced(s.slip_number, "DO-2", "KS", so2.so_number);
  check("numbered: Invoice Created", (await data.slips.getSlip(s.slip_number)).status, "INVOICED");
  await data.slips.setMachineDisposal(s.slip_number, a, "COLLECTED", "KS");
  await data.slips.setMachineDisposal(s.slip_number, b, "COLLECTED", "KS");
  await data.slips.closeSlip(s.slip_number, "DO-2", "KS");
  check("and it closes", (await data.slips.getSlip(s.slip_number)).status, "CLOSED");
  await refused("a closed slip is not reopened",
    () => data.slips.reopenMachine(s.slip_number, a, { who: "KS" }), /closed/i);

  console.log("\n-- reopened to be quoted first; never for one not yet on an SO --");
  const t = await data.slips.createSlip({ company: "QUOTE FIRST", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "M1" }] });
  const [c] = t.machines.map((x) => x.id);
  await data.slips.setMachineLabour(c, 20);
  await data.slips.setMachineState(t.slip_number, c, "REPAIRED", "WJ");
  await refused("not on an SO yet", () => data.slips.reopenMachine(t.slip_number, c, { who: "KS" }), /not on a Sales Order/);
  check("so the button is not offered", (await data.slips.getSlip(t.slip_number)).machines[0].reopen_block !== "", true);
  await data.slips.createSlipOrder(t.slip_number, [c], "KS");
  const q = await data.slips.reopenMachine(t.slip_number, c, { state: "AWAITING_QUOTE", who: "KS" });
  check("on Sales' list to quote", q.machines[0].state, "AWAITING_QUOTE");
  check("an SO with no DO yet still reads its SO", q.machines[0].rounds[0].closing_ref, "");

  console.log("\n-- the technician's notification, in Chinese --");
  check("title", translate("Reopened: 525BX - 1/2", "zh"), "再次维修：525BX - 1/2");
  check("with the fault and who", translate("00001 · COMEBACK · reopened for another repair: Hard to start when hot (KS)", "zh"),
    "00001 · COMEBACK · 需要再次维修：Hard to start when hot（KS）");
  check("with neither", translate("00001 · COMEBACK · reopened for another repair", "zh"), "00001 · COMEBACK · 需要再次维修");

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
