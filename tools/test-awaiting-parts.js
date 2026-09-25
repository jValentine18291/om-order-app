// test-awaiting-parts.js
// ============================================================================
// A part the shelf did not have holds the machine until it arrives.
//
// John's rule, 25 Sep 2026: a technician cannot put a part with no stock on a
// machine. The repair still needs it, so it is ordered and the machine is held.
// What this pins down:
//
//   1. Holding a machine records the part it is short of.
//   2. Asking twice for the same part does not hold it twice.
//   3. A held machine CANNOT be marked repaired, and the refusal names the part.
//   4. It can still be condemned or quoted while it waits - a machine can turn
//      out to be beyond repair WHILE waiting for a part.
//   5. Fitting the part lifts the hold by itself.
//   6. Saying it is no longer needed lifts the hold too.
//   7. A second missing part holds it again, and both must clear.
//
// Usage: node test-awaiting-parts.js C:/temp/scratch.db

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

console.log("\nA part with no stock holds the machine\n");

const slip = repo.createSlip({
  company: "GREENSCAPE PTE LTD",
  contact_name: "Mr Tan",
  machines: [{ desc: "EBZ5100 Blower", serial: "A1" }],
  signature: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  created_by: "KM",
});
const machineId = repo.getSlip(slip.slip_number).machines[0].id;

// ---- 1. the hold is recorded ------------------------------------------------
repo.holdMachineForPart(machineId, {
  item_code: "SZEN 848C006700",
  description: "Band, Strap",
  requested_by: "KM",
  request_id: 77,
});
let m = repo.getSlip(slip.slip_number).machines[0];
check("the machine is waiting for one part", m.awaiting.length, 1);
check("it names the part", m.awaiting[0].item_code, "SZEN 848C006700");
check("it carries the description", m.awaiting[0].description, "Band, Strap");
check("it remembers the order it raised", m.awaiting[0].request_id, 77);

// ---- 2. asking twice is still one hold --------------------------------------
const again = repo.holdMachineForPart(machineId, { item_code: "SZEN 848C006700", description: "Band, Strap" });
check("asking twice says so", again.already, true);
m = repo.getSlip(slip.slip_number).machines[0];
check("and does not hold it twice", m.awaiting.length, 1);

// ---- 3. a held machine is not repaired --------------------------------------
refuses(
  "it cannot be marked repaired while it waits",
  () => repo.setMachineState(slip.slip_number, machineId, "REPAIRED", "KM"),
  "Band, Strap"
);

// ---- 4. but the other decisions are all still open --------------------------
repo.setMachineState(slip.slip_number, machineId, "AWAITING_QUOTE", "KM");
check("it can still be sent for quoting", repo.getSlip(slip.slip_number).machines[0].state, "AWAITING_QUOTE");
repo.setMachineState(slip.slip_number, machineId, "CONDEMNED", "KM");
check("it can still be condemned while waiting", repo.getSlip(slip.slip_number).machines[0].state, "CONDEMNED");
repo.setMachineState(slip.slip_number, machineId, "TO_REPAIR", "KM");
check("and put back to repair", repo.getSlip(slip.slip_number).machines[0].state, "TO_REPAIR");

// ---- 5. fitting the part lifts the hold -------------------------------------
repo.addPartToMachine(machineId, {
  item_code: "SZEN 848C006700",
  description: "Band, Strap",
  unit_price: 8.5,
  quantity: 1,
  technician: "KM",
});
m = repo.getSlip(slip.slip_number).machines[0];
check("fitting the part lifts the hold", m.awaiting.length, 0);
repo.setMachineState(slip.slip_number, machineId, "REPAIRED", "KM");
check("and now it can be marked repaired", repo.getSlip(slip.slip_number).machines[0].state, "REPAIRED");

// ---- 6. or it was never needed ----------------------------------------------
repo.setMachineState(slip.slip_number, machineId, "TO_REPAIR", "KM");
repo.holdMachineForPart(machineId, { item_code: "SZEN 140051111", description: "Shoe Clutch" });
check("held again for a second part", repo.getSlip(slip.slip_number).machines[0].awaiting.length, 1);
const cleared = repo.clearAwaitingPart(machineId, "SZEN 140051111", "KM");
check("saying it is not needed clears it", cleared.cleared, 1);
check("nothing outstanding", repo.getSlip(slip.slip_number).machines[0].awaiting.length, 0);

// ---- 7. two at once, and both have to clear ---------------------------------
repo.holdMachineForPart(machineId, { item_code: "AAA 111", description: "Gasket" });
repo.holdMachineForPart(machineId, { item_code: "BBB 222", description: "Fuel Hose" });
check("waiting for two parts", repo.getSlip(slip.slip_number).machines[0].awaiting.length, 2);
refuses(
  "both are named in the refusal",
  () => repo.setMachineState(slip.slip_number, machineId, "REPAIRED", "KM"),
  "Gasket, Fuel Hose"
);
repo.clearAwaitingPart(machineId, "AAA 111", "KM");
refuses(
  "clearing one is not enough",
  () => repo.setMachineState(slip.slip_number, machineId, "REPAIRED", "KM"),
  "Fuel Hose"
);
repo.clearAwaitingPart(machineId, "BBB 222", "KM");
repo.setMachineState(slip.slip_number, machineId, "REPAIRED", "KM");
check("with both cleared it is repaired", repo.getSlip(slip.slip_number).machines[0].state, "REPAIRED");

// ---- a part code is required ------------------------------------------------
refuses("an empty code is refused", () => repo.holdMachineForPart(machineId, { item_code: "  " }), "part code is required");
refuses("an unknown machine is refused", () => repo.holdMachineForPart(999999, { item_code: "X" }), "Machine not found");

console.log(failures ? `\n${failures} FAILED\n` : "\nAll good.\n");
process.exit(failures ? 1 : 0);
