// purge-test-slips.js
// ============================================================================
// Deletes every SERVICE SLIP from the app's own database, for going live after
// a period of testing. Nothing else is touched: the purchasing Orders list,
// the Sales Orders, the staff list, prices and push subscriptions all stay.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node purge-test-slips.js            <- shows what WOULD go. Deletes nothing.
//   node purge-test-slips.js --confirm  <- takes a backup, then deletes.
//
// It will not delete anything without --confirm, and it takes a fresh backup
// first even then. If the backup fails, nothing is deleted.
//
// WHAT GOES
//   service_slips, and with them (the database cascades these):
//     slip_machines      - the machines on each slip
//     machine_parts      - every part scanned against them
//     slip_signatures    - the customer signatures
//   The slip counter is reset, so the first live slip is 00001.
//
// WHAT STAYS
//   orders / order_lines   - the Sales Orders raised from those slips
//   part_requests          - the purchasing Orders list
//   items, counters.so_number, staff, prices, push subscriptions
//
// ONE THING IT ALSO DOES, AND WHY
// A Sales Order remembers its slip only as a note reading "S/S: 00001". With
// the slips gone and the counter reset, a NEW live slip 00001 would look up
// that note and find the OLD test order sitting behind it. So the kept orders
// have their note relabelled "TEST S/S: 00001" - they remain, fully readable
// by their SO number, but a live slip can never pick one up by accident.
//
// WHAT THIS CANNOT UNDO
// Sales Orders that were pushed into AutoCount are AutoCount's documents now.
// Deleting the app's copy does not remove them; if those test documents should
// go, they have to be cancelled in AutoCount itself.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const db = require("./db");
const CONFIRM = process.argv.includes("--confirm");

function count(sql) {
  try { return db.prepare(sql).get().n; } catch (_) { return 0; }
}

