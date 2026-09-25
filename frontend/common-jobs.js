// common-jobs.js
// ============================================================================
// The jobs that come up on any machine, as buttons.
//
// THIS IS THE FILE TO EDIT WHEN A PRICE CHANGES, or when a job is added or
// taken away. Nothing else needs touching - the buttons, the lines they add
// and the wording on the Sales Order all read from here. Bump the cache
// version in sw.js afterwards or phones keep the old prices.
//
// Asked for by the technicians, 14 Sep 2026, after the fogger tube buttons:
// the same three lines were being typed onto slip after slip. The yellow fuel
// pipe joined them on 21 Sep 2026, for the same reason.
//
// WHY THESE LINES NEED A TABLE AT ALL
// They are not catalogue parts. A6 to A8 are AutoCount's SERVICE items - the
// accounts want the work under one code - so the code says nothing about what
// was actually done, and the price is ours rather than the catalogue's.
//
// A8 "Spare Parts Of Equipment" is the code for a consumable the catalogue
// does not carry a part number for. The yellow fuel pipe is cut off a roll
// and has none, which is exactly what A8 is there to hold.
//
// TWO OF THEM SHARE ONE CODE. Welding and a carburettor service are both
// "A7 SVR WAREHOUSE" and they are not the same job, at not the same price. So
// each carries its own `id`, which is written to the line's `variant` - the
// same field the fogger tubes use, and for the same reason: without it the
// server would merge a $30 weld and a $0 carb service into one line at a
// figure that is neither. The ids must not collide with a tube type.
//
// THE DESCRIPTION IS THE BUTTON'S TITLE, not AutoCount's. AutoCount calls both
// of these "Warehouse Service", which on a customer's invoice would be two
// identical lines at different prices. A6 to A8 are free-text codes in this
// app precisely so the line can say what the work was, and a technician can
// still edit the wording afterwards with the pencil.
(function () {
  "use strict";

  var JOBS = [
    // id     title                          code                  qty  price
    { id: "WELD", title: "Welding",
      code: "A7 SVR WAREHOUSE",    qty: 1, price: 30.00 },
    { id: "OIL",  title: "Change Engine Oil",
      code: "A6 SVR ENGINE OIL",   qty: 1, price: 9.00 },
    // Priced at nothing ON PURPOSE. It records that the carburettor was
    // serviced; the money for it goes in the machine's Labour Charge. So it is
    // NOT flagged as a line waiting for a price the way an unpriced catalogue
    // part is - see zeroIsDeliberate().
    { id: "CARB", title: "Service Carburetor & Labour",
      code: "A7 SVR WAREHOUSE",    qty: 1, price: 0.00 },
    // The same service WITHOUT the labour, John's ask on 26 Sep 2026. Its own
    // id because it shares "A7 SVR WAREHOUSE" with the weld and the one above:
    // the server merges lines matching on code alone, and a $30 weld, a carb
    // service and this would collapse into one line at a figure that is none
    // of them. Priced at nothing on purpose like its neighbour, and the
    // technician types what it came to - zeroIsDeliberate() reads this table,
    // so it is not flagged as a line waiting for a price.
    { id: "CARBSVC", title: "Service Carburetor",
      code: "A7 SVR WAREHOUSE",    qty: 1, price: 0.00 },
    // One pipe per tap. These lines never merge - see addPartToMachine - so a
    // machine that took two gets two lines, or one line the technician steps
    // up to 2 with the stepper. Either reads the same on the Sales Order.
    { id: "PIPE", title: "Yellow Fuel Pipe",
      code: "A8 SPARE PARTS",      qty: 1, price: 3.00 },
    // NOT A LINE. This one writes a comment and adds nothing to the bill -
    // `comment` instead of a code and a price, which is what tells the two
    // kinds apart everywhere below.
    //
    // It is here rather than somewhere of its own because it belongs to the
    // same habit: a technician looks at a machine, decides it needs nothing,
    // and has to say so on the paperwork. It comes out on the quotation and
    // the Sales Order as "*No servicing", the same asterisk any other repair
    // comment gets, because that is what it is.
    { id: "NOSVC", title: "No Servicing", comment: "No servicing" },

    // ---- Foggers only -----------------------------------------------------
    // `foggers: true` keeps these two off every chainsaw and trimmer job. An
    // HS-B6 plug belongs to a PulsFOG and nothing else, and the buttons above
    // are already five wide.
    //
    // They are here rather than in fogger-tubes.js because they are ordinary
    // jobs - one code, one price, one piece - and a tube is not: a tube is a
    // FRACTION of a roll and that file exists to do that arithmetic. Two
    // tables for "a button that adds a priced line" would be one table too
    // many.
    //
    // THE SPARK PLUG IS A REAL CATALOGUE PART, the first of these that is.
    // AutoCount holds it as M0815SK ESB7, "PC Spark Plug HS-B6" - so the line
    // carries AutoCount's wording, not the button's, and is not a free-text
    // line. John's call, 24 Sep 2026, and the right one: a technician who
    // SCANS the same plug gets AutoCount's wording, and one part reading two
    // ways on one document is the sort of thing a customer queries.
    // addJobToMachine() works that out from the code rather than from a flag
    // here - see isFreeTextPart().
    //
    // The price is ours, as it is for the tubes. $4.00 is what the workshop
    // charges; whatever AutoCount has against the item is not.
    { id: "PLUG", title: "HS-B6 Spark Plug",
      code: "M0815SK ESB7",       qty: 1, price: 4.00, foggers: true },
    // A8 SPARE PARTS - plural, as the catalogue holds it. John wrote "A8 SPARE
    // PART"; the code that resolves is the plural one, which is also what the
    // Yellow Fuel Pipe above uses. A placeholder code, so this line DOES carry
    // the button's wording: AutoCount calls it "Spare Parts Of Equipment",
    // which tells a customer nothing.
    { id: "CORE", title: "Core Wire",
      code: "A8 SPARE PARTS",     qty: 1, price: 3.00, foggers: true },
  ];

  // The everyday buttons, and the ones only a fogger gets. Split here rather
  // than in the screen, so "which machines is this on" is answered in the same
  // file that says what it costs.
  function everyday() {
    var out = [];
    for (var i = 0; i < JOBS.length; i++) if (!JOBS[i].foggers) out.push(JOBS[i]);
    return out;
  }
  function foggerOnly() {
    var out = [];
    for (var i = 0; i < JOBS.length; i++) if (JOBS[i].foggers) out.push(JOBS[i]);
    return out;
  }

  function byId(id) {
    for (var i = 0; i < JOBS.length; i++) {
      if (JOBS[i].id === id) return JOBS[i];
    }
    return null;
  }

  // Is this line one of these jobs, priced at nothing because that is what the
  // job costs - rather than a part whose price nobody has filled in yet?
  //
  // Asked of the LINE, so it holds after saving and reloading: the answer is in
  // the item code and the variant, both of which are stored.
  function zeroIsDeliberate(part) {
    if (!part || Number(part.unit_price) > 0) return false;
    var job = byId(String(part.variant || ""));
    // A comment job never becomes a part, so it can never be the answer here -
    // and asking it about a price it has not got would say "yes" to any line
    // with a blank code.
    return !!job && !job.comment && job.price === 0 && job.code === part.item_code;
  }

  // A price typed wrong here reaches a customer's invoice with nothing in
  // between to question it, so the table is checked for the mistakes that are
  // easy to make while editing: a job with no code, or two jobs sharing an id
  // (which would merge the very lines the id exists to keep apart).
  function check() {
    var bad = [], seen = {};
    for (var i = 0; i < JOBS.length; i++) {
      var j = JOBS[i];
      var who = j.title || j.id || "job " + (i + 1);
      // Every job, of either kind, needs these two.
      if (!j.id || !j.title) bad.push(who + " is missing an id or a title");
      if (seen[j.id]) bad.push("two jobs share the id " + j.id);
      seen[j.id] = true;
      // THE TWO KINDS ARE CHECKED DIFFERENTLY. A job that writes a comment has
      // no code, no price and no quantity, and demanding them of it would put
      // the "list looks wrong" banner up and take every button down with it.
      // Which it did, the first time this file grew one.
      if (j.comment) {
        if (j.code || j.price !== undefined || j.qty !== undefined) {
          bad.push(who + " both writes a comment and adds a line - it has to be one or the other");
        }
      } else {
        if (!j.code) bad.push(who + " has no item code");
        if (!(j.price >= 0)) bad.push(who + " has no price");
        if (!(j.qty > 0)) bad.push(who + " has no quantity");
      }
    }
    return bad;
  }

  var API = { list: JOBS, everyday: everyday, foggerOnly: foggerOnly,
              byId: byId, zeroIsDeliberate: zeroIsDeliberate, check: check };
  if (typeof window !== "undefined") window.OM_JOBS = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
