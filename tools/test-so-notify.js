// Who hears that a slip became a Sales Order, and what it says.
//
//   node tools/test-so-notify.js C:/temp/scratch.db
//
// The conversion itself is well covered elsewhere; what is checked here is the
// message built from its result - because two of those fields are easy to read
// wrongly. machines_remaining is a COUNT, not a list, and total_amount is on
// the order rather than the slip. Getting either wrong produces a notification
// that is quietly missing half its point rather than one that fails loudly.
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

// THE function the route uses, not a copy of it. A copy would only ever prove
// that the copy still agrees with itself.
const { salesOrderMessage: messageFor } =
  require(path.resolve(__dirname, "..", "backend", "notifyText.js"));

(async () => {
  const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  console.log("\n-- a whole slip, one machine --");
  let slip = await data.slips.createSlip({
    company: "Tan Landscaping", contact_name: "C", contact_number: "1", signature: SIG,
    machines: [{ desc: "BK3410 (Thick)", serial: "A1" }],
  });
  let m = data.slips.getSlip(slip.slip_number).machines[0];
  await data.slips.addPartToMachine(m.id, {
    item_code: "SZEN 848BE058B2", description: "GASKET", unit_price: 12.5, quantity: 2, technician: "WJ",
  });
  await data.slips.setMachineLabour(m.id, 40);
  let result = await data.slips.createSlipOrder(slip.slip_number, [m.id]);
  let msg = messageFor(data.slips.getSlip(slip.slip_number), result, result.so_number);
  check("names the machine when there is only one", msg.body.includes("BK3410 (Thick)"), true);
  check("carries the company", msg.body.includes("Tan Landscaping"), true);
  // 2 x 12.50 + 40 labour. The labour line is part of the order, so it counts.
  check("and the money", msg.body.includes("$65.00"), true);
  check("nothing left behind, so it does not say so", msg.body.includes("still on the slip"), false);

  console.log("\n-- half a slip --");
  slip = await data.slips.createSlip({
    company: "Green Co", contact_name: "C", contact_number: "1", signature: SIG,
    machines: [{ desc: "525HF3S", serial: "B1" }, { desc: "572XP", serial: "B2" },
               { desc: "K10SP", serial: "B3" }],
  });
  let ms = data.slips.getSlip(slip.slip_number).machines;
  for (const one of ms.slice(0, 2)) await data.slips.setMachineLabour(one.id, 10);
  result = await data.slips.createSlipOrder(slip.slip_number, [ms[0].id, ms[1].id]);
  msg = messageFor(data.slips.getSlip(slip.slip_number), result, result.so_number);
  check("counts the machines rather than naming them", msg.body.includes("2 machines"), true);
  // The half that did NOT go is what decides whether sales can invoice and be
  // done with it, so it has to be in the message.
  check("says what is still on the slip", msg.body.includes("1 still on the slip"), true);
  check("machines_remaining really is a count", result.machines_remaining, 1);

  console.log("\n-- an order worth nothing --");
  // A machine converted with no parts and no labour. "$0.00" tells nobody
  // anything, so it is left out rather than printed.
  slip = await data.slips.createSlip({
    company: "Nil Co", contact_name: "C", contact_number: "1", signature: SIG,
    machines: [{ desc: "Old mower", serial: "C1" }],
  });
  m = data.slips.getSlip(slip.slip_number).machines[0];
  // A comment counts as work, which is what lets this convert at all.
  await data.slips.setMachineComment(m.id, "Checked, nothing needed");
  result = await data.slips.createSlipOrder(slip.slip_number, [m.id]);
  msg = messageFor(data.slips.getSlip(slip.slip_number), result, result.so_number);
  check("no money in the message", /\$/.test(msg.body), false);
  check("but it still says which machine", msg.body.includes("Old mower"), true);

  console.log("\n-- the title carries AutoCount's number when it got one --");
  check("uses the number passed in, not the local one",
    messageFor({ slip_number: "00099", company: "X" },
               { machines_converted: [{ machine_desc: "M" }], machines_remaining: 0, total_amount: 0 },
               "SO-AC-1234").title,
    "Sales Order SO-AC-1234");

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("\nTHREW:", e); process.exit(1); });
