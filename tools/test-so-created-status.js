// "REPAIRED – SO CREATED": A MACHINE ON A SALES ORDER SAYS SO.
// Run against a throwaway database, never the real one:
//
//   node tools/test-so-created-status.js C:/temp/scratch.db
//
// John, 4 Nov 2026. Slip 00239: the technicians could not tell a machine
// already billed from one still waiting for its Sales Order - both read
// "Repaired", and the Activity stopped at "Marked repaired". Now:
//
//   Repaired  ->  Repaired – SO Created  ->  Repaired – With Customer
//
// and the Activity carries the step, with the SO number and who did it.
//
// A READING, NOT A STATE (his call): underneath, the machine stays REPAIRED
// or CONDEMNED, so every rule that asks for those - closing, Close Service,
// the AutoCount transfer - is untouched. The first block checks exactly that.
const fs = require("fs");
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

// The app's own label code, lifted out of app.js rather than copied, so this
// tests what the phones run.
const app = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
const from = app.indexOf("const MACHINE_STATE = {");
const to = app.indexOf("\n}\n", app.indexOf("function machinePill(")) + 2;
const L = new Function("escapeHtml", app.slice(from, to) +
  "\nreturn { machineStatus, machinePill, onSalesOrder };")((s) => String(s));

const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  const slip = await data.slips.createSlip({ company: "W80P TEST PTE LTD", signature: sig,
    machines: [{ desc: "W80P - 1/2" }, { desc: "W80P - 2/2" }, { desc: "Old mower" }] });
  const [a, b, c] = slip.machines;
  for (const m of [a, b, c]) await data.slips.setMachineLabour(m.id, 25);
  await data.slips.setMachineState(slip.slip_number, a.id, "REPAIRED", "XL");
  await data.slips.setMachineState(slip.slip_number, c.id, "CONDEMNED", "XL");

  console.log("-- before the Sales Order --");
  let s = await data.slips.getSlip(slip.slip_number);
  const m1 = () => s.machines.find((m) => m.id === a.id);
  check("a repaired machine reads Repaired", L.machineStatus(m1()).label, "Repaired");

  await data.slips.createSlipOrder(slip.slip_number, [a.id, c.id], { who: "XL" });
  s = await data.slips.getSlip(slip.slip_number);
  const m3 = s.machines.find((m) => m.id === c.id);

  console.log("\n-- on the Sales Order --");
  check("it reads Repaired – SO Created", L.machineStatus(m1()).label, "Repaired – SO Created");
  check("in its own colour", L.machinePill(m1()).includes("mq-so"), true);
  check("a condemned one reads Condemned – SO Created",
    L.machineStatus(m3).label, "Condemned – SO Created");
  check("and still says whether it has gone",
    L.machinePill(m3).includes("Not yet collected"), true);
  check("the one not on it is untouched", L.machineStatus(s.machines.find((m) => m.id === b.id)).label, "Need Repair");

  console.log("\n-- underneath, nothing moved --");
  check("still stored as REPAIRED and CONDEMNED", [m1().state, m3.state], ["REPAIRED", "CONDEMNED"]);

  console.log("\n-- the Activity step --");
  const step = (m1().history || []).find((h) => h.field === "so");
  check("written when it went on", step && [step.from_value, step.to_value, step.who],
    ["REPAIRED", m1().so_number, "XL"]);
  const stepC = (m3.history || []).find((h) => h.field === "so");
  check("the condemned one's says it was condemned", stepC && stepC.from_value, "CONDEMNED");
  check("after Marked repaired, in order",
    m1().history.map((h) => h.field === "so" ? "so" : h.to_value), ["RECEIVED", "REPAIRED", "so"]);

  console.log("\n-- collected: the last step --");
  await data.slips.setMachineDisposal(slip.slip_number, a.id, "COLLECTED", "CY");
  s = await data.slips.getSlip(slip.slip_number);
  check("With Customer, as before", L.machineStatus(m1()).label, "Repaired – With Customer");

  console.log("\n-- an SO from before the step was kept --");
  const older = { state: "REPAIRED", converted_at: "2026-10-26 14:36:43", so_number: "SO-2610-127",
    history: [{ field: "state", from_value: "", to_value: "RECEIVED", who: "CY", changed_at: "2026-10-26 13:15:20" },
              { field: "state", from_value: "RECEIVED", to_value: "REPAIRED", who: "XL", changed_at: "2026-10-26 14:36:37" }] };
  check("reads SO Created all the same", L.machineStatus(older).label, "Repaired – SO Created");
  const vs = new Function("escapeHtml", "formatDate", "CONDEMN_REASON_LABEL", "MACHINE_STATE_X",
    app.slice(from, to) + "\n" +
    app.slice(app.indexOf("function vsStepLabel("), app.indexOf("\n}\n", app.indexOf("function vsActivityHtml(")) + 2) +
    "\nreturn vsActivityHtml;")((x) => String(x), (t) => String(t).slice(0, 10), {}, null);
  const html = vs(older);
  check("its Activity shows the step, with the SO number",
    /Repaired – SO Created<\/span> <span class="vs-step-who mono">· SO-2610-127/.test(html), true);
  check("and, honestly, nobody's name", /SO-2610-127<\/span> <span class="vs-step-who">/.test(html), false);
  check("placed at the time it was billed, above Marked repaired",
    html.indexOf("SO Created") < html.indexOf("Marked repaired"), true);

  console.log("\n-- the request says who --");
  check("the app sends the initials with the Sales Order",
    /body: JSON\.stringify\(\{ machine_ids: chosen, extras: wantExtras, who: initialsFor\(getUser\(\)\) \}\)/.test(app), true);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
