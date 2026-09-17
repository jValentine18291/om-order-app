// delete-slip.js
// ============================================================================
// Deletes ONE service slip, named on the command line. For a test slip, or one
// registered by mistake that must not sit in the list looking real.
//
// Its sibling purge-test-slips.js empties the whole table and resets the
// counter, which is the right tool once, when going live. This is the right
// tool afterwards, when everything around the slip is real.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node delete-slip.js 00068             <- shows what WOULD go. Deletes nothing.
//   node delete-slip.js 00068 --confirm   <- takes a backup, then deletes.
//
// THE SLIP NUMBER IS NOT OPTIONAL and there is no "delete the last one" or
// "delete all test ones". purge-test-slips.js earned that rule the hard way:
// it was run, two real slips were opened, it was run again, and they went.
// A tool that can only act on a number somebody typed cannot do that.
//
// WHAT GOES
//   the slip, and with it, by cascade:
//     slip_machines     - the machines on it
//     machine_parts     - every part scanned against those machines
//     slip_signatures   - the customer's signature
//     slip_amendments   - the record of changes made after signing
//   and, deleted explicitly because it does NOT cascade:
//     slip_quotations   - any Repair Quotation numbers issued for it
//
// slip_quotations is keyed by slip_number rather than by slip id, so the
// database will not remove it on its own. Left behind, the numbers QT-00068,
// QT-00068-2 would stay reserved against a slip that no longer exists.
//
// WHAT DOES NOT HAPPEN
// The counter is NOT rewound. Slip 00068 stays used and the next slip is still
// 00069, leaving a gap in the numbering. That is deliberate: a slip number may
// already have been said out loud to a customer, written on a job sheet, or
// printed on a PDF that left the building. Two different slips sharing one
// number is a worse problem than a gap, and a gap is self-explaining.
//
// IT REFUSES a slip whose machines have gone onto a Sales Order. That is work
// that exists outside this database - possibly inside AutoCount - and deleting
// the app's copy would leave an order pointing at nothing. If such a slip
// genuinely has to go, the Sales Order has to be dealt with first.
// ============================================================================

const path = require("path");
const { execFileSync } = require("child_process");

// CHECKED BEFORE db.js IS LOADED, and that ordering is the whole point.
//
// backup-db.js backs up backend/om_orders.db and takes no path argument, so
// pointing db.js somewhere else with OM_DB_PATH would give this script a
// backup of a file it is not about to change. The promise at the top of this
// file - that nothing is deleted without a backup first - would then be false
// in exactly the situation where somebody thought they were being careful.
//
// It has to happen up here because requiring db.js OPENS the database, and a
// bad path dies inside node:sqlite with "unable to open database file" and a
// stack trace, which is no way to learn you had a variable set.
if (process.env.OM_DB_PATH) {
  console.log("");
  console.log("OM_DB_PATH is set, so this is not the database backup-db.js");
  console.log("would back up. Refusing, because the backup would be of the");
  console.log("wrong file.");
  console.log("");
  console.log("To work on a copy, copy the file by hand and run this from a");
  console.log("folder whose om_orders.db IS that copy.");
  console.log("");
  process.exit(1);
}

const db = require("./db");

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const NUMBER = args.find((a) => !a.startsWith("--")) || "";

