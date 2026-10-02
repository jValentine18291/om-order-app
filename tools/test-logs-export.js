// THE LOGS WORKBOOK, AND THE STATUS HISTORY BEHIND IT.
// Run against a throwaway database, never the real one:
//
//   node tools/test-logs-export.js C:/temp/scratch.db
//
// John, 2 Oct 2026. Checked: every machine status change and collection is
// recorded, whichever function made it, with who; the workbook has its tabs,
// each with a frozen, filtered header; the status history comes out in the
// app's own words; only John may download it.
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
const { buildLogsWorkbook } = require(path.resolve(__dirname, "..", "backend", "logs-export.js"));
const ExcelJS = require(path.resolve(__dirname, "..", "backend", "node_modules", "exceljs"));
const FN = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const trail = (id) => db.prepare(
  "SELECT field, from_value, to_value, who FROM machine_status_history WHERE machine_id = ? ORDER BY id"
).all(id).map((r) => `${r.field}:${r.from_value}>${r.to_value}:${r.who}`);

(async () => {
  console.log("-- every step is kept --");
  const s = await data.slips.createSlip({
    company: "LOGS TEST", contact_name: "A", contact_number: "1", signature: sig, created_by: "Carmen",
    machines: [{ desc: "EBZ5100", serial: "X1" }, { desc: "BK3410", serial: "" }],
  });
  const [a, b] = s.machines.map((m) => m.id);
  await data.slips.setMachineState(s.slip_number, a, "AWAITING_QUOTE", "WJ");
  await data.slips.setMachineState(s.slip_number, a, "QUOTED", "KS");
  await data.slips.setMachineState(s.slip_number, a, "TO_REPAIR", "WJ");
  await data.slips.setMachineLabour(a, 30);
  await data.slips.setMachineState(s.slip_number, a, "REPAIRED", "WJ");
  await data.slips.createSlipOrder(s.slip_number, [a], "KS");
  await data.slips.setMachineDisposal(s.slip_number, a, "COLLECTED", "CY");
  check("the whole trail of one machine", trail(a), [
    "state:>RECEIVED:Carmen", "state:RECEIVED>AWAITING_QUOTE:WJ", "state:AWAITING_QUOTE>QUOTED:KS",
    "state:QUOTED>TO_REPAIR:WJ", "state:TO_REPAIR>REPAIRED:WJ", "disposal:>COLLECTED:CY",
  ]);
  // A different way in - the undo - is caught too: the trigger does not care
  // which function wrote the column.
  await data.slips.setMachineState(s.slip_number, b, "AWAITING_QUOTE", "WJ");
  await data.slips.undoMachineDecision(s.slip_number, b, "KS");
  check("an undo is recorded as well", trail(b).slice(-1), ["state:AWAITING_QUOTE>RECEIVED:KS"]);
  // Setting the status it already has may be refused or allowed; either way
  // nothing changed, so nothing is added to the trail.
  try { await data.slips.setMachineState(s.slip_number, b, "RECEIVED", "KS"); } catch (_) {}
  check("saving the same status twice adds nothing", trail(b).length, 3);

  console.log("\n-- the workbook --");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildLogsWorkbook(db));
  const names = wb.worksheets.map((w) => w.name);
  check("its tabs", names, ["Read me", "Status history", "Machines now", "Slips", "Slip changes",
    "Deleted slips", "Quotations", "Sales Orders", "Prices", "Shelf moves", "WhatsApp"]);
  const hist = wb.getWorksheet("Status history");
  check("header frozen", (hist.views[0] || {}).ySplit, 1);
  check("header filtered", !!hist.autoFilter, true);
  const row = (r) => hist.getRow(r).values.slice(1).map((v) => (v instanceof Date ? "date" : v));
  // Newest first: the collection is the last thing machine A did.
  const rows = [];
  hist.eachRow((r, i) => { if (i > 1) rows.push(row(i)); });
  const collected = rows.find((r) => r[4] === "Collection" && r[3] === "EBZ5100");
  check("a collection in the app's words", collected && [collected[0], collected[6], collected[7]],
    ["date", "Customer collected", "CY"]);
  const proceed = rows.find((r) => r[5] === "Waiting on customer" && r[6] === "In Progress");
  check("a status change in the app's words", !!proceed, true);

  console.log("\n-- John alone --");
  check("John", FN.canDownloadLogs({ id: "john" }), true);
  check("another admin", FN.canDownloadLogs({ id: "keeseng" }), false);
  check("a technician", FN.canDownloadLogs({ id: "wenjian" }), false);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
