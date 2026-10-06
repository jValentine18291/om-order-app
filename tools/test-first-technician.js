// WHO IS TOLD TO GO AHEAD WITH A REPAIR.
// Run against a throwaway database, never the real one:
//
//   node tools/test-first-technician.js C:/temp/scratch.db
//
// John, 6 Oct 2026: when Sales confirm a repair, the technician who FIRST
// worked on the machine is told - in their own language, with who confirmed
// in brackets. Nobody recorded: every technician (an empty answer here).
// Checked: the earliest part or status step by a technician decides it; a
// part added by a non-technician (John at the counter) does not count; the
// message translates with and without the brackets.
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
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const part = (id, tech) => data.slips.addPartToMachine(id,
  { item_code: "WS7F", description: "Spark plug", unit_price: 4, quantity: 1, technician: tech });

(async () => {
  const s = await data.slips.createSlip({
    company: "FIRST TECH", contact_name: "A", contact_number: "1", signature: sig, created_by: "Carmen",
    machines: [{ desc: "A" }, { desc: "B" }, { desc: "C" }, { desc: "D" }],
  });
  const [a, b, c, d] = s.machines.map((m) => m.id);

  // A: 小刘 adds a part, then 文建 sends it for quoting - 小刘 was first.
  await part(a, "XL");
  await data.slips.setMachineState(s.slip_number, a, "AWAITING_QUOTE", "WJ");
  check("the first to add a part", data.slips.firstTechnicianForMachine(a), "XL");

  // B: no parts; 康民 sends it for quoting.
  await data.slips.setMachineState(s.slip_number, b, "AWAITING_QUOTE", "KM");
  check("the one who sent it for quoting", data.slips.firstTechnicianForMachine(b), "KM");

  // C: John scans a part at the counter first, then Ray works on it.
  await part(c, "J");
  await part(c, "R");
  check("a non-technician's part does not count", data.slips.firstTechnicianForMachine(c), "R");

  // D: nobody yet.
  check("nobody recorded: empty, so every technician is told", data.slips.firstTechnicianForMachine(d), "");

  console.log("\n-- the message, in Chinese --");
  check("with who confirmed",
    translate("00083 · BSG LANDSCAPE · the customer says go ahead with the repair (KS)", "zh"),
    "00083 · BSG LANDSCAPE · 客户同意维修（KS）");
  check("without",
    translate("00083 · BSG LANDSCAPE · the customer says go ahead with the repair", "zh"),
    "00083 · BSG LANDSCAPE · 客户同意维修");
  check("title", translate("Repair: HBZ260EZ - 1/2", "zh"), "可以维修：HBZ260EZ - 1/2");

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
