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
    // One pipe per tap. These lines never merge - see addPartToMachine - so a
    // machine that took two gets two lines, or one line the technician steps
    // up to 2 with the stepper. Either reads the same on the Sales Order.
    { id: "PIPE", title: "Yellow Fuel Pipe",
      code: "A8 SPARE PARTS",      qty: 1, price: 3.00 },
  ];

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
    return !!job && job.price === 0 && job.code === part.item_code;
  }

  // A price typed wrong here reaches a customer's invoice with nothing in
  // between to question it, so the table is checked for the mistakes that are
  // easy to make while editing: a job with no code, or two jobs sharing an id
  // (which would merge the very lines the id exists to keep apart).
  function check() {
    var bad = [], seen = {};
    for (var i = 0; i < JOBS.length; i++) {
      var j = JOBS[i];
      if (!j.id || !j.title || !j.code) {
        bad.push((j.title || j.id || "job " + (i + 1)) + " is missing an id, a title or a code");
      }
      if (seen[j.id]) bad.push("two jobs share the id " + j.id);
      seen[j.id] = true;
      if (!(j.price >= 0)) bad.push(j.title + " has no price");
      if (!(j.qty > 0)) bad.push(j.title + " has no quantity");
    }
    return bad;
  }

  var API = { list: JOBS, byId: byId, zeroIsDeliberate: zeroIsDeliberate, check: check };
  if (typeof window !== "undefined") window.OM_JOBS = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
