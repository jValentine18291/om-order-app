// A CONDEMNED MACHINE NEED NOT GO ON A SALES ORDER.
// Run against a throwaway database, never the real one:
//
//   node tools/test-condemned-no-so.js C:/temp/scratch.db
//
// John, 1 Oct 2026: condemned machines do not always need an SO. Slip 00103
// (one BK3410, condemned and signed, no order) could not close: "Customer
// collected" demanded a Sales Order first. His answers: the customer's
// signature is still required at close; a slip of condemned machines with
// nothing billed reads "Ready to close", not "SO Created".
//
// Checked: a condemned machine with no order can be collected or disposed of;
// the slip then reads Ready to close, sits in Close Service and not on the
// technicians' list, and closes with no DO/CS/INV number; an unsigned one is
// still refused at close; a REPAIRED machine still needs its order to be
// collected; a mixed slip still needs the DO number for the part that was billed.
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
const refuse = async (what, fn, re) => {
  let err = "";
  try { await fn(); } catch (e) { err = e.message; }
  const ok = re.test(err);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(err)}`);
};
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const inScope = async (scope, no) =>
  (await data.slips.searchSlips(no, scope, 20)).results.some((r) => r.slip_number === no);

async function condemnedSlip(company, { sign = true } = {}) {
  const s = await data.slips.createSlip({
    company, contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410", serial: "" }],
  });
  const id = s.machines[0].id;
  await data.slips.setMachineState(s.slip_number, id, "CONDEMNED", "JT");
  if (sign) await data.slips.setCondemnSignature(s.slip_number, id, { image: sig, who: "JT" });
  return { no: s.slip_number, id };
}

(async () => {
  console.log("-- 00103's shape: condemned, signed, no order, the customer takes it --");
  const a = await condemnedSlip("CONDEMNED COLLECTED");
  check("before: In Progress", (await data.slips.getSlip(a.no)).status, "IN_PROGRESS");
  check("already in Close Service", await inScope("repaired", a.no), true);
  let slip = await data.slips.setMachineDisposal(a.no, a.id, "COLLECTED", "CY");
  check("collected with no Sales Order", slip.machines[0].disposal, "COLLECTED");
  check("reads Ready to close, not SO Created", slip.status, "READY_TO_CLOSE");
  check("still in Close Service", await inScope("repaired", a.no), true);
  check("off the technicians' list", await inScope("working", a.no), false);
  slip = await data.slips.closeSlip(a.no, "", "KS");
  check("closes with no DO/CS/INV number", [slip.status, slip.closing_ref], ["CLOSED", ""]);

  console.log("\n-- the same, disposed of --");
  const b = await condemnedSlip("CONDEMNED DISPOSED");
  slip = await data.slips.setMachineDisposal(b.no, b.id, "DISPOSED", "CY");
  check("reads Ready to close", slip.status, "READY_TO_CLOSE");
  check("and closes", (await data.slips.closeSlip(b.no, "", "KS")).status, "CLOSED");

  console.log("\n-- not signed: the signature is still required --");
  const c = await condemnedSlip("CONDEMNED UNSIGNED", { sign: false });
  await data.slips.setMachineDisposal(c.no, c.id, "COLLECTED", "CY");
  await refuse("close refuses until it is signed", () => data.slips.closeSlip(c.no, "", "KS"), /not signed for/);
  await data.slips.setCondemnSignature(c.no, c.id, { image: sig, who: "JT" });
  check("and closes once signed", (await data.slips.closeSlip(c.no, "", "KS")).status, "CLOSED");

  console.log("\n-- not signed, but WE disposed of it: no signature needed --");
  // John, 1 Oct 2026: the customer signs when they take it away.
  const d = await condemnedSlip("CONDEMNED DISPOSED UNSIGNED", { sign: false });
  await refuse("still refused while nobody has said where it went",
    () => data.slips.closeSlip(d.no, "", "KS"), /not signed for/);
  await data.slips.setMachineDisposal(d.no, d.id, "DISPOSED", "CY");
  check("disposed of: closes without a signature", (await data.slips.closeSlip(d.no, "", "KS")).status, "CLOSED");

  console.log("\n-- a repaired machine still needs its order --");
  const r = await data.slips.createSlip({
    company: "REPAIRED NO SO", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "MS180", serial: "" }],
  });
  await data.slips.setMachineLabour(r.machines[0].id, 20);
  await data.slips.setMachineState(r.slip_number, r.machines[0].id, "REPAIRED", "WJ");
  await refuse("collecting it is refused", () =>
    data.slips.setMachineDisposal(r.slip_number, r.machines[0].id, "COLLECTED", "CY"), /Sales Order first/);

  console.log("\n-- mixed: one repaired and billed, one condemned with no order --");
  const m = await data.slips.createSlip({
    company: "MIXED", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "MS180 - 1/2", serial: "" }, { desc: "BK3410 - 2/2", serial: "" }],
  });
  const [rep, con] = m.machines.map((x) => x.id);
  await data.slips.setMachineLabour(rep, 20);
  await data.slips.setMachineState(m.slip_number, rep, "REPAIRED", "WJ");
  await data.slips.setMachineState(m.slip_number, con, "CONDEMNED", "JT");
  await data.slips.setCondemnSignature(m.slip_number, con, { image: sig, who: "JT" });
  await data.slips.createSlipOrder(m.slip_number, [rep], "KS");
  slip = await data.slips.setMachineDisposal(m.slip_number, con, "COLLECTED", "CY");
  check("the condemned one is collected off-order", slip.machines.find((x) => x.id === con).disposal, "COLLECTED");
  check("the slip reads SO Created - something was billed", slip.status, "CONVERTED");
  await refuse("the billed part still needs its DO number", () =>
    data.slips.closeSlip(m.slip_number, "", "KS"), /DO\/CS\/INV/);
  await data.slips.setSlipInvoiced(m.slip_number, "DO-2610-0001", "KS");
  check("and closes once it has one", (await data.slips.closeSlip(m.slip_number, "", "KS")).status, "CLOSED");

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
