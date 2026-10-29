// ITEMS WITH NO PRICE, AT CREATE SALES ORDER. No database needed:
//
//   node tools/test-unpriced-on-order.js
//
// John, 29 Oct 2026: a pop-up whenever an item about to go on a Sales Order
// has no price, so a technician does not create one billing a part at $0. His
// answers: at Create Sales Order only, and a warning - OK goes on anyway.
//
// Checked: unpriced parts on the chosen machines are named, machine by machine;
// a machine not chosen, a condemned one, one free of charge and a $0-on-purpose
// common job are not; the slip's own parts only when they are going on it, and
// not ones already billed; and createSalesOrder asks this BEFORE its ordinary
// "Create the Sales Order?" question, stopping when the answer is Cancel.
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
function lift(name) {
  const start = app.indexOf("function " + name + "(");
  if (start < 0) throw new Error(`${name}() is not in frontend/app.js any more`);
  const end = app.indexOf("\n}\n", start);
  return app.slice(start, end + 2);
}
const window = {
  // The real rule lives in common-jobs.js; this stands in for one job priced at
  // $0 on purpose, recognised by its variant.
  OM_JOBS: { zeroIsDeliberate: (p) => p.variant === "free-job" && !(Number(p.unit_price) > 0) },
};
const machineTitle = (m) => m.machine_desc;
const tr = (s) => s;
const unpricedOnOrder = new Function("window", "machineTitle", "tr",
  lift("unpricedOnOrder") + "\nreturn unpricedOnOrder;")(window, machineTitle, tr);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const part = (code, desc, price, extra = {}) => ({ item_code: code, description: desc, unit_price: price, quantity: 1, ...extra });
const slip = {
  machines: [
    { id: 1, machine_desc: "BK3410 - 1/4", state: "REPAIRED",
      parts: [part("M1618SK WS7F", "Bosch spark plug", 0), part("SZEN 140082113", "Body 2-100", 3.7)] },
    { id: 2, machine_desc: "HBZ260 - 2/4", state: "REPAIRED",
      parts: [part("A7 SVR WAREHOUSE", "Carburettor service", 0, { variant: "free-job" }), part("SZEN 848KD35820", "Pipe", null)] },
    { id: 3, machine_desc: "525BX - 3/4", state: "CONDEMNED", parts: [part("X 1", "Never fitted", 0)] },
    { id: 4, machine_desc: "T525 - 4/4", state: "REPAIRED", foc: 1, parts: [part("X 2", "Free of charge", 0)] },
  ],
  extras: [part("A8 SPARE PARTS", "Pipe comp", 0), part("Y 1", "Already billed", 0, { converted_at: "2026-10-28 10:00:00" })],
};

console.log("-- what gets named --");
check("unpriced parts on the chosen machines, $0 and blank alike",
  unpricedOnOrder(slip, [1, 2], false),
  ["BK3410 - 1/4: M1618SK WS7F Bosch spark plug", "HBZ260 - 2/4: SZEN 848KD35820 Pipe"]);
check("a machine not chosen is not asked about", unpricedOnOrder(slip, [2], false), ["HBZ260 - 2/4: SZEN 848KD35820 Pipe"]);
check("condemned and free of charge are not", unpricedOnOrder(slip, [3, 4], false), []);
check("the slip's own parts when they are going, not ones already billed",
  unpricedOnOrder(slip, [], true), ["Additional parts: A8 SPARE PARTS Pipe comp"]);
check("and not when they are not going", unpricedOnOrder(slip, [4], false), []);
check("everything priced: nothing to ask", unpricedOnOrder({ machines: [slip.machines[0]].map((m) => ({ ...m, parts: [m.parts[1]] })) }, [1], false), []);

console.log("\n-- where it is asked --");
const create = lift("createSalesOrder");
const ask = create.indexOf("unpricedOnOrder(session.slip, chosen, wantExtras)");
const ordinary = create.indexOf('confirmLines("Create the Sales Order?"');
check("asked in createSalesOrder, before its ordinary question", ask > 0 && ask < ordinary, true);
check("Cancel stops it there",
  /if \(unpriced\.length && !confirmLines\("Some items have no price"[\s\S]*?\)\) \{[\s\S]*?return;\s*\}/.test(create), true);
check("and only there", (app.match(/unpricedOnOrder\(/g) || []).length, 2);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