function main() {
  const slips = count("SELECT COUNT(*) AS n FROM service_slips");
  const machines = count("SELECT COUNT(*) AS n FROM slip_machines");
  const parts = count("SELECT COUNT(*) AS n FROM machine_parts");
  const signatures = count("SELECT COUNT(*) AS n FROM slip_signatures");
  const orders = count("SELECT COUNT(*) AS n FROM orders");
  const requests = count("SELECT COUNT(*) AS n FROM part_requests");
  const counter = (() => {
    const r = db.prepare("SELECT value FROM counters WHERE name = 'slip_number'").get();
    return r ? r.value : 0;
  })();

  console.log("");
  console.log("In the database right now");
  console.log("-------------------------");
  console.log(`  service slips          ${slips}`);
  console.log(`    their machines       ${machines}`);
  console.log(`    parts on them        ${parts}`);
  console.log(`    signatures           ${signatures}`);
  console.log(`  slip counter is at     ${counter}  (next slip would be ${String(counter + 1).padStart(5, "0")})`);
  console.log("");
  console.log("  Sales Orders           " + orders + "   <- KEPT");
  console.log("  purchasing requests    " + requests + "   <- KEPT");
  console.log("");

  if (!slips) {
    console.log("There are no service slips to delete. Nothing to do.");
    return;
  }

  // The slips themselves, so it is obvious these are the test ones.
  const list = db.prepare(
    "SELECT slip_number, company, status, created_at FROM service_slips ORDER BY slip_number"
  ).all();
  console.log("The slips that would be deleted");
  console.log("-------------------------------");
  for (const s of list) {
    console.log(`  ${s.slip_number}  ${String(s.company).slice(0, 34).padEnd(34)} ${String(s.status).padEnd(12)} ${String(s.created_at || "").slice(0, 10)}`);
  }
  console.log("");

  // A SECOND SAFETY, LEARNED THE HARD WAY.
  //
  // This script was run once to clear the test data, two real slips were
  // opened afterwards, and it was run again - deleting them. --confirm alone
  // is not enough, because the list it prints is not the list anyone approved
  // minutes earlier. So the slip numbers being deleted must be named on the
  // command line as well:
  //
  //   node purge-test-slips.js --confirm --slips 00001,00002,00003
  //
  // Anything that has appeared since is then refused by name rather than
  // quietly swept up with the rest.
  const named = (() => {
    const i = process.argv.indexOf("--slips");
    return i >= 0 && process.argv[i + 1]
      ? process.argv[i + 1].split(",").map((x) => x.trim()).filter(Boolean)
      : null;
  })();

  if (CONFIRM && !named) {
    console.log("Refusing to delete without being told WHICH slips.");
    console.log("Check the list above, then repeat it back:");
    console.log("");
    console.log(`    node purge-test-slips.js --confirm --slips ${list.map((s) => s.slip_number).join(",")}`);
    console.log("");
    console.log("This exists because the list can change between one run and the");
    console.log("next - a slip opened in between would otherwise be deleted too.");
    return;
  }

  if (CONFIRM) {
    const have = new Set(list.map((s) => s.slip_number));
    const unexpected = list.filter((s) => !named.includes(s.slip_number));
    const absent = named.filter((n) => !have.has(n));
    if (unexpected.length || absent.length) {
      console.log("STOPPING — the database does not match what you named.");
      if (unexpected.length) {
        console.log("");
        console.log("  In the database but NOT in your list (opened since?):");
        for (const s of unexpected) console.log(`    ${s.slip_number}  ${s.company}`);
      }
      if (absent.length) {
        console.log("");
        console.log("  Named but not in the database: " + absent.join(", "));
      }
      console.log("");
      console.log("Nothing has been deleted. Look at the list above and run again");
      console.log("with the numbers you actually mean.");
      console.log("");
      return;
    }
  }

  if (!CONFIRM) {
    console.log("Nothing has been deleted.");
    console.log("Check the list above. If it is all test data, run:");
    console.log("");
    console.log(`    node purge-test-slips.js --confirm --slips ${list.map((s) => s.slip_number).join(",")}`);
    console.log("");
    console.log("Naming them means a slip opened between now and then is refused");
    console.log("rather than deleted along with the rest.");
    console.log("");
    return;
  }

  // ---- backup first, always ------------------------------------------------
  console.log("Taking a backup first…");
  try {
    execFileSync(process.execPath, [path.join(__dirname, "backup-db.js")], { stdio: "inherit" });
  } catch (e) {
    console.error("");
    console.error("The backup FAILED, so nothing has been deleted.");
    console.error("Fix the backup first — it is the only way back from this.");
    process.exit(1);
  }

  // ---- delete --------------------------------------------------------------
  // One transaction: either every slip goes and the counter resets, or nothing
  // changes at all.
  const relabel = db.prepare(
    "UPDATE orders SET notes = 'TEST ' || notes WHERE notes LIKE 'S/S: %'"
  );
  const wipe = db.prepare("DELETE FROM service_slips");
  const reset = db.prepare("UPDATE counters SET value = 0 WHERE name = 'slip_number'");

  const tx = db.transaction(() => {
    const relabelled = relabel.run().changes;
    wipe.run();
    reset.run();
    return relabelled;
  });
  const relabelled = tx();

  console.log("");
  console.log("Done.");
  console.log(`  deleted   ${slips} slip(s), ${machines} machine(s), ${parts} part line(s), ${signatures} signature(s)`);
  console.log(`  relabelled ${relabelled} Sales Order note(s) to "TEST S/S: …" so a live slip cannot pick one up`);
  console.log("  slip counter reset — the next slip will be 00001");
  console.log("");
  console.log(`  left alone: ${orders} Sales Order(s), ${requests} purchasing request(s)`);
  console.log("");
  console.log("Sales Orders already pushed into AutoCount are AutoCount's own");
  console.log("documents and are NOT affected. Cancel those in AutoCount if the");
  console.log("test ones should go.");
  console.log("");

  const left = count("SELECT COUNT(*) AS n FROM service_slips");
  if (left) {
    console.error(`WARNING: ${left} slip(s) are still there. Tell Claude.`);
    process.exit(1);
  }
}

main();
