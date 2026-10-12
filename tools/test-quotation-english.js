// A REPAIR COMMENT IN CHINESE, ON THE QUOTATION. Run against a throwaway
// database:
//
//   node tools/test-quotation-english.js C:/temp/scratch.db
//
// John, 12 Oct 2026: technicians often write their comment in Chinese. Sales
// type the English on the Send Quotation sheet and the Quotation prints it;
// left empty, the comment is left off (its PDF cannot print Chinese). The
// Sales Order keeps the technician's own words. English typed for an older
// comment is flagged once the technician changes it.
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
const repo = require(path.resolve(__dirname, "..", "backend", "data", "sqliteRepo.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const CN = "太久没用，油桶油要放掉，不然main jet 会塞着";
const EN = "Not used for a long time. Drain the fuel tank, otherwise the main jet will clog.";
const stars = (lines) => lines.map((l) => l.description || "").filter((d) => d.startsWith("*"));

(async () => {
  const s = await data.slips.createSlip({ company: "TRANSLATE", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410 - 1/2" }, { desc: "HBZ260 - 2/2" }] });
  const [a, b] = s.machines.map((m) => m.id);
  await data.slips.setMachineLabour(a, 30);
  await data.slips.setMachineComment(a, CN);
  await data.slips.setMachineLabour(b, 20);
  await data.slips.setMachineComment(b, "Replaced spark plug");

  console.log("-- before any English is typed --");
  const q0 = repo.slips.quotationForSlip(s.slip_number);
  const ma = q0.machines_available.find((m) => m.id === a);
  const mb = q0.machines_available.find((m) => m.id === b);
  check("the Chinese one asks for English", [ma.comment_chinese, ma.comment, ma.comment_en], [true, CN, ""]);
  check("the English one does not", mb.comment_chinese, false);
  check("the quotation leaves the Chinese off, keeps the English one", stars(q0.lines), ["*Replaced spark plug"]);

  console.log("\n-- Sales type it on the sheet --");
  const q1 = repo.slips.issueQuotation(s.slip_number, { payment: "C.O.D", english: { [a]: EN } });
  check("the quotation prints the English", stars(q1.lines), [`*${EN}`, "*Replaced spark plug"]);
  const q2 = repo.slips.quotationForSlip(s.slip_number);
  check("kept for next time, not stale", [q2.machines_available.find((m) => m.id === a).comment_en,
    q2.machines_available.find((m) => m.id === a).comment_en_stale], [EN, false]);

  console.log("\n-- the Sales Order keeps the technician's words --");
  await data.slips.setMachineState(s.slip_number, a, "REPAIRED", "WJ");
  await data.slips.setMachineState(s.slip_number, b, "REPAIRED", "WJ");
  const so = await data.slips.createSlipOrder(s.slip_number, [a, b], "KS");
  check("SO comment lines", stars((await data.orders.getOrder(so.so_number)).lines), [`*${CN}`, "*Replaced spark plug"]);

  console.log("\n-- the technician changes the comment --");
  await data.slips.setMachineComment(a, CN + "，还要换火花塞");
  const q3 = repo.slips.quotationForSlip(s.slip_number);
  check("flagged for Sales to check", q3.machines_available.find((m) => m.id === a).comment_en_stale, true);
  repo.slips.issueQuotation(s.slip_number, { payment: "C.O.D", english: { [a]: EN + " Also replace the spark plug." } });
  check("sent again with new English: no longer flagged",
    repo.slips.quotationForSlip(s.slip_number).machines_available.find((m) => m.id === a).comment_en_stale, false);

  console.log("\n-- cleared: left off again; and never another slip's machine --");
  repo.slips.issueQuotation(s.slip_number, { payment: "C.O.D", english: { [a]: "" } });
  check("empty English: comment left off", stars(repo.slips.quotationForSlip(s.slip_number).lines), ["*Replaced spark plug"]);
  const t = await data.slips.createSlip({ company: "OTHER", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "M1" }] });
  await data.slips.setMachineLabour(t.machines[0].id, 10);
  repo.slips.issueQuotation(t.slip_number, { payment: "C.O.D", english: { [a]: "HIJACK" } });
  check("a machine on another slip is not written to",
    repo.slips.quotationForSlip(s.slip_number).machines_available.find((m) => m.id === a).comment_en, "");

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
