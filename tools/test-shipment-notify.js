// What people actually read when a shipment moves.
//
//   node tools/test-shipment-notify.js
//
// A notification is the one part of the app that arrives whether or not anyone
// opened it, so it has to say something useful in about forty characters and
// never say anything untrue.
const { shipmentStatusMessage } =
  require(require("path").resolve(__dirname, "..", "backend", "notifyText.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const base = {
  id: 7, invoice_no: "INV-90211", supplier_name: "Husqvarna AB, Sweden",
  destination: "JOO_SENG", eta_sg: "2026-09-24", eta_dest: "2026-09-27",
  lines: [
    { item_code: "SHUQ 577317601", description: "Joint", qty: 1 },
    { item_code: "SHUQ 505180901", description: "Hose", qty: 3 },
    { item_code: "SHUQ 576594201", description: "Reel", qty: 8 },
  ],
};

console.log("\n-- it has sailed --");
let m = shipmentStatusMessage({ ...base, status: "SHIPPED" }, "SHIPPED");
check("titled by the invoice, which is how Iris names one", m.title, "INV-90211 · Shipped");
check("who it is from, what is on it, when it lands",
  m.body, "Husqvarna AB, Sweden · 3 items · Singapore 24 Sep (was Shipped)");

console.log("\n-- it has landed in Singapore --");
// Now the date being waited on is the one for the workshop, not the port.
m = shipmentStatusMessage({ ...base, status: "ARRIVED_SG" }, "SHIPPED");
check("title", m.title, "INV-90211 · Arrived Singapore");
check("the NEXT date, and where it is going",
  m.body, "Husqvarna AB, Sweden · 3 items · Joo Seng 27 Sep (was Shipped)");

console.log("\n-- it is in --");
// Nothing left to wait for, so no date. "Received, ETA next Tuesday" would be
// a strange thing to read.
m = shipmentStatusMessage({ ...base, status: "RECEIVED" }, "ARRIVED_SG");
check("no date on it", m.body, "Husqvarna AB, Sweden · 3 items (was Arrived Singapore)");
check("and it says where it came from", m.title, "INV-90211 · Received");

console.log("\n-- it is off --");
m = shipmentStatusMessage({ ...base, status: "CANCELLED" }, "SHIPPED");
check("a cancelled shipment promises no date",
  m.body, "Husqvarna AB, Sweden · 3 items (was Shipped)");

console.log("\n-- one part is worth naming --");
m = shipmentStatusMessage(
  { ...base, status: "SHIPPED", lines: [{ item_code: "SHUQ 577317601", description: "Joint" }] }, "SHIPPED");
check("by its description, not its code",
  m.body, "Husqvarna AB, Sweden · Joint · Singapore 24 Sep (was Shipped)");
// A part with no description falls back to something rather than nothing.
m = shipmentStatusMessage(
  { ...base, status: "SHIPPED", lines: [{ item_code: "SHUQ 577317601" }] }, "SHIPPED");
check("or by its code when that is all there is",
  m.body, "Husqvarna AB, Sweden · SHUQ 577317601 · Singapore 24 Sep (was Shipped)");

console.log("\n-- the thin ones --");
// A shipment entered before suppliers existed on the form, with no dates.
m = shipmentStatusMessage(
  { id: 1, invoice_no: "INV-OLD", status: "ARRIVED_SG", lines: [{ description: "Gasket" }] }, "SHIPPED");
check("says what it can and invents nothing", m.body, "Gasket (was Shipped)");
check("still titled", m.title, "INV-OLD · Arrived Singapore");
// The very worst case must not produce "undefined · undefined".
m = shipmentStatusMessage({}, "");
check("nothing at all is still readable", [m.title, m.body], ["Shipment · ", "0 items"]);

console.log("\n-- the date --");
// Read by people who write dates day-first. The year is left off on purpose:
// everything on a notification is happening within weeks.
check("day first, month in words",
  shipmentStatusMessage({ ...base, status: "SHIPPED", eta_sg: "2026-01-05" }, "").body,
  "Husqvarna AB, Sweden · 3 items · Singapore 5 Jan");
check("something that is not a date is passed through, not mangled",
  shipmentStatusMessage({ ...base, status: "SHIPPED", eta_sg: "soon" }, "").body,
  "Husqvarna AB, Sweden · 3 items · Singapore soon");

console.log("\n-- it carries the id, so tapping it can open the shipment --");
check("id", shipmentStatusMessage({ ...base, status: "SHIPPED" }, "SHIPPED").shipment, 7);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
