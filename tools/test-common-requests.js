// What the customer asked for at the counter, and who puts a slip on the
// Need to Quote list.
//
//   node tools/test-common-requests.js C:/temp/scratch.db
//
// The rule this guards: registering a slip must never mark a machine
// AWAITING_QUOTE. It used to, so a slip landed on Sales' quote list the moment
// it was written - before a technician had opened anything, with no parts and
// no labour to quote. A machine reaches that list when a technician sends it.
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

// A 1x1 PNG. The signature is mandatory; its content is not what is under test.
const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const make = (extra) => data.slips.createSlip({
  company: "Test Co", contact_name: "A", contact_number: "1",
  signature: SIG,
  machines: [{ desc: "Husqvarna 365", serial: "SN1" }, { desc: "Zenoah G3800", serial: "SN2" }],
  ...extra,
});

const onQuoteList = (n) =>
  data.slips.listSlips("need_quote").some((s) => s.slip_number === n);

// ---- the customer asked for a quote at the counter --------------------------
const a = make({ quote_first: true, check_service: true });
check("the request is recorded on the slip", a.quote_first, 1);
check("Check & Service is recorded too", a.check_service, 1);
check("no machine is marked awaiting quote", a.machines.map((m) => m.state), ["RECEIVED", "RECEIVED"]);
check("the slip is simply Open", a.status, "OPEN");
check("and it is NOT on the quote list yet", onQuoteList(a.slip_number), false);

// ---- the technician assesses one and sends it -------------------------------
data.slips.setMachineState(a.slip_number, a.machines[0].id, "AWAITING_QUOTE", "WJ");
const a2 = data.slips.getSlip(a.slip_number);
check("now the slip needs a quote", a2.status, "NEED_QUOTE");
check("and now it IS on the quote list", onQuoteList(a.slip_number), true);

// ---- repair only ------------------------------------------------------------
const b = make({ repair_only: true });
check("repair only is recorded", b.repair_only, 1);
check("a slip with no quote request is Open", b.status, "OPEN");
check("and is not on the quote list", onQuoteList(b.slip_number), false);

// Opposites: "service everything but service nothing" is not a request.
const c = make({ check_service: true, repair_only: true });
check("repair only wins over check & service", [c.check_service, c.repair_only], [0, 1]);

// ---- nothing ticked ---------------------------------------------------------
const d = make({});
check("no request is the default", [d.check_service, d.repair_only, d.quote_first], [0, 0, 0]);

// ---- a phone still running the app from before this change ------------------
// It sends the tick per machine and knows nothing about quote_first.
const e = make({ machines: [{ desc: "Victa 18", serial: "SN9", quote: true }] });
check("an old client's per-machine tick becomes the slip's request", e.quote_first, 1);
check("but still does not pre-empt the technician", e.machines.map((m) => m.state), ["RECEIVED"]);
check("so it is not on the quote list either", onQuoteList(e.slip_number), false);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
