// Prices a technician typed, going back into AutoCount.
//
//   node tools/test-price-writeback.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// Some parts have no price in AutoCount. The technician looks the price up in
// the office price list, types it on the slip, and this is what carries it
// back so nobody looks it up twice.
//
// It fires when the technician presses Save on a machine, and again as a
// backstop when Sales convert the slip. Both go through one function, because
// two implementations of "write these prices" would eventually disagree about
// which parts count.
//
// THE RULE THAT MATTERS MOST
// The write NEVER overwrites - it only fills a blank. So whichever pass gets
// there first sets the price in AutoCount for good, and a part that already
// has a price must be left completely alone. Most of what follows is about
// what does NOT get written.
const path = require("path");
const Module = require("module");

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
process.env.ITEMS_SOURCE = "autocount";
process.env.AUTOCOUNT_PRICE_WRITEBACK_ORDERS = "true";

// ---- AutoCount and the audit log, stubbed -----------------------------------
// The server reaches for these by name, so they are intercepted rather than
// injected: what is under test is the route as it is written, including which
// module it asks and what it passes.
const acPath = path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js");
const logPath = path.resolve(__dirname, "..", "backend", "priceLog.js");

// What AutoCount already knows a price for. Everything else is blank.
const HAS_PRICE = new Set(["SZEN PRICED"]);
const written = [];      // every write that actually landed
const asked = [];        // every item the code offered, landed or not
const logged = [];

const acStub = {
  writebackEnabled: () => true,
  updateItemPriceIfMissing: async (itemCode, newPrice) => {
    asked.push(itemCode);
    if (itemCode === "SZEN EXPLODES") throw new Error("AutoCount went away");
    if (itemCode === "SZEN MISSING") {
      return { status: "skipped_not_found", item_code: itemCode, old_price: null, new_price: newPrice };
    }
    if (HAS_PRICE.has(itemCode)) {
      return { status: "skipped_has_price", item_code: itemCode, old_price: 42, new_price: newPrice };
    }
    HAS_PRICE.add(itemCode);            // it has one now - the real guard's effect
    written.push([itemCode, newPrice]);
    return { status: "updated", item_code: itemCode, old_price: 0, new_price: newPrice };
  },
};
const logStub = { logPriceEvent: (e) => logged.push(e) };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch (e) { return request; } })();
  if (resolved === acPath) return acStub;
  if (resolved === logPath) return logStub;
  return realLoad.apply(this, arguments);
};

const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// The function under test lives in server.js, which is an express app; pulling
// it in whole would start a listener. It is re-created here from the same
// source file instead, so the thing tested is the code that ships.
const fs = require("fs");
const serverPath = path.resolve(__dirname, "..", "backend", "server.js");
const src = fs.readFileSync(serverPath, "utf8");
const start = src.indexOf("async function writeSlipPricesToAutoCount");
const end = src.indexOf("\n}\n", start) + 3;
if (start < 0 || end < 3) { console.error("could not find writeSlipPricesToAutoCount in server.js"); process.exit(2); }
// Given server.js's own require, so "./data/autocountRepo" resolves the way it
// does there - which is also what the stub above intercepts.
const serverRequire = Module.createRequire(serverPath);
const writeSlipPricesToAutoCount = new Function(
  "require", `return (${src.slice(start, end)});`
)(serverRequire);

