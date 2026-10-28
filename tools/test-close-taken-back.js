// CLOSING A SLIP THE CUSTOMER TOOK BACK. Run against a throwaway database:
//
//   node tools/test-close-taken-back.js C:/temp/scratch.db
//
// John, 28 Oct 2026: a customer leaves a machine for servicing, then needs it
// back for a job before anything is done. View Slips gets a button just above
// "Delete this slip" to close it. His answers: any slip with no Sales Order,
// whatever its machines are doing; sales and admin; an optional note.
//
// Checked: a slip not started, one in progress with a part recorded, and one
// waiting on a quote all close, marked as taken back with the note, their
// machines collected; a slip with a Sales Order is refused; a condemned
// machine still needs its signature; a closed slip is refused; the route is
// sales and admin only; and the button sits above Delete, only where allowed.
const fs = require("fs");
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
async function refused(what, fn, like) {
  try { await fn(); check(what, "allowed", "refused"); }
  catch (e) { check(what, like.test(e.message) ? "refused" : e.message, "refused"); }
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const make = (company, descs) => data.slips.createSlip({
  company, contact_name: "A", contact_number: "1", signature: sig,
  machines: descs.map((desc) => ({ desc })),
});

(async () => {
  console.log("-- not started: the customer needed it for a job --");
  const a = await make("NOT STARTED", ["BK3410"]);
  let slip = await data.slips.closeTakenBack(a.slip_number, "CY", "  Needed it for a job  ");
  check("closed, taken back, with the note", [slip.status, slip.closed_reason, slip.closed_note, slip.closed_no_invoice, slip.closed_by],
    ["CLOSED", "TAKEN_BACK", "Needed it for a job", 1, "CY"]);
  check("no document number", slip.closing_ref, "");
  check("its machine back with the customer", [slip.machines[0].disposal, slip.machines[0].disposal_by], ["COLLECTED", "CY"]);
  check("and the machine's own state left as it was", slip.machines[0].state, "RECEIVED");
  await refused("closing it again is refused", () => data.slips.closeTakenBack(a.slip_number, "CY"), /already closed/);

  console.log("\n-- in progress, a part on it, no note --");
  const b = await make("HALF DONE", ["MS180 - 1/2", "525BX - 2/2"]);
  await data.slips.addPartToMachine(b.machines[0].id, { item_code: "M1618SK WS7F", description: "Spark plug", uom: "PC", unit_price: 2.8, technician: "WJ" });
  slip = await data.slips.closeTakenBack(b.slip_number, "KS");
  check("closes, every machine collected", [slip.status, slip.closed_note, slip.machines.map((m) => m.disposal)],
    ["CLOSED", "", ["COLLECTED", "COLLECTED"]]);

  console.log("\n-- waiting on a quote --");
  const c = await make("QUOTING", ["HBZ260"]);
  await data.slips.setMachineState(c.slip_number, c.machines[0].id, "AWAITING_QUOTE", "WJ");
  check("closes", (await data.slips.closeTakenBack(c.slip_number, "KS", "Too slow")).status, "CLOSED");

  console.log("\n-- a Sales Order on it --");
  const d = await make("HAS AN SO", ["MS180"]);
  await data.slips.setMachineLabour(d.machines[0].id, 20);
  await data.slips.setMachineState(d.slip_number, d.machines[0].id, "REPAIRED", "WJ");
  await data.slips.createSlipOrder(d.slip_number, [d.machines[0].id]);
  await refused("refused: Close Service is where that closes",
    () => data.slips.closeTakenBack(d.slip_number, "KS"), /has a Sales Order\. Close it in Close Service/);
  check("left open", (await data.slips.getSlip(d.slip_number)).status !== "CLOSED", true);

  console.log("\n-- a condemned machine --");
  const e = await make("CONDEMNED", ["BK3410"]);
  await data.slips.setMachineState(e.slip_number, e.machines[0].id, "CONDEMNED", "WJ");
  await refused("still needs the customer's signature",
    () => data.slips.closeTakenBack(e.slip_number, "KS"), /not signed for/);
  await data.slips.setCondemnSignature(e.slip_number, e.machines[0].id, { image: sig, who: "KS" });
  check("then closes", (await data.slips.closeTakenBack(e.slip_number, "KS")).status, "CLOSED");

  console.log("\n-- the source --");
  const server = fs.readFileSync(path.resolve(__dirname, "..", "backend", "server.js"), "utf8");
  const route = server.slice(server.indexOf('app.post("/api/slips/:slip/close-taken-back"'));
  check("the route is sales and admin only", /needRole\(req, res, \["sales", "admin"\]\)/.test(route.slice(0, 300)), true);
  const app = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
  const btn = app.indexOf('id="vs-takenback"');
  const del = app.indexOf('id="vs-delete"');
  check("the button comes just before Delete", btn > 0 && btn < del && del - btn < 600, true);
  check("only for sales/admin, an open slip, and no Sales Order",
    /if \(canDecide\(\) && slip\.status !== "CLOSED" && !\(slip\.orders \|\| \[\]\)\.length\) \{\s*html \+= `\s*<button type="button" class="vs-takenback" id="vs-takenback">/.test(app), true);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
