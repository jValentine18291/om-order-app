// CLOSE SERVICE LEAVES OUT A SLIP STILL IN THE WORKSHOP.
// Run against a throwaway database, never the real one:
//
//   node tools/test-close-service-bench.js C:/temp/scratch.db
//
// John, 29 Oct 2026, slip 00239: the W80P 2/2 was billed, its DO recorded and
// the machine collected, so the slip was INVOICED and sat in Close Service -
// with the W80P 1/2 not yet touched, and nothing on it closable. His answers:
// keep such a slip on while one of its Sales Orders still waits for its DO/CS/
// INV number (00209 - sales record it there); the search goes by the same rule.
//
// Checked: one machine billed with its number and one on the bench is off the
// list and its search, and still on the technicians'; with the number still to
// record it is on, until it is recorded; once the last machine is finished it
// is back; a slip with every machine done is unchanged.
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
const make = (company, descs) => data.slips.createSlip({
  company, contact_name: "A", contact_number: "1", signature: sig,
  machines: descs.map((desc) => ({ desc })),
});
const inList = async (no, scope) => (await data.slips.listSlips(scope)).some((r) => r.slip_number === no);
const inSearch = async (no) => (await data.slips.searchSlips(no, "repaired", 20)).results.some((r) => r.slip_number === no);
// [Close Service list, Close Service search, technicians' list]
const where = async (no) => [await inList(no, "repaired"), await inSearch(no), await inList(no, "working")];

(async () => {
  console.log("-- 00239: one billed and collected, one not touched --");
  const a = await make("LEMON TEST", ["W80P - 1/2", "W80P - 2/2"]);
  const [a1, a2] = a.machines.map((m) => m.id);
  await data.slips.setMachineLabour(a2, 40);
  await data.slips.finishRepair(a2, "WJ");
  await data.slips.createSlipOrder(a.slip_number, [a2], "KS");
  check("SO waiting for its number: sales see it, to record it", await where(a.slip_number), [true, true, true]);
  let slip = await data.slips.setSlipInvoiced(a.slip_number, "DO-TEST-1", "KS");
  check("its number recorded, so the slip says INVOICED", slip.status, "INVOICED");
  check("and it leaves Close Service, list and search, but not the workshop",
    await where(a.slip_number), [false, false, true]);

  console.log("\n-- the last machine is finished --");
  await data.slips.setMachineLabour(a1, 40);
  await data.slips.finishRepair(a1, "WJ");
  check("back in Close Service, off the technicians' list", await where(a.slip_number), [true, true, false]);

  console.log("\n-- nothing else moves --");
  const b = await make("ALL DONE TEST", ["MS180"]);
  await data.slips.setMachineLabour(b.machines[0].id, 30);
  await data.slips.finishRepair(b.machines[0].id, "WJ");
  check("every machine repaired, nothing billed: Close Service as before", (await where(b.slip_number)).slice(0, 2), [true, true]);
  await data.slips.createSlipOrder(b.slip_number, [b.machines[0].id], "KS");
  await data.slips.setSlipInvoiced(b.slip_number, "DO-TEST-2", "KS");
  check("billed and invoiced: still there to close", (await where(b.slip_number)).slice(0, 2), [true, true]);
  const c = await make("UNTOUCHED TEST", ["T525"]);
  check("not started: not in Close Service", (await where(c.slip_number)).slice(0, 2), [false, false]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
