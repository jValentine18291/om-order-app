// THE PAPER BOOKLET'S SLIP NUMBER ("Physical SS").
// Run against a throwaway database, never the real one:
//
//   node tools/test-physical-ss.js C:/temp/scratch.db
//
// John, 1 Oct 2026: slips are written in the booklet as well, and staff quote
// both numbers. Optional, numbers only, typed at registration and editable
// later; printed on the Sales Order ONLY, ahead of the app's number -
// "S/S: 37016 / 00095" - and searchable.
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
// createSlipOrder returns a summary; the lines are read back off the order.
const machineLine = async (slipNumber) =>
  ((await data.slips.getSlipOrder(slipNumber)).lines || []).find((l) => /S\/S:/.test(l.description || "")).description;

async function billedSlip(company, physical_ss) {
  const s = await data.slips.createSlip({
    company, contact_name: "A", contact_number: "1", signature: sig, physical_ss,
    machines: [{ desc: "EBZ5100", serial: "2025280" }],
  });
  const id = s.machines[0].id;
  await data.slips.setMachineLabour(id, 30);
  await data.slips.setMachineState(s.slip_number, id, "REPAIRED", "WJ");
  return { s, id };
}

(async () => {
  console.log("-- registered with the booklet number --");
  const a = await billedSlip("PHYSICAL SS A", " 37016 ");
  check("stored, spaces trimmed", (await data.slips.getSlip(a.s.slip_number)).physical_ss, "37016");
  const q = data.slips.quotationForSlip(a.s.slip_number);
  check("NOT on the quotation", JSON.stringify(q.lines).includes("37016"), false);
  const so = await data.slips.createSlipOrder(a.s.slip_number, [a.id], "KS");
  check("on the Sales Order, ahead of the app's number",
    / S\/S: 37016 \/ \d{5}/.test(await machineLine(a.s.slip_number)), true);
  console.log("        " + await machineLine(a.s.slip_number));
  // Orders are found by their "S/S: <slip>" note; finding it proves the link
  // note did not take on the booklet number.
  check("the order is still found by its link note",
    (await data.slips.getSlipOrders(a.s.slip_number)).length, 1);

  console.log("\n-- registered without one: as before --");
  const b = await billedSlip("PHYSICAL SS B", "");
  const so2 = await data.slips.createSlipOrder(b.s.slip_number, [b.id], "KS");
  check("plain S/S", new RegExp(` S/S: ${b.s.slip_number} `).test(await machineLine(b.s.slip_number)), true);

  console.log("\n-- numbers only --");
  await refuse("letters refused at registration", () => data.slips.createSlip({
    company: "BAD", contact_name: "A", contact_number: "1", signature: sig, physical_ss: "37O16",
    machines: [{ desc: "MS180", serial: "" }],
  }), /numbers only/);

  console.log("\n-- added later, from Edit slip --");
  const c = await billedSlip("PHYSICAL SS C", "");
  let edited = await data.slips.updateSlipDetails(c.s.slip_number, { physical_ss: "41022", who: "KS" });
  check("saved", edited.physical_ss, "41022");
  check("logged as an amendment",
    (await data.slips.getSlip(c.s.slip_number, true)).amendments.some((x) => x.field === "Physical SS" && x.after === "41022"), true);
  const so3 = await data.slips.createSlipOrder(c.s.slip_number, [c.id], "KS");
  check("and printed on the order made after", / S\/S: 41022 \//.test(await machineLine(c.s.slip_number)), true);
  edited = await data.slips.updateSlipDetails(c.s.slip_number, { contact_name: "B", who: "KS" });
  check("an edit that does not send it leaves it alone", edited.physical_ss, "41022");
  await refuse("letters refused in the edit too", () =>
    data.slips.updateSlipDetails(c.s.slip_number, { physical_ss: "41-022", who: "KS" }), /numbers only/);

  console.log("\n-- found by it --");
  const found = await data.slips.searchSlips("37016", "all", 20);
  check("search by the booklet number", found.results.map((r) => r.slip_number), [a.s.slip_number]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
