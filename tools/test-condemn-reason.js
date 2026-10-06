// WHY A MACHINE WAS CONDEMNED.
// Run against a throwaway database, never the real one:
//
//   node tools/test-condemn-reason.js C:/temp/scratch.db
//
// John, 6 Oct 2026: condemning asks for an optional reason - a quick one
// (Too expensive / Beyond repair / Something else) and a note. Checked: both
// are kept, and neither is required; an unknown reason is dropped; the quick
// reason prints on the Sales Order and the note does not; repairing it after
// all clears them; the trail records the reason with the condemning.
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
const db = require(path.resolve(__dirname, "..", "backend", "db"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const soNote = async (no) => ((await data.slips.getSlipOrder(no)).lines || [])
  .filter((l) => /^\*Condemned/.test(l.description || "")).map((l) => l.description);

(async () => {
  const s = await data.slips.createSlip({
    company: "REASON TEST", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410 - 1/3" }, { desc: "EBZ5100 - 2/3" }, { desc: "MS180 - 3/3" }],
  });
  const [a, b, c] = s.machines.map((m) => m.id);
  const machine = async (id) => (await data.slips.getSlip(s.slip_number)).machines.find((m) => m.id === id);

  console.log("-- kept, and optional --");
  await data.slips.setMachineState(s.slip_number, a, "CONDEMNED", "WJ",
    { reason: "too_expensive", note: "Customer declined the $380 quote" });
  let m = await machine(a);
  check("quick reason and note", [m.condemn_reason, m.condemn_note], ["TOO_EXPENSIVE", "Customer declined the $380 quote"]);
  await data.slips.setMachineState(s.slip_number, b, "CONDEMNED", "KS");
  m = await machine(b);
  check("nothing given is fine", [m.state, m.condemn_reason, m.condemn_note], ["CONDEMNED", "", ""]);
  await data.slips.setMachineState(s.slip_number, c, "CONDEMNED", "KS", { reason: "BROKEN", note: "x" });
  m = await machine(c);
  check("an unknown reason is dropped, the note kept", [m.condemn_reason, m.condemn_note], ["", "x"]);

  console.log("\n-- the trail --");
  const h = db.prepare("SELECT note FROM machine_status_history WHERE machine_id = ? AND to_value = 'CONDEMNED'").get(a);
  check("the reason rides with the condemning", h.note, "TOO_EXPENSIVE|Customer declined the $380 quote");

  console.log("\n-- repaired after all --");
  await data.slips.setMachineState(s.slip_number, c, "TO_REPAIR", "KS");
  m = await machine(c);
  check("reason and note cleared", [m.condemn_reason, m.condemn_note], ["", ""]);

  console.log("\n-- the Sales Order --");
  await data.slips.setMachineState(s.slip_number, b, "TO_REPAIR", "KS");
  await data.slips.setMachineState(s.slip_number, b, "CONDEMNED", "KS", { reason: "BEYOND_REPAIR", note: "internal only" });
  await data.slips.setMachineLabour(c, 20);
  await data.slips.setMachineState(s.slip_number, c, "REPAIRED", "WJ");
  await data.slips.createSlipOrder(s.slip_number, [a, b, c], "KS");
  const notes = await soNote(s.slip_number);
  check("each condemned machine's quick reason", notes,
    ["*Condemned - too expensive to repair", "*Condemned - beyond repair"]);
  check("the typed note never reaches it", notes.some((n) => /380|internal/.test(n)), false);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
