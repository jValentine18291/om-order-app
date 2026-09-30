// CLOSED SLIPS: EVERY MACHINE ON THEM IS WITH THE CUSTOMER.
// Run against a throwaway database, never the real one:
//
//   node tools/test-closed-backfill.js C:/temp/scratch.db
//
// John, 1 Oct 2026. Slips closed before 30 Sep never had their machines'
// collection recorded, so a repaired machine on a "Collected & Closed" slip
// still read "Repaired" - 29 of them on the live book, slip 00015 among them.
// Four more were billed and closed while their status never reached Repaired
// at all. backfillClosedSlips() puts both right, dated and signed with the
// slip's own closing. This recreates both legacy shapes and checks it, and
// that it leaves alone everything it should.
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
const repo = require(path.resolve(__dirname, "..", "backend", "data", "sqliteRepo.js"));
const db = require(path.resolve(__dirname, "..", "backend", "db"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const m = (no, i = 0) => data.slips.getSlip(no).machines[i];

// A slip taken all the way to Closed, the ordinary way.
async function closedSlip(company, n = 1) {
  const s = await data.slips.createSlip({
    company, contact_name: "A", contact_number: "1", signature: sig,
    machines: Array.from({ length: n }, (_, i) => ({ desc: `EBZ5100 - ${i + 1}/${n}`, serial: `S${i}` })),
  });
  const ids = s.machines.map((x) => x.id);
  for (const id of ids) { await data.slips.setMachineLabour(id, 30); await data.slips.saveMachineWork(id, "repaired", "WJ"); }
  await data.slips.createSlipOrder(s.slip_number, ids, "KS");
  await data.slips.setSlipInvoiced(s.slip_number, "INV-1", "KS");
  await data.slips.closeSlip(s.slip_number, "INV-1", "J");
  // Backdate the close, so "dated with the slip's own closing" is tested
  // against a date that is not today.
  db.prepare("UPDATE service_slips SET closed_at = '2026-09-15 16:40:01' WHERE slip_number = ?").run(s.slip_number);
  return s.slip_number;
}

(async () => {
  console.log("-- a slip closed before 30 Sep: repaired, but no collection recorded --");
  const a = await closedSlip("CLOSED BEFORE PTE LTD");
  // What closing did not record back then.
  db.prepare("UPDATE slip_machines SET disposal = '', disposal_by = '', disposal_at = '' WHERE id = ?").run(m(a).id);
  check("reads Repaired with nothing collected, as 00015 did", [m(a).state, m(a).disposal], ["REPAIRED", ""]);

  console.log("\n-- a billed machine on a closed slip that never reached Repaired --");
  const b = await closedSlip("STUCK PTE LTD", 2);
  db.prepare("UPDATE slip_machines SET state = 'RECEIVED', disposal = '' WHERE id = ?").run(m(b, 0).id);
  db.prepare("UPDATE slip_machines SET state = 'AWAITING_QUOTE', disposal = '' WHERE id = ?").run(m(b, 1).id);

  console.log("\n-- and the ones it must leave alone --");
  // Open: the customer has not necessarily collected anything.
  const open = await data.slips.createSlip({
    company: "STILL OPEN PTE LTD", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410", serial: "O1" }],
  });
  await data.slips.setMachineLabour(open.machines[0].id, 30);
  await data.slips.saveMachineWork(open.machines[0].id, "repaired", "WJ");
  await data.slips.createSlipOrder(open.slip_number, [open.machines[0].id], "KS");
  // Condemned and disposed of, on a closed slip: never "collected".
  const c = await data.slips.createSlip({
    company: "SCRAPPED PTE LTD", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "HB2302", serial: "D1" }],
  });
  await data.slips.setMachineState(c.slip_number, c.machines[0].id, "CONDEMNED", "KS");
  await data.slips.setCondemnSignature(c.slip_number, c.machines[0].id, { image: sig, who: "KS" });
  await data.slips.setMachineDisposal(c.slip_number, c.machines[0].id, "DISPOSED", "KS");
  await data.slips.closeSlip(c.slip_number, "", "J");

  console.log("\n-- the fix --");
  const r = repo.backfillClosedSlips();
  check("two set to Repaired, three marked collected", r, { repaired: 2, collected: 3 });

  check("00015's shape now reads Repaired - With Customer", [m(a).state, m(a).disposal], ["REPAIRED", "COLLECTED"]);
  check("  dated when the slip closed", m(a).disposal_at, "2026-09-15 16:40:01");
  check("  by whoever closed it", m(a).disposal_by, "J");
  check("the stuck ones are Repaired and collected",
    [0, 1].map((i) => [m(b, i).state, m(b, i).disposal]), [["REPAIRED", "COLLECTED"], ["REPAIRED", "COLLECTED"]]);
  check("the open slip's machine is untouched", m(open.slip_number).disposal, "");
  check("the scrapped machine is still disposed of", [m(c.slip_number).state, m(c.slip_number).disposal], ["CONDEMNED", "DISPOSED"]);

  console.log("\n-- and it is safe to run again --");
  check("the second run finds nothing", repo.backfillClosedSlips(), { repaired: 0, collected: 0 });

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
