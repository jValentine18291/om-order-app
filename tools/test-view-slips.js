// VIEW SLIPS: EVERY SLIP, PHONE SEARCH, AND EACH MACHINE'S ACTIVITY.
// Run against a throwaway database, never the real one:
//
//   node tools/test-view-slips.js C:/temp/scratch.db
//
// John, 6 Oct 2026. Checked: the View Slips list returns every slip (its
// chips filter on the client); a customer's phone finds their slip however
// it was spaced; a slip carries each machine's history, oldest first.
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
  for (let i = 0; i < 24; i++) {
    await data.slips.createSlip({ company: `VIEW ${i}`, contact_name: "A", contact_number: `8000 00${String(i).padStart(2, "0")}`,
      signature: sig, machines: [{ desc: "MS180", serial: "" }] });
  }
  const t = await data.slips.createSlip({
    company: "PHONE TEST", contact_name: "Mr Tan", contact_number: "9123 4567", contact2_number: "8765 4321",
    signature: sig, created_by: "Carmen", machines: [{ desc: "EBZ5100", serial: "" }],
  });

  console.log("-- every slip --");
  const all = await data.slips.searchSlips("", "all", 20);
  check("all 25 listed", [all.results.length, all.hasMore], [25, false]);

  console.log("\n-- by phone, however it was spaced --");
  const find = async (q) => (await data.slips.searchSlips(q, "all", 20)).results.map((r) => r.slip_number);
  check("typed without the space", await find("91234567"), [t.slip_number]);
  check("part of it", await find("4567"), [t.slip_number]);
  check("the second contact", await find("87654321"), [t.slip_number]);

  console.log("\n-- each machine's activity --");
  const id = t.machines[0].id;
  await data.slips.setMachineState(t.slip_number, id, "AWAITING_QUOTE", "WJ");
  await data.slips.setMachineState(t.slip_number, id, "QUOTED", "KS");
  const m = (await data.slips.getSlip(t.slip_number)).machines[0];
  check("oldest first, with who", m.history.map((h) => `${h.from_value}>${h.to_value}:${h.who}`),
    [">RECEIVED:Carmen", "RECEIVED>AWAITING_QUOTE:WJ", "AWAITING_QUOTE>QUOTED:KS"]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
