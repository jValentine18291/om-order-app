// Whether a purchase order has been sent to the supplier.
//
//   node tools/test-purchase-orders.js C:/temp/scratch.db
//
// The ORDER itself is AutoCount's and is not tested here - it is read-only and
// cannot be exercised without the accounts database. What this covers is the
// one fact the app keeps: Iris's tick, and the date that goes with it.
//
// The rule worth guarding: a PO with no row reads as NOT_ORDERED. That is what
// lets a PO raised in AutoCount an hour ago appear correctly with nothing
// doing, and it is why this table never has to be kept in step with theirs.
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
const po = data.purchaseOrders;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const today = new Date().toISOString().slice(0, 10);

console.log("\n-- a PO nobody has touched --");
check("reads as not ordered", po.status("PO-2026-0500").status, "NOT_ORDERED");
check("with no date", po.status("PO-2026-0500").ordered_at, null);
// No row was written just by asking. The table holds only the ones something
// has happened to.
check("and asking did not create one", po.tracking(["PO-2026-0500"]).size, 0);

console.log("\n-- Iris sends it --");
let r = po.setStatus("PO-2026-0500", "ORDERED", "I");
check("status", r.status, "ORDERED");
check("the date it was sent", r.ordered_at, today);
check("and who said so", r.updated_by, "I");

console.log("\n-- ticking it again does not invent a new date --");
// "When did we order this" gets asked of a PO long after anyone remembers, so
// the first answer is the one that counts.
const originalDate = r.ordered_at;
r = po.setStatus("PO-2026-0500", "ORDERED", "KS");
check("same date", r.ordered_at, originalDate);
check("but the new initials", r.updated_by, "KS");

console.log("\n-- putting it back keeps the date too --");
// Because it was sent. Undoing the tick corrects a mistake about the STATUS;
// it does not unsend an email.
r = po.setStatus("PO-2026-0500", "NOT_ORDERED", "I");
check("back to not ordered", r.status, "NOT_ORDERED");
check("date kept", r.ordered_at, originalDate);

console.log("\n-- what it refuses --");
let err = "";
try { po.setStatus("PO-2026-0500", "SHIPPED", "I"); } catch (e) { err = e.message; }
check("a status that is not one of ours", /Invalid purchase order status/.test(err), true);
err = "";
try { po.setStatus("PO-2026-0500", "ORDERED", "  "); } catch (e) { err = e.message; }
check("a change nobody signed", /Missing initials/.test(err), true);
err = "";
try { po.setStatus("", "ORDERED", "I"); } catch (e) { err = e.message; }
check("no purchase order", /Which purchase order/.test(err), true);

console.log("\n-- looking several up at once --");
po.setStatus("PO-2026-0501", "ORDERED", "I");
const many = po.tracking(["PO-2026-0500", "PO-2026-0501", "PO-2026-0502"]);
check("only the ones with a row come back", [...many.keys()].sort(), ["PO-2026-0500", "PO-2026-0501"]);
check("and the untouched one still reads correctly", po.status("PO-2026-0502").status, "NOT_ORDERED");

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
