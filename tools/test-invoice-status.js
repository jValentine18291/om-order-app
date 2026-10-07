// "INVOICE CREATED" ONLY WHEN EVERY SALES ORDER HAS ITS NUMBER.
// Run against a throwaway database, never the real one:
//
//   node tools/test-invoice-status.js C:/temp/scratch.db
//
// John, 7 Oct 2026, slip 00048: its first order was invoiced, a second order
// was raised for the other machine five days later - and the slip went on
// reading Invoice Created while that order still needed its DO/CS/INV.
// Checked: a new order on an invoiced slip puts it back to SO Created;
// recording that number makes it Invoice Created again; a slip whose orders
// all have numbers stays Invoice Created even with machines still in the
// workshop (his call); a stale slip is put right by deriveSlipStatus.
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const status = async (no) => (await data.slips.getSlip(no)).status;
async function repaired(no, id) {
  await data.slips.setMachineLabour(id, 30);
  await data.slips.setMachineState(no, id, "REPAIRED", "WJ");
}

(async () => {
  console.log("-- slip 00048's shape --");
  const s = await data.slips.createSlip({ company: "TWO ORDERS", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "BK3410 - 1/2" }, { desc: "HBZ260 - 2/2" }] });
  const [a, b] = s.machines.map((m) => m.id);
  await repaired(s.slip_number, a);
  const so1 = await data.slips.createSlipOrder(s.slip_number, [a], "KS");
  await data.slips.setSlipInvoiced(s.slip_number, "DO-2609-276", "KS");
  check("first order numbered: Invoice Created", await status(s.slip_number), "INVOICED");
  await repaired(s.slip_number, b);
  const so2 = await data.slips.createSlipOrder(s.slip_number, [b], "KS");
  check("a second order raised: back to SO Created", await status(s.slip_number), "CONVERTED");
  await data.slips.setSlipInvoiced(s.slip_number, "DO-2610-0101", "KS", so2.so_number);
  check("its number recorded: Invoice Created again", await status(s.slip_number), "INVOICED");

  console.log("\n-- two orders raised together, numbered one at a time --");
  const t = await data.slips.createSlip({ company: "TOGETHER", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "M1 - 1/2" }, { desc: "M2 - 2/2" }] });
  const [c, d] = t.machines.map((m) => m.id);
  await repaired(t.slip_number, c); await repaired(t.slip_number, d);
  const o1 = await data.slips.createSlipOrder(t.slip_number, [c], "KS");
  const o2 = await data.slips.createSlipOrder(t.slip_number, [d], "KS");
  await data.slips.setSlipInvoiced(t.slip_number, "DO-1", "KS", o1.so_number);
  check("one of two numbered: still SO Created", await status(t.slip_number), "CONVERTED");
  await data.slips.setSlipInvoiced(t.slip_number, "DO-2", "KS", o2.so_number);
  check("both numbered: Invoice Created", await status(t.slip_number), "INVOICED");

  console.log("\n-- every order numbered, machines still in the workshop (John's call) --");
  const u = await data.slips.createSlip({ company: "PART BILLED", contact_name: "A", contact_number: "1", signature: sig,
    machines: [{ desc: "X - 1/3" }, { desc: "Y - 2/3" }, { desc: "Z - 3/3" }] });
  const [x] = u.machines.map((m) => m.id);
  await repaired(u.slip_number, x);
  await data.slips.createSlipOrder(u.slip_number, [x], "KS");
  await data.slips.setSlipInvoiced(u.slip_number, "DO-9", "KS");
  check("stays Invoice Created", await status(u.slip_number), "INVOICED");

  console.log("\n-- a slip left stale, as 00048 was on the live server --");
  db.prepare("UPDATE service_slips SET status = 'INVOICED' WHERE slip_number = ?").run(t.slip_number);
  db.prepare("UPDATE orders SET closing_ref = '' WHERE so_number = ?").run(o2.so_number);
  require(path.resolve(__dirname, "..", "backend", "data", "sqliteRepo.js")).slips
    .deriveSlipStatus(db.prepare("SELECT id FROM service_slips WHERE slip_number = ?").get(t.slip_number).id);
  check("read again: SO Created", await status(t.slip_number), "CONVERTED");

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
