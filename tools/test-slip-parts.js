// Parts that belong to the SLIP and to no machine on it.
//
//   node tools/test-slip-parts.js C:/temp/scratch.db
//
// WHAT THESE ARE
// Asked for by the workshop, Sep 2026: something sold alongside a repair but
// fitted to no machine - a spare the customer takes away with them. Before
// this the only place to put one was on a machine it was never fitted to,
// which then billed it inside that machine's block on the Sales Order.
//
// THE RULES THIS GUARDS, worst consequence first
//
//  1. A loose part is NEVER billed twice. A slip is converted a few machines
//     at a time, so without a record of which order took them they would ride
//     along on every one. Each line carries its own converted_at, and a line
//     that has one is never offered again.
//  2. A loose part is never billed INSIDE a machine's block. It belongs to
//     nobody's machine; charging it under one puts it on a block whose
//     SubTotal the customer can add up.
//  3. It appears where John asked for it: at the foot of the order, under a
//     heading of its own, ABOVE the customer's contact line.
//  4. The slip does not read Converted while any of them are unbilled. A
//     converted slip is one nobody looks at again, so that is how they would
//     quietly never be charged for.
//  5. Every per-part action still works on one - price, quantity, wording,
//     delete. These reach the part through a different join from a machine's
//     part, and getting that wrong would have made them silently read-only.
//  6. The NOTE on the group never leaves the building. It is for the office to
//     write to each other, and a note somebody believes is private but is not
//     is worse than having nowhere to write one.
//  7. The migration carries every existing row across. It REBUILDS
//     machine_parts, because machine_id was NOT NULL and SQLite cannot relax
//     that in place, and a rebuild that loses rows loses repair history.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
function throws(what, fn, wantStatus) {
  try {
    fn();
    failures++;
    console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = !wantStatus || e.status === wantStatus;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${e.message}`);
  }
}

// ===========================================================================
// THE MIGRATION, in its own process against its own database.
//
// db.js opens one database for the life of a process, so this cannot share the
// scratch one below. The old shape is written out by hand here - that IS the
// thing being migrated from, and a copy of it has to live somewhere.
// ===========================================================================
function migrationCheck() {
  console.log("\n-- the migration carries every row across --");
  const old = target.replace(/\.db$/, "") + "-old.db";
  for (const f of [old, old + "-wal", old + "-shm"]) { try { fs.unlinkSync(f); } catch (_) {} }

  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(old);
  raw.exec(`
    CREATE TABLE service_slips (id INTEGER PRIMARY KEY AUTOINCREMENT, slip_number TEXT UNIQUE, company TEXT, status TEXT DEFAULT 'OPEN');
    CREATE TABLE slip_machines (id INTEGER PRIMARY KEY AUTOINCREMENT, slip_id INTEGER NOT NULL, machine_desc TEXT NOT NULL,
      FOREIGN KEY (slip_id) REFERENCES service_slips(id) ON DELETE CASCADE);
    -- machine_parts EXACTLY as it was before slip-level parts existed.
    CREATE TABLE machine_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL,
      item_code TEXT NOT NULL,
      description TEXT NOT NULL,
      uom TEXT DEFAULT 'UNIT',
      unit_price REAL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      variant TEXT DEFAULT '',
      technician TEXT,
      free_text INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (machine_id) REFERENCES slip_machines(id) ON DELETE CASCADE
    );
    INSERT INTO service_slips (slip_number, company) VALUES ('00001', 'OLD CO');
    INSERT INTO slip_machines (slip_id, machine_desc) VALUES (1, '525BX Blower');
    INSERT INTO machine_parts (machine_id, item_code, description, unit_price, quantity, technician, variant, free_text)
      VALUES (1, 'SZEN 123', 'Carburettor', 42.50, 2, 'WJ', '', 0),
             (1, 'A7 SVR WAREHOUSE', 'Welding', 30.00, 1, 'WJ', 'WELD', 1);
  `);
  raw.close();

  // db.js migrates on require, so requiring it IS running the migration.
  const out = execFileSync(process.execPath,
    ["-e", "require(process.argv[1]); console.log('MIGRATED')",
     path.resolve(__dirname, "..", "backend", "db.js")],
    { env: { ...process.env, OM_DB_PATH: old }, encoding: "utf8" });
  check("it ran", /MIGRATED/.test(out), true);
  check("and said what it did", /machine_parts can hold slip-level parts/.test(out), true);
  check("with nothing lost or found on the way",
    /rebuild MOVED|broken reference/.test(out), false);

  const after = new DatabaseSync(old);
  const rows = after.prepare("SELECT * FROM machine_parts ORDER BY id").all();
  check("both rows are still there", rows.length, 2);
  // Every column, not just the count: a rebuild that shifts a column silently
  // puts the price in the quantity.
  check("the first one is unchanged",
    [rows[0].id, rows[0].machine_id, rows[0].item_code, rows[0].description,
     rows[0].unit_price, rows[0].quantity, rows[0].technician, rows[0].free_text],
    [1, 1, "SZEN 123", "Carburettor", 42.5, 2, "WJ", 0]);
  check("and the free-text one kept its variant and its flag",
    [rows[1].item_code, rows[1].variant, rows[1].free_text], ["A7 SVR WAREHOUSE", "WELD", 1]);
  check("existing rows belong to a machine, not to a slip",
    rows.map((r) => r.slip_id), [null, null]);
  // The whole point of the rebuild.
  const cols = after.prepare("PRAGMA table_info(machine_parts)").all();
  check("machine_id may now be empty", cols.find((c) => c.name === "machine_id").notnull, 0);
  check("and there is somewhere to put the slip", !!cols.find((c) => c.name === "slip_id"), true);
  after.close();
  for (const f of [old, old + "-wal", old + "-shm"]) { try { fs.unlinkSync(f); } catch (_) {} }
}

migrationCheck();

// ===========================================================================
// THE BEHAVIOUR, against a fresh database of the new shape.
// ===========================================================================
process.env.OM_DB_PATH = target;
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));
const db = require(path.resolve(__dirname, "..", "backend", "db"));

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const slip = data.slips.createSlip({
  company: "GREENSCAPE PTE LTD", contact_name: "Mr Tan", contact_number: "91234567",
  signature: SIG,
  machines: [
    { desc: "525BX Blower", serial: "A1", remarks: "" },
    { desc: "EBZ8500 Blower", serial: "B2", remarks: "" },
  ],
});
const SLIP = slip.slip_number;
const machines = data.slips.getSlip(SLIP).machines;
const m1 = machines[0].id, m2 = machines[1].id;

const reload = () => data.slips.getSlip(SLIP);
const descs = (lines) => lines.map((l) => l.description);

(async () => {
  console.log("\n-- a part on the slip, on no machine --");
  let extras = data.slips.addPartToSlip(SLIP, {
    item_code: "SHUQ 5774", description: "Air filter", uom: "PC",
    unit_price: 12.00, quantity: 1, technician: "WJ",
  });
  check("it came back on the slip's own list", extras.map((p) => p.description), ["Air filter"]);
  let s = reload();
  check("the slip carries it", s.extras.map((p) => p.description), ["Air filter"]);
  // Rule 2. If it leaked into a machine it would be billed under that machine.
  check("and no machine has gained a part",
    s.machines.map((m) => (m.parts || []).length), [0, 0]);
  check("it names the slip and no machine",
    [s.extras[0].slip_id != null, s.extras[0].machine_id], [true, null]);

  console.log("\n-- the same part again stacks, as a machine's part does --");
  extras = data.slips.addPartToSlip(SLIP, {
    item_code: "SHUQ 5774", description: "Air filter", uom: "PC",
    unit_price: 12.00, quantity: 1, technician: "WJ",
  });
  check("still one line", extras.length, 1);
  check("now two of it", extras[0].quantity, 2);

  console.log("\n-- rule 5: every per-part action still reaches it --");
  const id = extras[0].id;
  data.slips.setPartQuantity(id, 3);
  check("quantity", reload().extras[0].quantity, 3);
  data.slips.setPartPrice(id, 13.5);
  check("price", reload().extras[0].unit_price, 13.5);
  // Only the free-text codes may be renamed, and a catalogue part may not -
  // the same rule a machine's part follows, reached through a different join.
  throws("a catalogue part still cannot be renamed",
    () => data.slips.setPartDescription(id, "Something else"), 400);
  data.slips.setPartQuantity(id, 2);
  check("and back to two", reload().extras[0].quantity, 2);

  console.log("\n-- a second loose part, and one of them removed --");
  data.slips.addPartToSlip(SLIP, {
    item_code: "SHUQ 5031", description: "Spark plug", uom: "PC",
    unit_price: 8.50, quantity: 1, technician: "WJ",
  });
  const plug = reload().extras.find((p) => p.description === "Spark plug");
  data.slips.addPartToSlip(SLIP, {
    item_code: "A8 SPARE PARTS", description: "Yellow Fuel Pipe", uom: "PC",
    unit_price: 3.00, quantity: 1, technician: "WJ", free_text: true,
  });
  check("three lines", reload().extras.map((p) => p.description),
    ["Air filter", "Spark plug", "Yellow Fuel Pipe"]);
  // Rule: declining an optional part is just deleting the line - John's call.
  data.slips.setPartQuantity(plug.id, 0);
  check("and removing one leaves two", reload().extras.map((p) => p.description),
    ["Air filter", "Yellow Fuel Pipe"]);

  console.log("\n-- an empty machine list means NO machines, not all of them --");
  // Caught in the browser, not here, which is why it is here now. An order for
  // the loose parts alone sends machine_ids: [], and the repository read an
  // empty LIST as "everything not yet converted" - the same as no list at all.
  // That swept in both untouched machines, failed the no-work-recorded check,
  // and from the screen looked exactly like the button doing nothing.
  {
    const fresh = data.slips.createSlip({
      company: "EMPTY LIST CO", contact_name: "B", contact_number: "2", signature: SIG,
      machines: [{ desc: "525BX Blower", serial: "Z1", remarks: "" }],
    });
    data.slips.addPartToSlip(fresh.slip_number, {
      item_code: "SHUQ 5774", description: "Air filter", uom: "PC",
      unit_price: 12, quantity: 1, technician: "WJ",
    });
    // The machine has NO work recorded on it, so sweeping it in would throw.
    const only = data.slips.createSlipOrder(fresh.slip_number, [], { extras: true });
    check("the order went through on the parts alone", only.extras_converted, 1);
    check("and took no machine with it", only.machines_converted, []);
    check("the machine is still waiting its turn",
      data.slips.getSlip(fresh.slip_number).machines[0].converted_at, null);
  }

  console.log("\n-- giving NO list still means everything outstanding --");
  {
    const fresh = data.slips.createSlip({
      company: "NO LIST CO", contact_name: "C", contact_number: "3", signature: SIG,
      machines: [{ desc: "125B Blower", serial: "Y1", remarks: "" }],
    });
    const mid = data.slips.getSlip(fresh.slip_number).machines[0].id;
    data.slips.setMachineLabour(mid, 30);
    const all = data.slips.createSlipOrder(fresh.slip_number, undefined, {});
    check("the machine went on without being named", all.machines_converted.length, 1);
  }

  console.log("\n-- rule 4: not Converted while they are unbilled --");
  // Give both machines something, so the machines alone would say Converted.
  for (const mid of [m1, m2]) {
    data.slips.addPartToMachine(mid, {
      item_code: "SZEN 100", description: "Gasket", uom: "PC",
      unit_price: 5, quantity: 1, technician: "WJ",
    });
    data.slips.setMachineLabour(mid, 20);
  }
  // Convert every machine but NOT the loose parts.
  const so1 = data.slips.createSlipOrder(SLIP, [m1, m2], { extras: false });
  check("both machines are on it", so1.machines_converted.length, 2);
  check("and none of the loose parts", so1.extras_converted, 0);
  check("so the slip is not finished", reload().status, "ALL_REPAIRED");

  console.log("\n-- rule 3: where they sit on the Sales Order --");
  const order1 = data.slips.getSlipOrder(SLIP, so1.so_number) || data.slips.getSlipOrder(SLIP);
  const d1 = descs(order1.lines);
  check("this order has no Additional parts block", d1.includes("Additional parts"), false);

  console.log("\n-- and now an order for the loose parts alone --");
  const so2 = data.slips.createSlipOrder(SLIP, [], { extras: true });
  check("two lines went on it", so2.extras_converted, 2);
  const order2 = data.slips.getSlipOrder(SLIP, so2.so_number);
  const d2 = descs(order2.lines);
  check("under a heading of their own", d2.includes("Additional parts"), true);
  check("both parts are on it",
    d2.filter((x) => x === "Air filter" || x === "Yellow Fuel Pipe"),
    ["Air filter", "Yellow Fuel Pipe"]);
  // Rule 3, exactly as John asked: bottom of the order, above the contact.
  const iHead = d2.indexOf("Additional parts");
  const iContact = d2.findIndex((x) => /Mr Tan/.test(x || ""));
  check("the heading comes before the contact", iHead < iContact && iHead >= 0, true);
  check("and a SubTotal closes the block",
    d2.slice(iHead).find((x) => x === "SubTotal") !== undefined, true);
  const sub = order2.lines.slice(iHead).find((l) => l.description === "SubTotal");
  check("adding up to what the two parts cost", sub.line_amount, 13.5 * 2 + 3);
  check("with the contact last", d2[d2.length - 1].includes("Mr Tan"), true);

  console.log("\n-- rule 1: never a second time --");
  check("the slip is finished now", reload().status, "CONVERTED");
  throws("and there is nothing left to convert",
    () => data.slips.createSlipOrder(SLIP, [], { extras: true }), 400);
  check("the lines remember which order took them",
    reload().extras.map((p) => p.so_number), [so2.so_number, so2.so_number]);

  console.log("\n-- a part added after they were billed is a NEW line --");
  // Merging into a billed line would change what the customer was charged for,
  // on a document this app cannot alter.
  data.slips.addPartToSlip(SLIP, {
    item_code: "SHUQ 5774", description: "Air filter", uom: "PC",
    unit_price: 13.5, quantity: 1, technician: "WJ",
  });
  const air = reload().extras.filter((p) => p.item_code === "SHUQ 5774");
  check("two Air filter lines, not one of three", air.map((p) => p.quantity), [2, 1]);
  check("the billed one is untouched", !!air[0].converted_at, true);
  check("and the new one is free to go on the next order", air[1].converted_at, null);
  check("which puts the slip back to work", reload().status, "ALL_REPAIRED");

  console.log("\n-- the quotation: Sales decide whether the customer sees them --");
  const withThem = data.slips.quotationForSlip(SLIP, undefined, {});
  check("included unless somebody says otherwise",
    descs(withThem.lines).includes("Additional parts"), true);
  check("and the screen is told there are some to choose about",
    [withThem.extras_available, withThem.extras_included], [3, 3]);

  const without = data.slips.quotationForSlip(SLIP, undefined, { extras: false });
  check("left off when asked", descs(without.lines).includes("Additional parts"), false);
  check("no loose part is anywhere on it",
    descs(without.lines).some((x) => x === "Air filter" || x === "Yellow Fuel Pipe"), false);
  check("the customer still sees the machines", descs(without.lines).some((x) => /525BX/.test(x || "")), true);
  // The point of the choice: it changes what the customer is asked to pay.
  check("and it costs less than the one with them", without.total < withThem.total, true);
  check("by exactly what they come to",
    Math.round((withThem.subtotal - without.subtotal) * 100) / 100,
    Math.round((13.5 * 2 + 3 + 13.5) * 100) / 100);

  console.log("\n-- rule 6: the note is for us, not for the customer --");
  {
    const SECRET = "Ah Seng to confirm price before ordering";
    data.slips.setSlipExtrasNote(SLIP, SECRET);
    check("it is kept against the slip", reload().extras_note, SECRET);

    // The two documents that leave the building. Neither may carry a word of
    // it - not in a line, not in a note row, not anywhere.
    const q = data.slips.quotationForSlip(SLIP, undefined, {});
    const onQuote = JSON.stringify(q.lines);
    check("not on the quotation with the parts included",
      onQuote.includes("Ah Seng"), false);

    const fresh = data.slips.createSlip({
      company: "NOTE CO", contact_name: "D", contact_number: "4", signature: SIG,
      machines: [{ desc: "125B Blower", serial: "N1", remarks: "" }],
    });
    data.slips.addPartToSlip(fresh.slip_number, {
      item_code: "SHUQ 5774", description: "Air filter", uom: "PC",
      unit_price: 12, quantity: 1, technician: "WJ",
    });
    data.slips.setSlipExtrasNote(fresh.slip_number, SECRET);
    const so = data.slips.createSlipOrder(fresh.slip_number, [], { extras: true });
    const order = data.slips.getSlipOrder(fresh.slip_number, so.so_number);
    check("nor on the Sales Order", JSON.stringify(order.lines).includes("Ah Seng"), false);
    // The parts themselves still went on, so this is not passing by accident.
    check("while the parts it is about did go on",
      descs(order.lines).includes("Air filter"), true);

    // A machine's repair comment DOES print, as "*comment". The difference is
    // deliberate and worth pinning down, or somebody will one day make them
    // consistent with each other and put this in front of a customer.
    const mid = data.slips.getSlip(fresh.slip_number).machines[0].id;
    data.slips.setMachineComment(mid, "Carburettor cleaned");
    data.slips.setMachineLabour(mid, 20);
    const so2 = data.slips.createSlipOrder(fresh.slip_number, [mid], {});
    const order2 = data.slips.getSlipOrder(fresh.slip_number, so2.so_number);
    check("a MACHINE's comment still prints, as it always has",
      descs(order2.lines).includes("*Carburettor cleaned"), true);
  }

  console.log("\n-- the note is editable, and clearable --");
  {
    data.slips.setSlipExtrasNote(SLIP, "  spaced out  ");
    check("trimmed on the way in", reload().extras_note, "spaced out");
    data.slips.setSlipExtrasNote(SLIP, "");
    check("and emptying it empties it", reload().extras_note, "");
  }

  console.log("\n-- a second contact on the slip --");
  {
    const two = data.slips.createSlip({
      company: "TWO CONTACTS PTE LTD", contact_name: "Mr Tan",
      contact_number: "62734000", whatsapp_number: "91234567",
      contact2_name: "Ah Meng", contact2_number: "98765432",
      signature: SIG,
      machines: [{ desc: "525BX Blower", serial: "T1", remarks: "" }],
    });
    const got = data.slips.getSlip(two.slip_number);
    check("both are kept", [got.contact2_name, got.contact2_number], ["Ah Meng", "98765432"]);

    // The route names every field it forwards rather than spreading the body,
    // which is right - nothing a client invents reaches the database - but it
    // means a new field has to be added there TOO. contact2 was added to the
    // table, the repository and the form, and still arrived empty, because the
    // route quietly dropped it on the way past. Nothing failed; it was simply
    // not there. Found by posting through HTTP rather than calling the
    // repository, which is why this is checked at the source.
    const server = fs.readFileSync(
      path.resolve(__dirname, "..", "backend", "server.js"), "utf8");
    const createRoute = server.slice(server.indexOf('app.post("/api/slips"'),
                                     server.indexOf('app.post("/api/slips"') + 1200);
    for (const f of ["contact2_name", "contact2_number"]) {
      // Twice: once destructured off the body, once handed to createSlip.
      check(`the create route passes ${f} on`,
        (createRoute.match(new RegExp(f, "g")) || []).length >= 2, true);
    }

    // The one list everything else reads. The FIRST contact answers on its
    // WhatsApp number where it has one, because a company's office line is
    // often not on WhatsApp; the second's number IS its WhatsApp number.
    const people = data.slips.slipContacts(got);
    check("two people can be reached",
      people.map((c) => [c.id, c.name, c.number]),
      [[1, "Mr Tan", "91234567"], [2, "Ah Meng", "98765432"]]);

    // The Sales Order carries both, at the foot, as John asked - and the FIRST
    // line keeps the contact number rather than the WhatsApp one, because that
    // line is who the office rings, not who the slip was messaged to.
    const mid = got.machines[0].id;
    data.slips.setMachineLabour(mid, 40);
    const so = data.slips.createSlipOrder(two.slip_number, [mid], {});
    const lines = data.slips.getSlipOrder(two.slip_number, so.so_number).lines;
    const tail = lines.slice(-2).map((l) => l.description);
    check("both contacts close the order", tail, ["Mr Tan 6273 4000", "Ah Meng 9876 5432"]);
    check("and they are the last thing on it",
      lines[lines.length - 1].description, "Ah Meng 9876 5432");
  }

  console.log("\n-- one contact still reads exactly as it did --");
  {
    const one = data.slips.createSlip({
      company: "ONE CONTACT PTE LTD", contact_name: "Mr Lim",
      contact_number: "61112222", signature: SIG,
      machines: [{ desc: "125B Blower", serial: "O1", remarks: "" }],
    });
    const got = data.slips.getSlip(one.slip_number);
    check("one person to reach", data.slips.slipContacts(got).map((c) => c.number), ["61112222"]);
    const mid = got.machines[0].id;
    data.slips.setMachineLabour(mid, 25);
    const so = data.slips.createSlipOrder(one.slip_number, [mid], {});
    const lines = data.slips.getSlipOrder(one.slip_number, so.so_number).lines;
    check("one contact line, as before", lines[lines.length - 1].description, "Mr Lim 6111 2222");
    // A blank line above it, not two - a slip with no second contact must not
    // grow a gap where one would have been.
    check("with a single blank above it", lines[lines.length - 2].description, "");
  }

  console.log("\n-- a second contact can be added afterwards, and is recorded --");
  {
    const later = data.slips.createSlip({
      company: "LATER CO", contact_name: "Mr Ong", contact_number: "63334444",
      signature: SIG, machines: [{ desc: "525RX Trimmer", serial: "L1", remarks: "" }],
    });
    data.slips.updateSlipDetails(later.slip_number, {
      contact2_name: "Siti", contact2_number: "95556666", who: "KS",
    });
    const got = data.slips.getSlip(later.slip_number);
    check("it is on the slip now", data.slips.slipContacts(got).length, 2);
    // The customer signed a slip without them, so adding one is an amendment
    // like any other change to what they signed.
    const logged = (got.amendments || []).map((a) => [a.field, a.before, a.after]);
    check("and the change is on the record", logged, [
      ["Second contact name", "", "Siti"],
      ["Second contact number", "", "95556666"],
    ]);
  }

  console.log("\n-- a closed slip takes no more of them --");
  const other = data.slips.createSlip({
    company: "SHUT CO", contact_name: "A", contact_number: "1", signature: SIG,
    machines: [{ desc: "125B Blower", serial: "C3", remarks: "" }],
  });
  db.prepare("UPDATE service_slips SET status = 'CLOSED' WHERE slip_number = ?").run(other.slip_number);
  throws("refused, and said why",
    () => data.slips.addPartToSlip(other.slip_number, {
      item_code: "SHUQ 5774", description: "Air filter", unit_price: 12, quantity: 1,
    }), 409);
  throws("and takes no note either",
    () => data.slips.setSlipExtrasNote(other.slip_number, "too late"), 409);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
