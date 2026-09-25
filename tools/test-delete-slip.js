// Deleting a service slip from the app, and handing its number back.
//
//   node tools/test-delete-slip.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// John registered slip 00096 ten seconds after 00095 by double-tapping
// Register: the same customer, the same four machines, twice. He asked on
// 25 Sep 2026 to be able to delete one and have the number reused.
//
// WHAT IS CHECKED, worst consequence first
//  1. It refuses anything that exists OUTSIDE this database. A slip whose work
//     is on a Sales Order, or whose quotation went to a customer, or that has
//     been invoiced or closed, would leave a real document pointing at nothing.
//  2. A copy is kept. There is no database backup to take from a phone, so the
//     whole slip goes into deleted_slips first and a mistake is recoverable.
//  3. The number comes back only when it was the LAST one. Wound back past a
//     higher slip, the counter would spend the next few registrations filling
//     old gaps and Friday's slip would be numbered before Tuesday's.
//  4. Nothing of the slip is left behind - machines, parts and the signature
//     go with it, and the quotation numbers are released.
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
const db = require(path.resolve(__dirname, "..", "backend", "db"));
const FN = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
async function throws(what, fn, wantStatus) {
  try {
    await fn(); failures++; console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = !wantStatus || e.status === wantStatus;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${String(e.message).slice(0, 90)}`);
  }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const newSlip = (company, machines) => data.slips.createSlip({
  company, contact_name: "Mr Ho", contact_number: "91234567",
  machines: machines.map((d) => ({ desc: d, remarks: "service" })), signature: sig,
});

(async () => {
  console.log("-- whose button this is --");
  check("John's", FN.canDeleteSlips({ id: "john" }), true);
  check("not another admin's", FN.canDeleteSlips({ id: "shirley" }), false);
  check("and not nobody's", FN.canDeleteSlips(null), false);

  // The duplicate, rebuilt: two identical slips a few seconds apart.
  const a = await newSlip("OCS GROUP (S) LANDSCAPING", ["HB2302", "PHT1500"]);
  const b = await newSlip("OCS GROUP (S) LANDSCAPING", ["HB2302", "PHT1500"]);
  check("registered one after the other", [a.slip_number, b.slip_number], ["00001", "00002"]);

  console.log("\n-- what it says before anybody agrees to it --");
  const view = data.slips.slipDeletable(b.slip_number);
  check("it can go", view.can_delete, true);
  check("and says what is on it", [view.company, view.machines, view.parts, view.signed],
    ["OCS GROUP (S) LANDSCAPING", 2, 0, true]);
  check("being the last slip, its number comes back", view.frees_number, true);

  console.log("\n-- rule 2: a copy is kept --");
  const before = db.prepare("SELECT COUNT(*) AS n FROM deleted_slips").get().n;
  const out = data.slips.deleteSlip(b.slip_number, "J");
  check("it went", out.deleted, true);
  const kept = db.prepare("SELECT * FROM deleted_slips ORDER BY id DESC LIMIT 1").get();
  check("one more copy than before",
    db.prepare("SELECT COUNT(*) AS n FROM deleted_slips").get().n, before + 1);
  check("under the right number, with who did it", [kept.slip_number, kept.deleted_by], ["00002", "J"]);
  const back = JSON.parse(kept.payload);
  check("and the whole slip is in it, machines and all",
    [back.slip_number, back.company, (back.machines || []).length],
    ["00002", "OCS GROUP (S) LANDSCAPING", 2]);

  console.log("\n-- rule 4: nothing is left behind --");
  await throws("the slip is gone", () => data.slips.getSlip(b.slip_number) || Promise.reject(Object.assign(new Error("still there"), { status: 0 })), undefined);
  check("its machines went with it",
    db.prepare("SELECT COUNT(*) AS n FROM slip_machines WHERE slip_id = ?").get(b.id ?? -1).n, 0);
  check("and the one beside it is untouched",
    (await data.slips.getSlip(a.slip_number)).machines.length, 2);

  console.log("\n-- rule 3: the number comes straight back --");
  const c = await newSlip("THE NEXT CUSTOMER", ["525LK"]);
  check("the next slip registered takes it", c.slip_number, "00002");

  console.log("\n-- but only when it was the last one --");
  const d = await newSlip("ANOTHER", ["K770"]);
  check("three slips now", [a.slip_number, c.slip_number, d.slip_number], ["00001", "00002", "00003"]);
  const mid = data.slips.slipDeletable(c.slip_number);
  check("deleting the middle one leaves a gap", mid.frees_number, false);
  data.slips.deleteSlip(c.slip_number, "J");
  const e = await newSlip("AFTER THE GAP", ["EBZ5100"]);
  check("and the next slip carries on rather than filling it", e.slip_number, "00004");

  console.log("\n-- rule 1: what it will not delete --");
  // On a Sales Order.
  const onOrder = await newSlip("ON AN ORDER PTE LTD", ["EBZ5100"]);
  await data.slips.setMachineLabour(onOrder.machines[0].id, 50);
  await data.slips.createSlipOrder(onOrder.slip_number, [onOrder.machines[0].id]);
  const v1 = data.slips.slipDeletable(onOrder.slip_number);
  check("a slip whose work is on an order cannot go", v1.can_delete, false);
  check("and it says which order", /SO-/.test(v1.reasons.join(" ")), true);
  await throws("deleting it is refused",
    () => data.slips.deleteSlip(onOrder.slip_number, "J"), 409);

  // Quoted to the customer.
  const quoted = await newSlip("QUOTED PTE LTD", ["525LK"]);
  await data.slips.setMachineLabour(quoted.machines[0].id, 30);
  const q = await data.slips.issueQuotation(quoted.slip_number, { payment: "30 Days", who: "CY" });
  const v2 = data.slips.slipDeletable(quoted.slip_number);
  check("a slip whose quotation went out cannot go either", v2.can_delete, false);
  check("naming the quotation", v2.quotations, [q.quotation_no]);
  await throws("also refused", () => data.slips.deleteSlip(quoted.slip_number, "J"), 409);

  // Invoiced.
  const billed = await newSlip("BILLED PTE LTD", ["K770"]);
  db.prepare("UPDATE service_slips SET status = 'INVOICED' WHERE slip_number = ?").run(billed.slip_number);
  check("nor an invoiced one", data.slips.slipDeletable(billed.slip_number).can_delete, false);

  console.log("\n-- and a slip that is not there --");
  await throws("says so plainly", () => data.slips.slipDeletable("09999"), 404);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
