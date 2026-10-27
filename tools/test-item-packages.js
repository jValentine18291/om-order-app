// ITEM PACKAGES ON A SLIP. Run against a throwaway database:
//
//   node tools/test-item-packages.js C:/temp/scratch.db
//
// John, 27 Oct 2026: technicians can search for AutoCount Item Packages when
// adding parts, and one goes on the machine as a single line - his choice. A
// package code can also be an ordinary item code (SZEN 140082002 is both), so
// the line carries is_package, and it is that flag, not the code, which tells
// the Sales Order writer to write a package (test-so-packages.js).
//
// Checked: the flag is saved on a machine's part and on the slip's own parts;
// a package and the item with the same code stay two lines; the flag reaches
// the Sales Order's lines; the price write-back passes a package by; and only
// the technicians' two pickers ask for packages.
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
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const PKG = { item_code: "SZEN 140082002", description: "Cleaner Assy 4-35", uom: "SET", unit_price: 12.3, technician: "WJ" };

(async () => {
  console.log("-- on a machine --");
  const s = await data.slips.createSlip({ company: "PACKAGES", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410" }] });
  const m = s.machines[0].id;
  await data.slips.addPartToMachine(m, { ...PKG, is_package: true });
  let parts = await data.slips.addPartToMachine(m, { ...PKG, is_package: true });
  check("saved as a package, twice is a quantity of two",
    parts.map((p) => [p.item_code, p.is_package, p.quantity]), [["SZEN 140082002", 1, 2]]);
  parts = await data.slips.addPartToMachine(m, { ...PKG, description: "Cleaner Assy (item)", unit_price: 15 });
  check("the ITEM with the same code is a line of its own",
    parts.map((p) => [p.description, p.is_package, p.quantity]),
    [["Cleaner Assy 4-35", 1, 2], ["Cleaner Assy (item)", 0, 1]]);

  console.log("\n-- on the slip's own parts --");
  const extras = await data.slips.addPartToSlip(s.slip_number, { ...PKG, is_package: true });
  check("saved as a package there too", extras.map((p) => p.is_package), [1]);

  console.log("\n-- onto the Sales Order --");
  await data.slips.setMachineState(s.slip_number, m, "REPAIRED", "WJ");
  const so = await data.slips.createSlipOrder(s.slip_number, [m], { extras: true });
  const lines = (await data.orders.getOrder(so.so_number)).lines
    .filter((l) => l.item_code && !/^A\d+ SVR/.test(l.item_code));
  check("each order line says whether it is a package",
    lines.map((l) => [l.item_code, l.description, l.is_package]),
    // The machine's package and item, then the slip's own package.
    [["SZEN 140082002", "Cleaner Assy 4-35", 1], ["SZEN 140082002", "Cleaner Assy (item)", 0],
     ["SZEN 140082002", "Cleaner Assy 4-35", 1]]);

  console.log("\n-- the source --");
  const server = fs.readFileSync(path.resolve(__dirname, "..", "backend", "server.js"), "utf8");
  const wb = server.slice(server.indexOf("async function writeSlipPricesToAutoCount("));
  check("the price write-back passes a package by", /if \(Number\(part\.is_package\)\) continue;/.test(wb.slice(0, 1200)), true);
  check("parts-search adds packages only when asked", /if \(req\.query\.packages === "1"\)/.test(server), true);
  check("a package is looked up as a package only", /if \(req\.query\.package === "1"\)/.test(server), true);
  const app = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
  check("both technician pickers ask for packages, and nothing else does",
    (app.match(/&packages=1`/g) || []).length, 2);
  check("the saved line carries the flag to the server", /is_package: !!p\.is_package,/.test(app), true);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
