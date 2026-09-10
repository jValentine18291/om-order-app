// One slip, several Sales Orders, a DO/CS/INV for each.
//
//   node tools/test-multi-order-invoice.js C:/temp/scratch.db
//
// Slip 00007: half repaired, and the customer wants those now. That is two
// Sales Orders and two AutoCount documents against one slip. It used to be one
// field on the slip, so recording the second number silently erased the first
// - which is the thing this file exists to stop happening again.
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
const refuse = async (what, fn, re) => {
  let err = "";
  try { await fn(); } catch (e) { err = e.message; }
  const ok = re.test(err);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(err)}`);
};
const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const refs = (slip) => (slip.orders || []).map((o) => `${o.so_number}=${o.closing_ref || "-"}`);

(async () => {
  console.log("\n-- the customer collects half of it now --");
  let slip = await data.slips.createSlip({
    company: "TEST TWO INVOICES", contact_name: "A", contact_number: "1",
    machines: [
      { desc: "ZENOAH BK3410 Backpack Brushcutter - 1/3", serial: "Z1", remarks: "" },
      { desc: "ZENOAH BK3410 Backpack Brushcutter - 2/3", serial: "Z2", remarks: "" },
      { desc: "ZENOAH HBZ260 Hedge Trimmer - 3/3", serial: "Z3", remarks: "" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const ids = slip.machines.map((m) => m.id);
  for (const id of ids) await data.slips.setMachineLabour(id, 40);
  for (const id of ids.slice(0, 2)) await data.slips.finishRepair(id, "WJ");

  const so1 = await data.slips.createSlipOrder(no, ids.slice(0, 2), "KS");
  slip = await data.slips.getSlip(no);
  check("one order so far", refs(slip), [`${so1.so_number}=-`]);

  // With one order there is nothing to choose, so the screen need not ask.
  slip = await data.slips.setSlipInvoiced(no, "DO-2609-0101", "KS");
  check("its number is recorded against it", refs(slip), [`${so1.so_number}=DO-2609-0101`]);
  check("and the slip says so", slip.status, "INVOICED");

  console.log("\n-- but it cannot be closed while a machine is still on the bench --");
  await refuse("the third machine has no order at all",
    () => data.slips.closeSlip(no, "", "KS"), /Not on a Sales Order yet/);

  console.log("\n-- the rest is finished and gets its own order --");
  await data.slips.finishRepair(ids[2], "WJ");
  const so2 = await data.slips.createSlipOrder(no, [ids[2]], "KS");
  slip = await data.slips.getSlip(no);
  check("two orders on one slip", refs(slip),
    [`${so1.so_number}=DO-2609-0101`, `${so2.so_number}=-`]);

  console.log("\n-- and now the number has to say which batch it is for --");
  await refuse("two orders, no order named",
    () => data.slips.setSlipInvoiced(no, "DO-2609-0177", "KS"), /say which one/);
  await refuse("nor one that is not on this slip",
    () => data.slips.setSlipInvoiced(no, "DO-2609-0177", "KS", "SO-9999-99999"), /not a Sales Order on this slip/);

  slip = await data.slips.setSlipInvoiced(no, "DO-2609-0177", "KS", so2.so_number);
  // THE regression this file exists for.
  check("the second number is recorded AND the first survives", refs(slip),
    [`${so1.so_number}=DO-2609-0101`, `${so2.so_number}=DO-2609-0177`]);

  console.log("\n-- closing insists on every one of them --");
  const noC = (await (async () => {
    let s2 = await data.slips.createSlip({
      company: "TEST HALF INVOICED", contact_name: "A", contact_number: "1",
      machines: [{ desc: "M1", serial: "1", remarks: "" }, { desc: "M2", serial: "2", remarks: "" }],
      signature: sig,
    });
    const i = s2.machines.map((m) => m.id);
    for (const id of i) { await data.slips.setMachineLabour(id, 20); await data.slips.finishRepair(id, "WJ"); }
    const a = await data.slips.createSlipOrder(s2.slip_number, [i[0]], "KS");
    await data.slips.createSlipOrder(s2.slip_number, [i[1]], "KS");
    await data.slips.setSlipInvoiced(s2.slip_number, "DO-A", "KS", a.so_number);
    return s2.slip_number;
  })());
  let half = await data.slips.getSlip(noC);
  check("one invoiced, one not", refs(half).map((r) => r.split("=")[1]), ["DO-A", "-"]);
  check("the slip still reads Invoice Created", half.status, "INVOICED");
  await refuse("but it will not close with a batch unaccounted for",
    () => data.slips.closeSlip(noC, "", "KS"), /No DO\/CS\/INV recorded for/);

  // Once the second batch has its number the slip can close.
  const second = half.orders[1].so_number;
  await data.slips.setSlipInvoiced(noC, "DO-B", "KS", second);
  half = await data.slips.closeSlip(noC, "", "KS");
  check("and then it closes", half.status, "CLOSED");
  check("with both numbers still on it", refs(half).map((r) => r.split("=")[1]), ["DO-A", "DO-B"]);

  console.log("\n-- correcting one does not touch the other --");
  slip = await data.slips.setSlipInvoiced(no, "DO-2609-0102", "KS", so1.so_number);
  check("only the batch named changes", refs(slip),
    [`${so1.so_number}=DO-2609-0102`, `${so2.so_number}=DO-2609-0177`]);

  console.log("\n-- nothing on an order at all --");
  const empty = await data.slips.createSlip({
    company: "TEST NO ORDER", contact_name: "A", contact_number: "1",
    machines: [{ desc: "M", serial: "1", remarks: "" }], signature: sig,
  });
  await refuse("there is nothing to invoice",
    () => data.slips.setSlipInvoiced(empty.slip_number, "DO-X", "KS"), /Sales Order first/);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
