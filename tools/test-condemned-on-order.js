// A condemned machine on the Sales Order, at nothing.
//
//   node tools/test-condemned-on-order.js C:/temp/scratch.db
//
// John's slip 00007: two condemned, two repaired, one still on the bench. The
// customer wants the four finished ones now, condemned included - they have to
// leave the building on paperwork like anything else. The block is printed at
// the end exactly as it would be keyed, because that is the thing being
// checked and a list of assertions does not show it.
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

(async () => {
  let slip = await data.slips.createSlip({
    company: "TEST CONDEMNED ON ORDER", contact_name: "Rajesh Kumar", contact_number: "9123 4567",
    machines: [
      { desc: "HUSQVARNA 572XP Chainsaw", serial: "A1", remarks: "won't start" },
      { desc: "ZENOAH BK3410FL-S Brushcutter", serial: "A2", remarks: "clutch" },
      { desc: "VICTA Corvette 200 Mower", serial: "A3", remarks: "beyond economical repair" },
      { desc: "HUSQVARNA 525LK Combi", serial: "A4", remarks: "cracked crankcase" },
      { desc: "FERRIS IS700Z Zero-Turn", serial: "A5", remarks: "service" },
    ],
    signature: sig,
  });
  const no = slip.slip_number;
  const [saw, cutter, mower, combi, ferris] = slip.machines;

  // Two repaired, with real work on them.
  await data.slips.addPartToMachine(saw.id, { item_code: "SHUQ 577317601", description: "Carburettor repair kit", quantity: 1, unit_price: 38.5, uom: "UNIT", technician: "WJ" });
  await data.slips.setMachineLabour(saw.id, 60);
  await data.slips.setMachineComment(saw.id, "Cleaned carburettor, new plug");
  await data.slips.finishRepair(saw.id, "WJ");

  await data.slips.addPartToMachine(cutter.id, { item_code: "SZEN 848CE037A0", description: "Clutch drum assembly", quantity: 1, unit_price: 52.4, uom: "UNIT", technician: "WJ" });
  await data.slips.setMachineLabour(cutter.id, 45);
  await data.slips.finishRepair(cutter.id, "WJ");

  // Two condemned. One was stripped down and priced before the customer said
  // no - so it has parts and labour on it that must NOT be billed. The other
  // was written off on sight, with nothing recorded at all.
  await data.slips.addPartToMachine(mower.id, { item_code: "SHUQ 505180901", description: "Deck bearing", quantity: 2, unit_price: 30, uom: "UNIT", technician: "WJ" });
  await data.slips.setMachineLabour(mower.id, 80);
  await data.slips.setMachineComment(mower.id, "Deck rusted through");
  await data.slips.setMachineState(no, mower.id, "CONDEMNED", "KS");
  await data.slips.setMachineState(no, combi.id, "CONDEMNED", "KS");

  // The fifth is still on the bench and is not going on this order.
  slip = await data.slips.getSlip(no);
  check("two condemned, two repaired, one waiting",
    slip.machines.map((m) => m.state),
    ["REPAIRED", "REPAIRED", "CONDEMNED", "CONDEMNED", "RECEIVED"]);

  console.log("\n-- the customer collects the four --");
  const so = await data.slips.createSlipOrder(no, [saw.id, cutter.id, mower.id, combi.id], "KS");
  check("four machines on it", so.machines_converted.length, 4);
  check("one still on the slip", so.machines_remaining, 1);

  // createSlipOrder returns a summary; the lines are read back off the order,
  // which is also what the screen that shows the block to key does.
  const L = (await data.slips.getSlipOrder(no)).lines;
  const a1 = L.filter((l) => l.item_code === "A1 SVR LANDSCAPE");
  check("every machine opens with A1 SVR LANDSCAPE, condemned included", a1.length, 4);
  check("and the two condemned ones open at nothing",
    a1.map((l) => l.unit_price), [60, 45, 0, 0]);

  // A machine written off on sight would have been refused before: no parts,
  // no labour, nothing written. Being condemned is the fact the block records.
  check("a machine condemned on sight is not refused for having no work",
    L.some((l) => /525LK Combi/.test(l.description || "")), true);

  console.log("\n-- what a condemned block says --");
  const condemnedNotes = L.filter((l) => l.description === "*Condemned - beyond repair");
  check("both say why they are here", condemnedNotes.length, 2);
  // The technician's own line survives alongside it: that one says what was
  // wrong with the machine, this one says what was decided about it.
  const i = L.findIndex((l) => l.description === "*Deck rusted through");
  check("the technician's note is kept", i > -1, true);
  check("with the condemned line under it", L[i + 1].description, "*Condemned - beyond repair");

  console.log("\n-- nothing is charged for a condemned machine --");
  // The mower had $60 of bearings and $80 of labour scanned against it before
  // the customer said no. None of it was fitted and none of it is billed.
  check("its parts are not on the order",
    L.some((l) => l.item_code === "SHUQ 505180901"), false);
  console.log("\n-- the contact number, as it is read out --");
  // 9847 4578, not 98474578. Only a bare eight digits, which is every
  // Singapore number; anything else is left exactly as somebody typed it,
  // because the point is to make the familiar shape readable rather than to
  // reformat whatever turns up. No digit is ever added or dropped.
  const contactOn = async (number) => {
    const s = await data.slips.createSlip({
      company: "PHONE " + number, contact_name: "Mr Tan", contact_number: number,
      machines: [{ desc: "M1", serial: "1", remarks: "" }], signature: sig,
    });
    const id = s.machines[0].id;
    await data.slips.setMachineLabour(id, 10);
    await data.slips.createSlipOrder(s.slip_number, [id], "KS");
    const ls = (await data.slips.getSlipOrder(s.slip_number)).lines;
    return ls[ls.length - 1].description;
  };
  check("eight digits are split in the middle",
    await contactOn("98474578"), "Mr Tan 9847 4578");
  check("one already spaced is left alone",
    await contactOn("9847 4578"), "Mr Tan 9847 4578");
  check("a country code is left alone",
    await contactOn("+65 9847 4578"), "Mr Tan +65 9847 4578");
  check("an office line of seven digits is left alone",
    await contactOn("6293456"), "Mr Tan 6293456");
  check("and so is anything with words in it",
    await contactOn("98474578 (Ali)"), "Mr Tan 98474578 (Ali)");

  console.log("\n-- how the block ends --");
  // The contact sits under a blank row, the same gap that separates one
  // machine from the next. Without it the customer's name reads as another
  // line of the last machine's block, which is where somebody keying this in
  // puts it.
  const tail = L.slice(-3).map((l) => [l.item_code || "", l.description]);
  check("SubTotal, a blank row, then the contact",
    [tail[0][1], tail[1][1], tail[2][1]],
    ["SubTotal", "", "Rajesh Kumar 9123 4567"]);
  check("and all three are note lines, priced at nothing",
    tail.every((t) => t[0] === ""), true);

  const subTotals = L.filter((l) => l.description === "SubTotal").map((l) => l.line_amount);
  check("the two condemned blocks total nothing", subTotals, [98.5, 97.4, 0, 0]);
  const charged = L.filter((l) => l.item_code)
    .reduce((n, l) => n + (Number(l.unit_price) || 0) * (Number(l.quantity) || 0), 0);
  check("and the order is worth only the two repairs", Math.round(charged * 100) / 100, 195.9);

  console.log("\n-- the position still counts against the whole slip --");
  // "3/5", not "3/4": the customer's third machine of five, not the third on
  // this order. A slip converted in two goes still reads 1/5 ... 5/5.
  check("machine three of five",
    /- 3\/5$/.test(L.find((l) => /Corvette 200/.test(l.description || "")).description), true);

  console.log("\n-- and it is still in the workshop until somebody says otherwise --");
  slip = await data.slips.getSlip(no);
  check("a condemned machine on an order has still not left the building", slip.status, "PART_SO");
  await data.slips.setMachineDisposal(no, mower.id, "COLLECTED", "KS");
  await data.slips.setMachineDisposal(no, combi.id, "COLLECTED", "KS");
  slip = await data.slips.getSlip(no);
  // Still Partial SO, not All Repaired: the fifth machine has never been
  // touched. It used to read All Repaired here, which took the slip off the
  // technicians' list while a machine was still on their bench - the exact
  // way a machine gets forgotten.
  check("the fifth machine keeps it part-way", slip.status, "PART_SO");
  check("so the technicians still have it",
    (await data.slips.listSlips("working")).some((x) => x.slip_number === no), true);

  console.log("\n-- the block, as it would be keyed --\n");
  for (const l of L) {
    const code = (l.item_code || "").padEnd(18);
    const price = l.item_code ? String((Number(l.unit_price) || 0).toFixed(2)).padStart(8) : "";
    const amt = l.line_amount !== undefined ? String(Number(l.line_amount).toFixed(2)).padStart(8) : "";
    console.log(`  ${code}${(l.description || "").padEnd(62)}${price}${amt}`);
  }

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
