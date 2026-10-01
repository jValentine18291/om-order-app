// TECHNICIANS MAY GIVE THE CUSTOMER'S ANSWER.
// No database needed; the scratch path is accepted and ignored so the usual
// runner can call it like every other test:
//
//   node tools/test-tech-answer.js C:/temp/scratch.db
//
// John, 1 Oct 2026: technicians ring customers themselves, often skipping the
// formal quotation. "Proceed with repair" (from waiting-to-quote or quoted)
// and "Too expensive - condemn" (from anything not finished) are now theirs
// too; every other decision stays with Sales and Admin. Sales are notified,
// in each phone's language.
const path = require("path");
const { rolesForMachineMove } = require(path.resolve(__dirname, "..", "backend", "machine-roles.js"));
const { translate } = require(path.resolve(__dirname, "..", "backend", "notify-i18n.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const tech = (from, to) => { const r = rolesForMachineMove(from, to); return r === null || r.includes("tech"); };

console.log("-- the customer's answer: technicians may --");
check("proceed from waiting to quote", tech("AWAITING_QUOTE", "TO_REPAIR"), true);
check("proceed from quoted", tech("QUOTED", "TO_REPAIR"), true);
for (const from of ["RECEIVED", "AWAITING_QUOTE", "QUOTED", "TO_REPAIR"]) {
  check(`condemn from ${from}`, tech(from, "CONDEMNED"), true);
}

console.log("\n-- everything else: still Sales and Admin --");
check("mark repaired", tech("TO_REPAIR", "REPAIRED"), false);
check("not finished after all", tech("REPAIRED", "TO_REPAIR"), false);
check("repair it after all (un-condemn)", tech("CONDEMNED", "TO_REPAIR"), false);
check("mark as quoted", tech("AWAITING_QUOTE", "QUOTED"), false);
check("condemn a repaired machine", tech("REPAIRED", "CONDEMNED"), false);
check("Sales keep proceed", rolesForMachineMove("QUOTED", "TO_REPAIR").includes("sales"), true);
check("asking for a quote is anybody's", rolesForMachineMove("TO_REPAIR", "AWAITING_QUOTE"), null);

console.log("\n-- what Sales are told, in Chinese --");
check("title", translate("Proceed: HBZ260EZ", "zh"), "继续维修：HBZ260EZ");
check("proceed body",
  translate("00083 · BSG LANDSCAPE · WJ: customer agreed, repair going ahead", "zh"),
  "00083 · BSG LANDSCAPE · WJ：客户同意，继续维修");
check("condemn body",
  translate("00083 · BSG LANDSCAPE · WJ: customer says too expensive - condemned", "zh"),
  "00083 · BSG LANDSCAPE · WJ：客户嫌太贵，已报废");
check("English unchanged", translate("Proceed: HBZ260EZ", "en"), "Proceed: HBZ260EZ");

console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
process.exit(failures ? 1 : 0);
