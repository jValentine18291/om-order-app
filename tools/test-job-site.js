// Where a machine works, and the "No Servicing" button.
//
//   node tools/test-job-site.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// John, Sep 2026: "customers also have a particular job site for certain
// machines". A landscaping contractor runs the same blower on four sites and
// nothing on the slip said which one came back. It is optional, blank on most
// machines, and it prints on everything the customer is handed.
//
// WHAT IS CHECKED, worst consequence first
//  1. A phone still running yesterday's copy of the app cannot wipe it. That
//     phone sends no job_site at all, and the field beside it - serial - is
//     cleared when it arrives empty. Following that rule here would strip the
//     site off every machine on a slip the first time somebody corrected a
//     spelling from an un-updated phone.
//  2. It reaches the quotation and the Sales Order at the FOOT of the
//     machine's block, immediately above its SubTotal - John's placement.
//  3. It is part of what the customer signed, so changing it after they signed
//     is recorded like anything else on their copy.
//  4. A machine with no job site is exactly as it was: no line, no blank line,
//     no change to any document already going out.
//  5. "No Servicing" writes a comment and bills nothing.
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
const SITE = "Marina Bay Sands";

(async () => {
  const slip = await data.slips.createSlip({
    company: "GREENSCAPE CONTRACTS PTE LTD", debtor_code: "300-G001",
    contact_name: "Mr Ho", contact_number: "91234567",
    machines: [
      { desc: "EBZ5100 Backpack Blower", serial: "B1", remarks: "won't start", job_site: SITE },
      { desc: "EBZ5100 Backpack Blower", serial: "B2", remarks: "service", job_site: "Gardens by the Bay" },
      // The ordinary case: nobody said, and nothing should change for it.
      { desc: "525LK Combi Trimmer", serial: "T1", remarks: "service" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const [one, two, plain] = slip.machines;

  console.log("-- it is written down where it was typed --");
  check("the first blower's site", one.job_site, SITE);
  check("the second one's, which is a different site", two.job_site, "Gardens by the Bay");
  check("and a machine nobody gave one has none", plain.job_site, "");

  console.log("\n-- rule 3: it is part of what the customer signed --");
  const signed = await data.slips.getSlipSignature(no);
  check("the signed record carries each machine's site",
    (signed.signed_content.machines || []).map((m) => m.job_site),
    [SITE, "Gardens by the Bay", ""]);

  console.log("\n-- rule 2: onto the quotation, above that machine's SubTotal --");
  await data.slips.setMachineLabour(one.id, 50);
  await data.slips.addPartToMachine(one.id, {
    item_code: "A8 SPARE PARTS", description: "Air Filter", uom: "PC",
    unit_price: 12, quantity: 1, technician: "KS" });
  await data.slips.setMachineComment(one.id, "Carburettor cleaned");
  await data.slips.setMachineLabour(plain.id, 20);

  const q = await data.slips.quotationForSlip(no);
  const descs = q.lines.map((l) => l.description);
  const siteAt = descs.indexOf(`Job site: ${SITE}`);
  check("the site is on the quotation, once", descs.filter((d) => d === `Job site: ${SITE}`).length, 1);
  check("immediately above that machine's SubTotal", descs[siteAt + 1], "SubTotal");
  // Below the technician's comment, which is the last thing about the REPAIR.
  check("and below the technician's comment", descs[siteAt - 1], "*Carburettor cleaned");
  check("it carries no money, being a note", q.lines[siteAt].unit_price, undefined);
  check("so the total is the parts and the labour, untouched by it", q.subtotal, 82);

  console.log("\n-- rule 4: a machine with no site is exactly as it was --");
  // Its OWN block: from its machine heading down to its SubTotal. Past that
  // lies the blank line and the contact that close the whole document, which
  // belong to nobody's machine.
  const from = descs.findIndex((d) => String(d).includes("525LK"));
  const plainBlock = descs.slice(from, descs.indexOf("SubTotal", from) + 1);
  check("no job site line anywhere in its block",
    plainBlock.some((d) => String(d).startsWith("Job site:")), false);
  check("nor a blank one left where one would have gone",
    plainBlock.filter((d) => d === "").length, 0);

  console.log("\n-- and the Sales Order says the same, being the same block --");
  await data.slips.createSlipOrder(no, [one.id]);
  const order = await data.slips.getSlipOrder(no);
  const oDescs = (order.lines || []).map((l) => l.description);
  check("the site is on the order too", oDescs.includes(`Job site: ${SITE}`), true);
  check("in the same place", oDescs[oDescs.indexOf(`Job site: ${SITE}`) + 1], "SubTotal");

  console.log("\n-- the picker on Send Quotation can tell two of the same model apart --");
  const q2 = await data.slips.quotationForSlip(no);
  check("each machine offered carries its site",
    q2.machines_available.map((m) => [m.machine_desc.slice(0, 7), m.job_site]),
    [["EBZ5100", SITE], ["525LK C", ""]]);

  console.log("\n-- rule 1: an older phone cannot wipe it --");
  // What an edit saved from a phone running the app from before this field
  // existed looks like: every other machine field present, this one absent.
  await data.slips.updateSlipDetails(no, {
    company: "GREENSCAPE CONTRACTS PTE LTD",
    machines: [{ id: one.id, machine_desc: one.machine_desc, serial_no: "B1", remarks: "won't start" }],
    who: "KS",
  });
  check("the site survives an edit that did not mention it",
    (await data.slips.getSlip(no)).machines.find((m) => m.id === one.id).job_site, SITE);
  // Whereas a phone that DOES know about the field can clear it, because an
  // empty box is somebody deleting what was there.
  await data.slips.updateSlipDetails(no, {
    company: "GREENSCAPE CONTRACTS PTE LTD",
    machines: [{ id: two.id, machine_desc: two.machine_desc, serial_no: "B2", remarks: "service", job_site: "" }],
    who: "KS",
  });
  check("but an empty box from a phone that knows about it does clear it",
    (await data.slips.getSlip(no)).machines.find((m) => m.id === two.id).job_site, "");

  console.log("\n-- changing it on a signed slip is recorded --");
  await data.slips.updateSlipDetails(no, {
    company: "GREENSCAPE CONTRACTS PTE LTD",
    machines: [{ id: one.id, machine_desc: one.machine_desc, serial_no: "B1",
                 remarks: "won't start", job_site: "Jewel Changi" }],
    who: "KS",
  });
  const full = await data.slips.getSlip(no);
  check("the new site is stored",
    full.machines.find((m) => m.id === one.id).job_site, "Jewel Changi");
  // Every job-site change on this slip, in the order they were made - the
  // clearing above is one of them, and it is logged for the same reason.
  const logged = (full.amendments || []).filter((a) => /job site/i.test(a.field));
  check("and every change to one is in the amendment log, each once",
    logged.map((a) => [a.before, a.after]),
    [["Gardens by the Bay", ""], [SITE, "Jewel Changi"]]);
  // The edit that did not mention the field is NOT in there. Nothing changed,
  // so nothing is claimed to have.
  check("but the edit from the older phone logged nothing",
    logged.some((a) => a.after === a.before), false);

  console.log("\n-- a machine added later can carry one too --");
  await data.slips.addMachineToSlip(no, {
    desc: "K770 Power Cutter", serial: "C9", remarks: "smoking", job_site: "Sentosa Cove" }, "KS");
  check("it does",
    (await data.slips.getSlip(no)).machines.find((m) => m.serial_no === "C9").job_site, "Sentosa Cove");

  console.log("\n-- rule 5: \"No Servicing\" is a comment, not a line --");
  // The button lives in the browser, but what it writes lands here - and this
  // is the half that reaches a customer.
  await data.slips.setMachineComment(plain.id, "No servicing");
  const q3 = await data.slips.quotationForSlip(no, [plain.id]);
  check("it prints with the asterisk every repair comment gets",
    q3.lines.some((l) => l.description === "*No servicing"), true);
  check("and bills only the labour already on the machine", q3.subtotal, 20);

  // The table the button is built from, checked the way the app checks it
  // before drawing any of them.
  global.window = global;
  const JOBS = require(path.resolve(__dirname, "..", "frontend", "common-jobs.js")) || global.OM_JOBS;
  const J = global.OM_JOBS;
  check("the common jobs list is sound with a comment job in it", J.check(), []);
  const nosvc = J.byId("NOSVC");
  check("No Servicing writes this", nosvc.comment, "No servicing");
  check("and has no code, no price and no quantity to bill",
    [nosvc.code, nosvc.price, nosvc.qty], [undefined, undefined, undefined]);
  // It must never be mistaken for a part priced at nothing on purpose - that
  // test is what keeps unpriced lines off the "needs a price" list.
  check("it is not a deliberately-free PART",
    J.zeroIsDeliberate({ item_code: "", unit_price: 0, variant: "NOSVC" }), false);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