function main() {
  if (!NUMBER) {
    console.log("");
    console.log("Which slip? The number is required:");
    console.log("");
    console.log("    node delete-slip.js 00068            <- shows what would go");
    console.log("    node delete-slip.js 00068 --confirm  <- backs up, then deletes");
    console.log("");
    process.exit(1);
  }

  const slip = db
    .prepare("SELECT * FROM service_slips WHERE slip_number = ?")
    .get(NUMBER);

  if (!slip) {
    console.log("");
    console.log(`There is no slip ${NUMBER} in this database. Nothing to do.`);
    console.log("");
    console.log("If you expected one, check you are on the server and not a copy:");
    console.log("    " + path.join(__dirname, "om_orders.db"));
    console.log("");
    process.exit(1);
  }

  const machines = db
    .prepare("SELECT * FROM slip_machines WHERE slip_id = ? ORDER BY id")
    .all(slip.id);
  const partCount = machines.length
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM machine_parts
            WHERE machine_id IN (${machines.map(() => "?").join(",")})`
        )
        .get(...machines.map((m) => m.id)).n
    : 0;
  const signature = db
    .prepare("SELECT COUNT(*) AS n FROM slip_signatures WHERE slip_id = ?")
    .get(slip.id).n;
  const amendments = db
    .prepare("SELECT COUNT(*) AS n FROM slip_amendments WHERE slip_id = ?")
    .get(slip.id).n;
  const quotations = db
    .prepare("SELECT ref FROM slip_quotations WHERE slip_number = ? ORDER BY seq")
    .all(NUMBER);

  // ---- show it, always -----------------------------------------------------
  // Printed before anything is decided, because "00068" on a command line is
  // four characters and says nothing about whose machines these are.
  console.log("");
  console.log(`Slip ${slip.slip_number}`);
  console.log("-".repeat(60));
  console.log(`  company        ${slip.company}`);
  console.log(`  contact        ${slip.contact_name || "-"}   ${slip.contact_number || "-"}`);
  console.log(`  whatsapp       ${slip.whatsapp_number || "-"}`);
  console.log(`  status         ${slip.status}`);
  console.log(`  registered     ${slip.created_at || "-"}  by ${slip.created_by || "-"}`);
  if (slip.drive_link) console.log(`  drive copy     ${slip.drive_link}`);
  console.log("");
  console.log(`  machines       ${machines.length}`);
  for (const m of machines) {
    const so = m.so_number ? `   -> Sales Order ${m.so_number}` : "";
    console.log(`     ${String(m.machine_desc).slice(0, 40).padEnd(40)} ${String(m.serial_no || "").padEnd(16)}${so}`);
  }
  console.log(`  part lines     ${partCount}`);
  console.log(`  signature      ${signature ? "yes" : "no"}`);
  console.log(`  amendments     ${amendments}`);
  console.log(`  quotations     ${quotations.length ? quotations.map((q) => q.ref).join(", ") : "none"}`);
  console.log("");

  // ---- the one thing it will not do ---------------------------------------
  const onOrder = machines.filter((m) => m.so_number || m.converted_at);
  if (onOrder.length) {
    console.log("REFUSING: this slip's work has gone onto a Sales Order.");
    console.log("");
    for (const m of onOrder) {
      console.log(`  ${m.machine_desc}  ->  ${m.so_number || "(converted)"}`);
    }
    console.log("");
    console.log("That order exists outside this database and may already be in");
    console.log("AutoCount. Deleting the slip would leave it pointing at nothing.");
    console.log("Deal with the order first.");
    console.log("");
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log("Nothing has been deleted.");
    console.log("If that is the slip you mean, run:");
    console.log("");
    console.log(`    node delete-slip.js ${slip.slip_number} --confirm`);
    console.log("");
    console.log(`The counter is NOT rewound - the next slip stays ${String(Number(slip.slip_number) + 1).padStart(5, "0")}`);
    console.log("or higher, and a gap is left where this one was. That is on purpose:");
    console.log("a number already given to a customer must never be handed out twice.");
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
    console.error("Fix the backup first - it is the only way back from this.");
    process.exit(1);
  }

  // ---- delete --------------------------------------------------------------
  // One transaction: the quotations and the slip go together, or neither does.
  // Everything else follows by cascade, which db.js turns on for every
  // connection - without that the machines and parts would be orphaned rather
  // than removed.
  const dropQuotes = db.prepare("DELETE FROM slip_quotations WHERE slip_number = ?");
  const dropSlip = db.prepare("DELETE FROM service_slips WHERE id = ?");

  const tx = db.transaction(() => {
    const q = dropQuotes.run(NUMBER).changes;
    const s = dropSlip.run(slip.id).changes;
    return { q, s };
  });
  const done = tx();

  console.log("");
  console.log("Done.");
  console.log(`  deleted slip ${slip.slip_number} (${slip.company})`);
  console.log(`    ${machines.length} machine(s), ${partCount} part line(s), ${signature} signature(s), ${amendments} amendment(s)`);
  if (done.q) console.log(`    ${done.q} quotation number(s) released`);
  console.log("  the counter was left alone - the numbering now has a gap here");
  console.log("");

  const left = db
    .prepare("SELECT COUNT(*) AS n FROM service_slips WHERE slip_number = ?")
    .get(NUMBER).n;
  if (left) {
    console.error("WARNING: the slip is still there. Tell Claude.");
    process.exit(1);
  }
}

main();
