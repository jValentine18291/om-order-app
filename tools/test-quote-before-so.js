// test-quote-before-so.js
// ============================================================================
// A machine that needs quoting cannot go on a Sales Order until the customer
// has been told the price and said to go ahead. John's rule, 25 Sep 2026.
//
// "Needs quoting" is BOTH the slip's "Customer wants a quote first" flag and a
// machine actually out for quoting - his call, so that a machine nobody got
// round to sending for quoting is caught too. That is the case the flag exists
// for, and a state-only rule would let it straight through.
//
// Condemned machines are exempt: beyond repair is not a repair being quoted
// for, and they still leave on an order at nothing.
//
// Usage: node test-quote-before-so.js C:/temp/scratch.db

const path = require("path");

const dbPath = process.argv[2];
if (!dbPath) {
  console.log(`Give a scratch database path, e.g. node ${path.basename(__filename)} C:/temp/scratch.db`);
  process.exit(1);
}
process.env.OM_DB_PATH = dbPath;

const repo = require("../backend/data/sqliteRepo").slips;

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${name}`);
}
function refuses(name, fn, contains) {
  try {
    fn();
    failures++;
    console.log(`  FAIL ${name} — it was allowed`);
  } catch (e) {
    const hit = String(e.message).includes(contains);
    if (!hit) { failures++; console.log(`  FAIL ${name}\n       message was: ${e.message}\n       expected it to mention: ${contains}`); }
    else console.log(`  ok   ${name}`);
  }
}
function allows(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name} — refused with: ${e.message}`); }
}

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const work = (mid) => repo.addPartToMachine(mid, {
  item_code: "SZEN 140051111", description: "Shoe Clutch",
  unit_price: 9.5, quantity: 1, technician: "KM",
});

console.log("\nA quote has to be answered before the machine is billed\n");

// ============================================================================
// A slip marked "quote first".
// ============================================================================
const qf = repo.createSlip({
  company: "GREENSCAPE PTE LTD", contact_name: "Mr Tan", quote_first: true,
  machines: [{ desc: "EBZ5100 Blower", serial: "A1" }, { desc: "EBZ8500 Blower", serial: "B2" }],
  signature: SIG, created_by: "KM",
});
let ms = repo.getSlip(qf.slip_number).machines;
const [a, b] = [ms[0].id, ms[1].id];
work(a); work(b);

ms = repo.getSlip(qf.slip_number).machines;
check("a quote-first machine nobody sent for quoting is blocked",
  ms[0].quote_block, "This slip is marked quote first. Quote it and get the customer's go-ahead.");
refuses("and the order is refused, naming the machine",
  () => repo.createSlipOrder(qf.slip_number, [a]), "EBZ5100 Blower");

// Sent for quoting, still not answered.
repo.setMachineState(qf.slip_number, a, "AWAITING_QUOTE", "KM");
check("sent for quoting, still blocked",
  repo.getSlip(qf.slip_number).machines[0].quote_block, "Still waiting to be quoted.");
refuses("still refused", () => repo.createSlipOrder(qf.slip_number, [a]), "Still waiting to be quoted");

// Quoted, waiting on the customer.
repo.setMachineState(qf.slip_number, a, "QUOTED", "KM");
check("quoted but unanswered, still blocked",
  repo.getSlip(qf.slip_number).machines[0].quote_block,
  "Quoted — waiting for the customer to say go ahead.");
refuses("still refused", () => repo.createSlipOrder(qf.slip_number, [a]), "waiting for the customer");

// The customer says go ahead.
repo.setMachineState(qf.slip_number, a, "TO_REPAIR", "KM");
check("once they say go ahead it is clear", repo.getSlip(qf.slip_number).machines[0].quote_block, "");

// ---- one machine clear does not carry the other ----------------------------
refuses("the other machine is still named on its own",
  () => repo.createSlipOrder(qf.slip_number, [a, b]), "EBZ8500 Blower");
allows("but the confirmed one goes on an order by itself",
  () => repo.createSlipOrder(qf.slip_number, [a]));

// ---- condemned is exempt ----------------------------------------------------
repo.setMachineState(qf.slip_number, b, "CONDEMNED", "KM");
check("a condemned machine is not held back", repo.getSlip(qf.slip_number).machines[1].quote_block, "");
allows("and goes on an order without a quote", () => repo.createSlipOrder(qf.slip_number, [b]));

// ============================================================================
// An ordinary slip - no quote asked for.
// ============================================================================
const plain = repo.createSlip({
  company: "OCS GROUP", contact_name: "Mr Lim",
  machines: [{ desc: "525BX Blower", serial: "C3" }],
  signature: SIG, created_by: "KM",
});
const p = repo.getSlip(plain.slip_number).machines[0].id;
work(p);
check("an ordinary machine is not blocked", repo.getSlip(plain.slip_number).machines[0].quote_block, "");
allows("and goes straight on an order", () => repo.createSlipOrder(plain.slip_number, [p]));

// ---- but sending an ordinary machine for quoting DOES block it --------------
const plain2 = repo.createSlip({
  company: "OCS GROUP", contact_name: "Mr Lim",
  machines: [{ desc: "323R Trimmer", serial: "D4" }],
  signature: SIG, created_by: "KM",
});
const p2 = repo.getSlip(plain2.slip_number).machines[0].id;
work(p2);
repo.setMachineState(plain2.slip_number, p2, "QUOTED", "KM");
check("a machine out for quoting is blocked even off a quote-first slip",
  repo.getSlip(plain2.slip_number).machines[0].quote_block,
  "Quoted — waiting for the customer to say go ahead.");
refuses("and refused", () => repo.createSlipOrder(plain2.slip_number, [p2]), "waiting for the customer");
repo.setMachineState(plain2.slip_number, p2, "TO_REPAIR", "KM");
allows("cleared once they say go ahead", () => repo.createSlipOrder(plain2.slip_number, [p2]));

console.log(failures ? `\n${failures} FAILED\n` : "\nAll good.\n");
process.exit(failures ? 1 : 0);
