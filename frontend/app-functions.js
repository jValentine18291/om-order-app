// app-functions.js
// ============================================================================
// The buttons on the home screen, what each one is called, and which of them
// each job gets by default.
//
// EDIT THIS FILE when a function is added, renamed or moved between jobs.
// Nothing else needs changing: the home screen draws from it, the Functions
// sheet on Admin -> People & devices lists from it, and the server validates
// against it.
//
// Shared with the backend the same way service-items.js and machine-types.js
// are - one file, required by node and loaded by the browser - because the
// alternative is the server and the app disagreeing about what "quote" means,
// silently, in one of them.
//
// A PERSON'S OWN LIST OVERRIDES THEIR JOB'S. John asked for that in Sep 2026:
// a technician who also does the purchasing gets that one extra button without
// being made a Purchaser. Somebody with no list of their own follows their
// job, which is how everybody starts and how most people stay - so the
// defaults below are still the thing that matters most.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OM_FUNCTIONS = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // In the order they appear on the home screen, which is the order the
  // Functions sheet lists them in - so ticking down the list matches what the
  // person will see.
  const FUNCTIONS = [
    { id: "new",      label: "New Service",     hint: "Register a customer's machines" },
    { id: "open",     label: "Open Service",    hint: "Scan parts onto a service slip" },
    { id: "close",    label: "Close Service",   hint: "Record the invoice, then collection" },
    { id: "view",     label: "View Slips",      hint: "Look up any slip" },
    { id: "find",     label: "Find Part",       hint: "Search the catalogue and stock" },
    { id: "ipl",      label: "IPL",             hint: "Parts diagrams" },
    { id: "quote",    label: "Need to Quote",   hint: "What is waiting to be priced" },
    { id: "bulk",     label: "Bulk Order",      hint: "Order several parts at once" },
    { id: "requests", label: "Orders",          hint: "Part requests from the workshop" },
    { id: "po",       label: "Purchase Orders", hint: "What is on order and when it lands" },
    { id: "ship",     label: "Shipments",       hint: "Incoming shipments" },
  ];

  const IDS = FUNCTIONS.map((f) => f.id);

  // What each job gets when nobody has said otherwise. John's mapping,
  // 28 Jul 2026, unchanged: "po" is on every list because what is on order and
  // when it lands is a question anyone in the building gets asked, and only
  // the purchaser can change it.
  const ROLE_DEFAULTS = {
    sales:     ["new", "close", "view", "find", "ipl", "quote", "bulk", "po", "ship"],
    tech:      ["open", "view", "find", "ipl", "po", "ship"],
    // Sales plus the orders list, so it inherits the IPLs rather than being a
    // separate shorter list that has to be kept in step.
    purchaser: ["new", "close", "view", "find", "ipl", "quote", "bulk", "requests", "po", "ship"],
    admin:     ["new", "open", "close", "view", "find", "ipl", "quote", "bulk", "requests", "po", "ship"],
  };

  // WHO MAY CORRECT A MACHINE'S STATUS BY HAND.
  //
  // John alone, by his own request on 24 Sep 2026. Not "admins": there are six
  // of those, and this is the one screen in the app that can overwrite what a
  // technician recorded and delete what they wrote. He wanted it to be him.
  //
  // A LIST rather than a comparison, so adding a second person is one word
  // here and nothing else anywhere. The cost of it being one person is that
  // nobody can fix a status while he is away - which is his call, and worth
  // remembering the day somebody is waiting on one.
  const CORRECTORS = ["john"];
  function canCorrect(user) {
    return !!user && CORRECTORS.includes(String(user.id || ""));
  }

  // "People & devices" is deliberately NOT here. It is not a job function that
  // can be handed out - it is the screen that hands the others out, and it
  // belongs to admins by virtue of being an admin. Putting it on this list
  // would let it be ticked for somebody who could then hand themselves
  // anything, which is not a permission, it is the end of them.

  // What this person actually gets. An unknown job gets nothing rather than
  // defaulting to Sales: quietly handing out somebody else's functions is
  // worse than an empty screen.
  function functionsFor(user) {
    if (!user) return [];
    const own = user.functions;
    // Only a real list counts. null, undefined, "" and [] all mean "follow the
    // job" - and [] meaning that is deliberate: a person ticked down to
    // nothing would otherwise be indistinguishable from a person nobody has
    // touched, and the second is far more common.
    if (Array.isArray(own) && own.length) return own.filter((id) => IDS.includes(id));
    return ROLE_DEFAULTS[user.role] || [];
  }

  // Is this list the job's own, or has somebody changed it? What the Users
  // screen uses to say "as Technician" instead of listing eleven ticks.
  function isDefault(user) {
    const own = user && user.functions;
    if (!Array.isArray(own) || !own.length) return true;
    const base = ROLE_DEFAULTS[user.role] || [];
    if (own.length !== base.length) return false;
    return base.every((id) => own.includes(id));
  }

  // Keep only ids that exist, in the order the home screen uses them, so a
  // stored list can never carry something that is not a button any more.
  function clean(list) {
    if (!Array.isArray(list)) return [];
    return IDS.filter((id) => list.includes(id));
  }

  return { FUNCTIONS, IDS, ROLE_DEFAULTS, functionsFor, isDefault, clean,
           CORRECTORS, canCorrect };
});
