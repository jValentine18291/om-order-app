// test-condemn-signature.js
// ============================================================================
// The customer signs, in person, that a machine is beyond repair.
//
// John's ask, 25 Sep 2026: "we would like to create another signature to be
// registered for machines that have been condemned. The customer will come in
// person to sign, which confirms that they want to condemn it."
//
// SEPARATE FROM THE SLIP'S SIGNATURE, which is them accepting the terms when
// they drop the machine off. This is a second decision, taken later, about one
// machine. What this pins down:
//
//   1. Only a CONDEMNED machine can be signed for.
//   2. The signature is recorded, and signing again replaces it.
//   3. A slip cannot close while a condemned machine is unsigned.
//   4. Un-condemning a machine throws the signature away - by either route,
//      the ordinary one and the correction one.
//   5. The image never rides on the slip; only the fact that it exists.
//
// Usage: node test-condemn-signature.js C:/temp/scratch.db

const path = require("path");

const dbPath = process.argv[2];
if (!dbPath) {
  console.log(`Give a scratch database path, e.g. node ${path.basename(__filename)} C:/temp/scratch.db`);
  process.exit(1);
}
process.env.OM_DB_PATH = dbPath;

const repo = require("../backend/data/sqliteRepo").slips;

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${name}`);
}
function refuses(name, fn, contains) {
  try {
    fn(); failures++; console.log(`  FAIL ${name} — it was allowed`);
  } catch (e) {
    const hit = String(e.message).includes(contains);
    if (!hit) { failures++; console.log(`  FAIL ${name}\n       message was: ${e.message}\n       expected it to mention: ${contains}`); }
    else console.log(`  ok   ${name}`);
  }
}

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const CUST = "data:image/png;base64,QQQQQQQQQQQQQQQQQQQQ==";
const CUST2 = "data:image/png;base64,ZZZZZZZZZZZZZZZZZZZZ==";

console.log("\nThe customer signs for a condemned machine\n");

const slip = repo.createSlip({
  company: "GREENSCAPE PTE LTD", contact_name: "Mr Tan",
  machines: [{ desc: "EBZ5100 Blower", serial: "A1" }, { desc: "EBZ8500 Blower", serial: "B2" }],
  signature: SIG, created_by: "KM",
});
const no = slip.slip_number;
let ms = repo.getSlip(no).machines;
const [a, b] = [ms[0].id, ms[1].id];

// ---- 1. only a condemned machine ------------------------------------------
refuses("a machine that is not condemned cannot be signed for",
  () => repo.setCondemnSignature(no, a, { image: CUST, who: "KS" }),
  "not condemned");

repo.setMachineState(no, a, "CONDEMNED", "Iris");
check("nothing signed yet", repo.getSlip(no).machines[0].has_condemn_signature, false);

// ---- 2. recorded, and replaceable ------------------------------------------
refuses("an empty signature is refused",
  () => repo.setCondemnSignature(no, a, { image: "   ", who: "KS" }), "signature is required");

repo.setCondemnSignature(no, a, { image: CUST, who: "KS" });
check("signed", repo.getSlip(no).machines[0].has_condemn_signature, true);
check("the image is fetched on its own", repo.getCondemnSignature(no, a).image, CUST);
check("and who held the phone", repo.getCondemnSignature(no, a).signed_by, "KS");

repo.setCondemnSignature(no, a, { image: CUST2, who: "SH" });
check("signing again replaces it", repo.getCondemnSignature(no, a).image, CUST2);
check("and is still one signature", repo.getSlip(no).machines.filter((m) => m.has_condemn_signature).length, 1);

// ---- 5. the image never rides on the slip ----------------------------------
check("the slip carries the fact, not the picture",
  repo.getSlip(no).machines[0].image, undefined);

// ---- 3. closing waits for it -----------------------------------------------
repo.setMachineState(no, b, "CONDEMNED", "Iris");
refuses("a slip with an unsigned condemned machine will not close",
  () => repo.closeSlip(no, "", "KS"), "Condemned but not signed for: EBZ8500 Blower");

repo.setCondemnSignature(no, b, { image: CUST, who: "KS" });
// Now it is the DISPOSAL question that stands in the way, not the signature -
// which is the point: they sign that it is beyond repair, and only then does
// where it goes mean anything.
refuses("signed, so now it asks where the machines went",
  () => repo.closeSlip(no, "", "KS"), "not yet accounted for");

// ---- 4. un-condemning throws it away ---------------------------------------
repo.setMachineState(no, a, "TO_REPAIR", "Iris");
check("repairing it after all drops the signature",
  repo.getSlip(no).machines[0].has_condemn_signature, false);
check("and the image is gone", repo.getCondemnSignature(no, a).image, "");

// the correction route has to do the same
repo.setMachineState(no, a, "CONDEMNED", "Iris");
repo.setCondemnSignature(no, a, { image: CUST, who: "KS" });
check("signed again", repo.getSlip(no).machines[0].has_condemn_signature, true);
repo.correctMachine(no, a, { state: "TO_REPAIR", who: "john" });
check("a correction drops it too", repo.getSlip(no).machines[0].has_condemn_signature, false);

console.log(failures ? `\n${failures} FAILED\n` : "\nAll good.\n");
process.exit(failures ? 1 : 0);
