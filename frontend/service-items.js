// Which AutoCount service item opens a machine's block.
//
// Every machine on a Sales Order or a Repair Quotation starts with a service
// line, and WHICH one depends on what the machine is. They are accounted for
// separately, so a rider billed under A1 is filed as landscaping equipment and
// has to be corrected by hand afterwards - which is what this file exists to
// stop.
//
// The codes and the wording are AutoCount's own, read out of the catalogue
// rather than typed from memory, so a line raised here matches the item it is
// raised against.
//
// EDIT THIS FILE to add a model or a brand. Nothing else needs changing, and
// tools/test-service-items.js will tell you if a rule stops matching.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OM_SERVICE_ITEMS = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ITEMS = {
    A1: {
      item_code: "A1 SVR LANDSCAPE",
      description: "Being repair & replacement of part :-",
      label: "A1 · Landscape",
    },
    A2: {
      item_code: "A2 SVR PEST MGT EQUIPT",
      description: "Being repair & replacement of part for pest management equipment.",
      label: "A2 · Pest management",
    },
    A3: {
      item_code: "A3 SVR RIDE-ON EQUIPT",
      description: "Being Service of ride-on mower/tractor & parts changed:",
      label: "A3 · Ride-on",
    },
    A12: {
      item_code: "A12 SVR AUTOMOWER",
      // AutoCount's own wording, misspelling and all - "Sevicing". Left as the
      // catalogue has it so the line matches the item; correct it there and it
      // corrects itself here.
      description: "Being Installation and Sevicing for AutoMower",
      label: "A12 · Automower",
    },
  };

  // The Husqvarna riders and tractor mowers John listed. Matched whole, not as
  // fragments: TS242D is on the list and TS242 is not, and a machine nobody
  // named should fall through to A1 rather than be guessed into A3.
  //
  // R214C is here although AutoCount does not stock it today - it was on the
  // list, and a rule that matches nothing costs nothing.
  const HUSQVARNA_RIDE_ON = [
    "P525DX", "R213C", "R214C", "R420TsX", "TS242D", "Z242F", "TS342",
  ];

  // Everything a machine tells us about itself: the AutoCount code where there
  // is one, and whatever the workshop wrote on the slip. Both, because a slip
  // written by hand has no code and a code alone does not always carry the
  // model.
  function textOf(machine) {
    const m = machine || {};
    return [m.machine_code, m.machine_desc, m.desc, m.description]
      .filter(Boolean).join(" ");
  }

  const has = (text, re) => re.test(text);

  // An Automower. "Automower" in the description is the plain signal; the code
  // form is UHUQ AM535AWD / AM450X, so an AM followed by three digits counts
  // too - but only on a word boundary. Without it "TEAM 500" reads as AM500.
  function isAutomower(machine) {
    const t = textOf(machine);
    return has(t, /automower/i) || has(t, /\bAM\s?\d{3}/i);
  }

  // A ride-on. Every Ferris and every Grasshopper, plus the listed Husqvarnas.
  //
  // Matched on the brand NAME as well as the code prefix: AutoCount files
  // Ferris under UBNS (its parent, Briggs & Stratton) and that prefix also
  // holds engines and parts that are not ride-ons at all, so the name is the
  // safer signal and the prefix only backs it up.
  function isRideOn(machine) {
    const t = textOf(machine);
    if (has(t, /\bferris\b/i) || has(t, /\bgrasshopper\b/i)) return true;
    if (has(t, /\bUGRH\b/i)) return true;
    return HUSQVARNA_RIDE_ON.some((model) =>
      new RegExp("(^|[^A-Z0-9])" + model + "([^A-Z0-9]|$)", "i").test(t));
  }

  // Which item a machine takes, as a key. The order is the point: a fogger is
  // a fogger before anything else, and an Automower is not a ride-on even
  // though it mows.
  //
  // isFogger is passed in rather than imported, so this file stays free of
  // dependencies and the caller keeps using the one rule the app already has
  // for foggers - see fogger-tubes.js.
  function keyFor(machine, isFogger) {
    if (typeof isFogger === "function" && isFogger(machine)) return "A2";
    if (isAutomower(machine)) return "A12";
    if (isRideOn(machine)) return "A3";
    return "A1";
  }

  function itemFor(machine, isFogger) {
    return ITEMS[keyFor(machine, isFogger)];
  }

  // Is this one of ours? Used when a quotation overrides the choice, so an
  // override can only ever swap one service line for another.
  function isServiceCode(code) {
    const c = String(code || "").trim().toUpperCase();
    return Object.keys(ITEMS).some((k) => ITEMS[k].item_code.toUpperCase() === c);
  }

  return {
    ITEMS: ITEMS,
    KEYS: ["A1", "A2", "A3", "A12"],
    HUSQVARNA_RIDE_ON: HUSQVARNA_RIDE_ON,
    isAutomower: isAutomower,
    isRideOn: isRideOn,
    keyFor: keyFor,
    itemFor: itemFor,
    isServiceCode: isServiceCode,
  };
});
