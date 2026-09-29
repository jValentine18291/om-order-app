// A CONDEMNED MACHINE THAT IS ALREADY ON A SALES ORDER.
// Run against a throwaway database, never the real one:
//
//   node tools/test-condemned-accounting.js C:/temp/scratch.db
//
// Its own file, beside test-condemned-on-order.js: that one is about getting a
// condemned machine ONTO the order at nothing, this one is about what is still
// owed on it afterwards.
//
// Slip 00007, found 29 Sep 2026. Two of its machines were condemned and then
// put on SO-2609-007 at nothing, which is how a condemned machine leaves the
// building. The slip then sat at Invoice Created from 9 Sep with nothing in
// the app able to move it, because closing needs two things from every
// condemned machine - the customer's signature, and where it went - and the
// screens hid both the moment the machine was billed.
//
// John found it from the other end: "slip 00007 doesn't have any buttons to
// state that the customer has already collected the two condemned units."
//
// This walks that exact shape. The screens are fixed in app.js; what is
// checked here is the half underneath - that the server accepts both on a
// billed machine, and that the slip can then close. If the server ever starts
// refusing them, no button anywhere will help.
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

(async () => {
  console.log("-- slip 00007's shape: two condemned, two repaired, all on one order --");
  let slip = await data.slips.createSlip({
    company: "BSG LANDSCAPE", contact_name: "A", contact_number: "1",
    machines: [
      { desc: "Zenoah BK3410 - 1/4", serial: "Z1", remarks: "" },
      { desc: "Zenoah BK3410 - 2/4", serial: "Z2", remarks: "" },
      { desc: "Zenoah BK3410 - 3/4", serial: "Z3", remarks: "" },
      { desc: "Zenoah BK3410 - 4/4", serial: "Z4", remarks: "" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const ids = slip.machines.map((m) => m.id);
  for (const id of ids) await data.slips.setMachineLabour(id, 40);
  for (const id of ids.slice(2)) await data.slips.finishRepair(id, "WJ");
  for (const id of ids.slice(0, 2)) await data.slips.setMachineState(no, id, "CONDEMNED", "KS");

  // All four on one order - the condemned ones at nothing, which is how they
  // leave the building.
  const order = await data.slips.createSlipOrder(no, ids, "KS");
  slip = await data.slips.getSlip(no);
  check("every machine is billed", (slip.machines || []).every((m) => !!m.converted_at), true);
  check("two of them are condemned",
    (slip.machines || []).filter((m) => m.state === "CONDEMNED").length, 2);

  console.log("\n-- and the slip cannot close, which is the state John found it in --");
  await data.slips.setSlipInvoiced(no, "DO-2609-104", "KS");
  await refuse("it wants the signatures first",
    () => data.slips.closeSlip(no, "DO-2609-104", "KS"), /Condemned but not signed for/);

  console.log("\n-- being on an order does not stop the customer signing --");
  // This is the half the screens were hiding. If the server refused it too,
  // there would be no way out of slip 00007 at all.
  for (const id of ids.slice(0, 2)) {
    await data.slips.setCondemnSignature(no, id, { image: sig, who: "KS" });
  }
  slip = await data.slips.getSlip(no);
  check("both are signed for",
    (slip.machines || []).filter((m) => m.has_condemn_signature).length, 2);

  console.log("\n-- nor from saying where the machine went --");
  await refuse("it now wants that instead",
    () => data.slips.closeSlip(no, "DO-2609-104", "KS"), /not yet accounted for/);
  for (const id of ids.slice(0, 2)) {
    await data.slips.setMachineDisposal(no, id, "COLLECTED", "KS");
  }
  slip = await data.slips.getSlip(no);
  check("the customer took both",
    (slip.machines || []).filter((m) => m.disposal === "COLLECTED").length, 2);

  console.log("\n-- and then it closes --");
  slip = await data.slips.closeSlip(no, "DO-2609-104", "KS");
  check("closed", slip.status, "CLOSED");
  check("with the number it was invoiced on", slip.closing_ref, "DO-2609-104");

  console.log("\n-- a closed slip is a finished record --");
  await refuse("no more signatures",
    () => data.slips.setCondemnSignature(no, ids[0], { image: sig, who: "KS" }),
    /already closed/);
  await refuse("and no more disposals",
    () => data.slips.setMachineDisposal(no, ids[0], "DISPOSED", "KS"), /already closed/);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