const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  console.log("-- the ordinary case: a blank price gets filled --");
  let r = await writeSlipPricesToAutoCount([
    { item_code: "SZEN BLANK1", unit_price: 9.5, technician: "XL" },
    { item_code: "SZEN BLANK2", unit_price: 130, technician: "XL" },
  ], "Slip 00001");
  check("both written", r.updated, ["SZEN BLANK1", "SZEN BLANK2"]);
  check("and recorded in the audit log",
    logged.map((l) => [l.itemCode, l.newPrice, l.who, l.outcome]),
    [["SZEN BLANK1", 9.5, "XL", "updated in AutoCount"], ["SZEN BLANK2", 130, "XL", "updated in AutoCount"]]);
  check("logged against the slip it came from", [...new Set(logged.map((l) => l.source))], ["Slip 00001"]);
  check("as the Contractor price - AutoCount's \"Price 1\"",
    [...new Set(logged.map((l) => l.tier))], ["Contractor Price"]);

  console.log("\n-- a part AutoCount already prices is left alone --");
  logged.length = 0; written.length = 0;
  r = await writeSlipPricesToAutoCount([{ item_code: "SZEN PRICED", unit_price: 5, technician: "R" }], "Slip 00002");
  check("nothing written", written, []);
  check("counted as skipped", r.skipped, 1);
  check("and NOT logged - every priced part would flood it", logged.length, 0);

  console.log("\n-- running it twice writes once --");
  // The backstop at conversion passes over parts Save already wrote. That must
  // cost nothing, because the price is final after the first write.
  logged.length = 0; written.length = 0;
  const parts = [{ item_code: "SZEN TWICE", unit_price: 12, technician: "KM" }];
  await writeSlipPricesToAutoCount(parts, "Slip 00003");
  const second = await writeSlipPricesToAutoCount(parts, "Slip 00003");
  check("written on the first pass only", written, [["SZEN TWICE", 12]]);
  check("the second pass skips it", [second.updated, second.skipped], [[], 1]);

  console.log("\n-- what is never offered to AutoCount at all --");
  asked.length = 0; written.length = 0;
  r = await writeSlipPricesToAutoCount([
    { item_code: "SZEN ZERO", unit_price: 0, technician: "R" },
    { item_code: "SZEN BLANKPRICE", unit_price: null, technician: "R" },
    { item_code: "SZEN NEGATIVE", unit_price: -5, technician: "R" },
    { item_code: "SZEN REAL", unit_price: 3.3, technician: "R" },
  ], "Slip 00004");
  check("a part with no price typed is not offered", asked, ["SZEN REAL"]);
  check("only the real one written", r.updated, ["SZEN REAL"]);

  console.log("\n-- failures are recorded, never thrown --");
  // A technician's Save must not fail because the accounts database is down.
  logged.length = 0;
  r = await writeSlipPricesToAutoCount([
    { item_code: "SZEN EXPLODES", unit_price: 7, technician: "WJ" },
    { item_code: "SZEN AFTER", unit_price: 8, technician: "WJ" },
  ], "Slip 00005");
  check("the failure is reported", r.failed, ["SZEN EXPLODES"]);
  check("and the part after it still went through", r.updated, ["SZEN AFTER"]);
  check("the failure is in the audit log, said plainly",
    logged.filter((l) => /FAILED/.test(l.outcome)).map((l) => l.outcome),
    ["FAILED - AutoCount went away"]);

  console.log("\n-- an item AutoCount does not have is worth a line --");
  logged.length = 0;
  await writeSlipPricesToAutoCount([{ item_code: "SZEN MISSING", unit_price: 4, technician: "J" }], "Slip 00006");
  check("logged, because a price somebody expected to save did not",
    logged.map((l) => l.outcome), ["SKIPPED - item not found in AutoCount"]);

  console.log("\n-- the switches --");
  // Two guards, and both must hold: this writes into the accounts.
  const saved = process.env.AUTOCOUNT_PRICE_WRITEBACK_ORDERS;
  process.env.AUTOCOUNT_PRICE_WRITEBACK_ORDERS = "false";
  asked.length = 0;
  r = await writeSlipPricesToAutoCount([{ item_code: "SZEN OFF", unit_price: 5 }], "Slip 00007");
  check("switched off, AutoCount is never asked", asked, []);
  check("and nothing is reported as written", r.updated, []);
  process.env.AUTOCOUNT_PRICE_WRITEBACK_ORDERS = saved;

  process.env.ITEMS_SOURCE = "sqlite";
  asked.length = 0;
  await writeSlipPricesToAutoCount([{ item_code: "SZEN NOAC", unit_price: 5 }], "Slip 00008");
  check("and with no AutoCount configured at all, likewise", asked, []);
  process.env.ITEMS_SOURCE = "autocount";

  console.log("\n-- the parts a real Save would hand it --");
  // The route passes one machine's parts. This is the shape it reads them from,
  // so a change to getSlip that dropped `parts` would show up here.
  const slip = await data.slips.createSlip({
    company: "PRICE TEST PTE LTD",
    machines: [{ desc: "EBZ5100" }, { desc: "HB2302" }],
    signature: sig,
  });
  const [m1, m2] = slip.machines;
  await data.slips.addPartToMachine(m1.id, {
    item_code: "SZEN ONM1", description: "Piston", uom: "PC", unit_price: 31.1, quantity: 1, technician: "KS" });
  await data.slips.addPartToMachine(m2.id, {
    item_code: "SZEN ONM2", description: "Element", uom: "PC", unit_price: 3.2, quantity: 1, technician: "KS" });
  const fresh = await data.slips.getSlip(slip.slip_number);
  const machine = fresh.machines.find((m) => m.id === m1.id);
  asked.length = 0;
  await writeSlipPricesToAutoCount(machine.parts || [], `Slip ${fresh.slip_number}`);
  check("Save offers only the machine that was saved", asked, ["SZEN ONM1"]);
  asked.length = 0;
  await writeSlipPricesToAutoCount(fresh.machines.flatMap((m) => m.parts || []), `Slip ${fresh.slip_number}`);
  check("conversion offers every machine on the slip", asked.sort(), ["SZEN ONM1", "SZEN ONM2"]);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
