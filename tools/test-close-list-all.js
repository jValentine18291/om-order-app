// CLOSE SERVICE LISTS EVERY SLIP WAITING TO BE CLOSED.
// Run against a throwaway database, never the real one:
//
//   node tools/test-close-list-all.js C:/temp/scratch.db
//
// John, 1 Oct 2026: the list stopped at the newest twenty, which hid twenty-two
// of forty-two on the live book - the oldest, and so the ones most needing a
// chase. Checked: twenty-five billed slips all come back, newest first, with
// nothing said about "more"; the other lists keep their cap of twenty.
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
  const made = [];
  for (let i = 0; i < 25; i++) {
    const s = await data.slips.createSlip({
      company: `Close List ${i}`, contact_name: "A", contact_number: "1", signature: sig,
      machines: [{ desc: "MS180", serial: "" }],
    });
    const id = s.machines[0].id;
    await data.slips.setMachineLabour(id, 10);
    await data.slips.setMachineState(s.slip_number, id, "REPAIRED", "WJ");
    await data.slips.createSlipOrder(s.slip_number, [id], "KS");
    made.push(s.slip_number);
  }
  // Five more nobody has touched: in "all", never in Close Service.
  for (let i = 0; i < 5; i++) {
    await data.slips.createSlip({
      company: `Not Ready ${i}`, contact_name: "A", contact_number: "1", signature: sig,
      machines: [{ desc: "MS180", serial: "" }],
    });
  }

  const close = await data.slips.searchSlips("", "repaired", 20);
  check("every billed slip is listed", close.results.length, 25);
  check("and nothing is held back", close.hasMore, false);
  check("newest first", close.results.map((r) => r.slip_number), made.slice().reverse());
  check("rows carry the date the SO was made", close.results.every((r) => r.machines.some((m) => m.converted_at)), true);

  const typed = await data.slips.searchSlips("Close List", "repaired", 20);
  check("typing still searches all of them", typed.results.length, 25);

  const all = await data.slips.searchSlips("", "all", 20);
  check("View Service keeps its cap", [all.results.length, all.hasMore], [20, true]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
