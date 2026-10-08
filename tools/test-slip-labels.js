// SLIP LABELS: every label a slip's machines earn, in John's priority order.
// Run against a throwaway database, never the real one:
//
//   node tools/test-slip-labels.js C:/temp/scratch.db
//
// John, 8 Oct 2026: a slip with one machine on an SO and another waiting to be
// quoted should say both, as one half-half pill, and be found under both
// chips. This builds slips of each shape, reads them back the way the two
// lists do (the slip search) and the way the windows do (the whole slip), and
// runs the REAL slipLabels / slipLabelPill out of app.js on both.
const fs = require("fs");
const vm = require("vm");
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

// The labels' code, from the const that starts it to the chip filters after.
const src = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
const start = src.indexOf("const SLIP_LABELS = [");
const end = src.indexOf("\n// One chip per label", start);
if (start < 0 || end < 0) throw new Error("slip label code not found in app.js");
const escapeHtml = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sandbox = { escapeHtml, escapeAttr: escapeHtml, STATUS_LABEL: { CLOSED: "Collected & Closed" }, window: {} };
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end) + "\nthis.slipLabels = slipLabels; this.slipLabelPill = slipLabelPill; this.slipLabelEdge = slipLabelEdge;", sandbox);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
async function slip(company, n) {
  const machines = Array.from({ length: n }, (_, i) => ({ desc: `M${i + 1} - ${i + 1}/${n}` }));
  const s = await data.slips.createSlip({ company, contact_name: "A", contact_number: "1", signature: sig, machines });
  return { no: s.slip_number, ids: s.machines.map((m) => m.id) };
}
async function repaired(no, id) {
  await data.slips.setMachineLabour(id, 30);
  await data.slips.setMachineState(no, id, "REPAIRED", "WJ");
}
// Both readings must agree: the list row and the window header.
async function labels(no) {
  const row = (await data.slips.searchSlips(no, "all")).results.find((r) => r.slip_number === no);
  const whole = await data.slips.getSlip(no);
  const a = sandbox.slipLabels(row), b = sandbox.slipLabels(whole);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failures++;
    console.log(` FAIL  ${no}: the list says ${JSON.stringify(a)}, the window ${JSON.stringify(b)}`);
  }
  return a;
}

(async () => {
  console.log("-- John's example: one machine on an SO, one waiting to be quoted --");
  const a = await slip("TWO LABELS", 2);
  await repaired(a.no, a.ids[0]);
  await data.slips.createSlipOrder(a.no, [a.ids[0]], "KS");
  await data.slips.setMachineState(a.no, a.ids[1], "AWAITING_QUOTE", "WJ");
  check("quote first, then SO", await labels(a.no), ["quote", "so"]);
  const pill = sandbox.slipLabelPill((await data.slips.searchSlips(a.no, "all")).results[0]);
  check("one pill, both halves in short words", (pill.match(/class="sl-part"/g) || []).length === 2 && />Quote</.test(pill) && />SO</.test(pill), true);
  check("edge split in the two colours", sandbox.slipLabelEdge((await data.slips.searchSlips(a.no, "all")).results[0]), "--sl1:#A85B00;--sl2:#1B7A42");
  await data.slips.setSlipInvoiced(a.no, "DO-1", "KS");
  check("its order numbered: Invoice Created", await labels(a.no), ["quote", "inv"]);

  console.log("\n-- ready to bill, waiting on the customer, not started --");
  const b = await slip("THREE LABELS", 3);
  await repaired(b.no, b.ids[0]);
  await data.slips.setMachineState(b.no, b.ids[1], "AWAITING_QUOTE", "WJ");
  await data.slips.setMachineState(b.no, b.ids[1], "QUOTED", "KS");
  check("bill, customer, new", await labels(b.no), ["bill", "cust", "new"]);
  const pill3 = sandbox.slipLabelPill((await data.slips.searchSlips(b.no, "all")).results[0]);
  check("three labels: top two and +1", />Bill</.test(pill3) && />Customer</.test(pill3) && /\+1</.test(pill3), true);

  console.log("\n-- one label: full words --");
  const c = await slip("UNTOUCHED", 1);
  check("not started", await labels(c.no), ["new"]);
  check("in full", />Not started</.test(sandbox.slipLabelPill((await data.slips.searchSlips(c.no, "all")).results[0])), true);
  await data.slips.setMachineLabour(c.ids[0], 20);
  check("work written on it: In Progress", await labels(c.no), ["work"]);

  console.log("\n-- condemned, then disposed of --");
  const d = await slip("CONDEMNED", 1);
  await data.slips.setMachineState(d.no, d.ids[0], "CONDEMNED", "WJ");
  check("to settle", await labels(d.no), ["cond"]);
  await data.slips.setMachineDisposal(d.no, d.ids[0], "DISPOSED", "KS");
  check("every machine gone: ready to close", await labels(d.no), ["close"]);

  console.log("\n-- invoiced, collected one at a time --");
  const e = await slip("COLLECTING", 2);
  await repaired(e.no, e.ids[0]); await repaired(e.no, e.ids[1]);
  await data.slips.createSlipOrder(e.no, e.ids, "KS");
  check("on the SO", await labels(e.no), ["so"]);
  await data.slips.setSlipInvoiced(e.no, "INV-1", "KS");
  await data.slips.setMachineDisposal(e.no, e.ids[0], "COLLECTED", "KS");
  check("one collected: Invoice Created for the other", await labels(e.no), ["inv"]);
  await data.slips.setMachineDisposal(e.no, e.ids[1], "COLLECTED", "KS");
  check("both collected: ready to close", await labels(e.no), ["close"]);
  await data.slips.closeSlip(e.no, "INV-1", "KS");
  check("closed: no label, its status shows", await labels(e.no), []);
  check("the plain Closed pill", /sr-CLOSED/.test(sandbox.slipLabelPill(await data.slips.getSlip(e.no))), true);

  console.log("\n-- collected but its order still has no number --");
  const f = await slip("UNNUMBERED", 1);
  await repaired(f.no, f.ids[0]);
  await data.slips.createSlipOrder(f.no, [f.ids[0]], "KS");
  await data.slips.setMachineDisposal(f.no, f.ids[0], "COLLECTED", "KS");
  check("still SO Created, not ready to close", await labels(f.no), ["so"]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
