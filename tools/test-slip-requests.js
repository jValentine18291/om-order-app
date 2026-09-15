// Changing what the customer asked for, after the slip is written.
//
//   node tools/test-slip-requests.js C:/temp/scratch.db
//
// WHY THIS EXISTS
// "Check & Service for all", "Repair only" and "Quote First" are recorded at
// the counter, and customers change their mind afterwards - "actually, quote
// me first" is a phone call, not a new slip. Until now the three could only be
// set at registration.
//
// THE TWO RULES
//  1. Check & Service and Repair only are opposites. A slip asking for both
//     tells the technician nothing, and the form clearing one is not enough on
//     its own: phones run a cached copy of the app for a shift after a deploy,
//     so the server has to hold the rule too.
//  2. undefined means "the client did not send this", NOT "clear it". An edit
//     saved from an older phone must not silently untick all three.
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
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// The three, as they stand on the slip. 1/0 out of SQLite, read as yes/no.
const asks = (s) => [!!s.check_service, !!s.repair_only, !!s.quote_first];

async function fresh(company, opts) {
  return data.slips.createSlip(Object.assign({
    company, machines: [{ desc: "EBZ5100", serial: "", remarks: "no start" }], signature: sig,
  }, opts || {}));
}

(async () => {
  console.log("-- the customer rings back and wants a quote after all --");
  const s = await fresh("CHANGED THEIR MIND PTE LTD", { check_service: true });
  check("registered asking for a check & service", asks(s), [true, false, false]);

  let after = await data.slips.updateSlipDetails(s.slip_number, {
    check_service: true, repair_only: false, quote_first: true, who: "JT",
  });
  check("and now wants quoting first too", asks(after), [true, false, true]);

  console.log("\n-- and it is recorded on a slip they signed --");
  let rows = (await data.slips.getSlip(s.slip_number, true)).amendments || [];
  check("one line, named the way the tickbox is",
    rows.map((a) => [a.field, a.before, a.after]), [["Quote First", "No", "Yes"]]);
  check("with who changed it", rows[0].changed_by, "JT");

  console.log("\n-- and they can change it back --");
  after = await data.slips.updateSlipDetails(s.slip_number, {
    check_service: true, repair_only: false, quote_first: false, who: "JT",
  });
  check("un-ticked", asks(after), [true, false, false]);
  rows = (await data.slips.getSlip(s.slip_number, true)).amendments || [];
  check("and that is a second line, not an edit of the first",
    rows.map((a) => [a.field, a.before, a.after]),
    [["Quote First", "No", "Yes"], ["Quote First", "Yes", "No"]]);

  console.log("\n-- nothing moved means nothing logged --");
  await data.slips.updateSlipDetails(s.slip_number, {
    check_service: true, repair_only: false, quote_first: false, who: "JT",
  });
  check("still two lines",
    ((await data.slips.getSlip(s.slip_number, true)).amendments || []).length, 2);

  console.log("\n-- the two opposites --");
  // "Service everything, but do not service anything" is not a request. The
  // form clears one; this is the server holding the same line.
  const a = await fresh("BOTH AT ONCE PTE LTD", { check_service: true });
  const both = await data.slips.updateSlipDetails(a.slip_number, {
    check_service: true, repair_only: true, who: "JT",
  });
  check("sent both, with Repair only the one just turned on, it wins",
    asks(both), [false, true, false]);

  const b = await fresh("THE OTHER WAY PTE LTD", { repair_only: true });
  const both2 = await data.slips.updateSlipDetails(b.slip_number, {
    check_service: true, repair_only: true, who: "JT",
  });
  check("and the other way round, Check & Service does",
    asks(both2), [true, false, false]);

  console.log("\n-- and switching between them logs both halves --");
  const sw = await fresh("SWITCHED PTE LTD", { check_service: true });
  await data.slips.updateSlipDetails(sw.slip_number, {
    check_service: false, repair_only: true, who: "JT",
  });
  check("off one, on the other",
    ((await data.slips.getSlip(sw.slip_number, true)).amendments || [])
      .map((x) => `${x.field}: ${x.before} -> ${x.after}`),
    ["Check & Service for all: Yes -> No", "Repair only: No -> Yes"]);

  console.log("\n-- an older phone does not wipe them --");
  // The failure this guards: a phone running a cached copy from before these
  // tickboxes existed saves a name correction, sends no flags at all, and
  // silently unticks everything the customer asked for.
  const old = await fresh("OLD PHONE PTE LTD", { check_service: true, quote_first: true });
  const kept = await data.slips.updateSlipDetails(old.slip_number, {
    company: "OLD PHONE PTE LTD", notes: "corrected a typo", who: "JT",
  });
  check("all three are left exactly as they were", asks(kept), [true, false, true]);
  check("and only the note is logged",
    ((await data.slips.getSlip(old.slip_number, true)).amendments || []).map((x) => x.field),
    ["Notes"]);

  console.log("\n-- what the technician is shown follows it --");
  // The slip is what the technician's screen reads, so a customer who rings
  // back has to reach the bench. Nothing derived, nothing cached - one field.
  const t = await fresh("TECH SEES IT PTE LTD");
  check("registered with nothing asked for", asks(t), [false, false, false]);
  await data.slips.updateSlipDetails(t.slip_number, { quote_first: true, who: "JT" });
  check("and now the slip says quote it first",
    !!(await data.slips.getSlip(t.slip_number)).quote_first, true);

  console.log("\n-- and the ordinary guards still apply --");
  const d = await fresh("CLOSED PTE LTD");
  await data.slips.setMachineLabour(d.machines[0].id, 30);
  await data.slips.createSlipOrder(d.slip_number, [d.machines[0].id]);
  await data.slips.setSlipInvoiced(d.slip_number, "INV-9201", "JT");
  await data.slips.closeSlip(d.slip_number, "DO-9201", "JT");
  let status = "no error";
  try {
    await data.slips.updateSlipDetails(d.slip_number, { quote_first: true, who: "JT" });
  } catch (e) { status = e.status; }
  check("a closed slip is refused", status, 409);
  check("and nothing changed on it",
    asks(await data.slips.getSlip(d.slip_number)), [false, false, false]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
