// machine-names.js
// ============================================================================
// What a machine is called on a service slip.
//
// AutoCount's descriptions are written for a catalogue:
//
//   ZENOAH BK3410FL-S Backpack Brushcutter 33.6cc /w Tools & Acc. (Thick Flexible Hose)
//
// which is not what anyone wants to read down a list of eight machines on a
// slip, or hand to a customer. This turns that into "BK3410 (Thick)".
//
// THIS IS THE FILE TO EDIT WHEN A MACHINE SHOULD READ DIFFERENTLY. Add a line
// to OVERRIDES and bump the cache version in sw.js. Nothing else needs
// touching: the name chosen here is what goes in the Model No. box, and from
// there onto the slip, the printed copy and the Sales Order, so all of them
// agree by construction.
//
// WHY THERE IS A LIST AT ALL, AND NOT JUST A RULE
// The obvious rule - drop whatever follows the digits - turns BK3410FL-S into
// BK3410, and also turns 525HF3S into 525 and 572XP into 572, where those
// suffixes ARE the model. A rule that is right most of the time puts a wrong
// machine name on a customer's slip the rest of the time, so the shortening
// that cannot be derived is written down instead.
//
// The DEFAULT is safe and needs no list: the AutoCount item code without its
// brand prefix. UZEN BK3410FL-S becomes BK3410FL-S - already short, always
// correct, and it is what a new machine gets until somebody decides otherwise.
(function () {
  "use strict";

  // Item code -> what to call it. Keyed on the full AutoCount code, or on the
  // model alone (the code without its brand prefix) - whichever is easier to
  // write. Both are matched, exact code first.
  //
  // Spacing and case do not matter here; they are normalised before matching.
  var OVERRIDES = {
    // "BK3410FL-S": "BK3410 (Thick)",
  };

  // Brand prefixes on machine item codes. Machines are the U-prefixed items:
  // UZEN Zenoah, UHUQ Husqvarna, UPUL PulsFOG, and so on. Stripping the prefix
  // is what turns a stock code into a model.
  //
  // Only a token that actually looks like one of these is removed. Anything
  // unexpected is left completely alone rather than guessed at - a code shape
  // nobody anticipated should read oddly, not wrongly.
  var BRAND_PREFIX = /^U[A-Z]{2,4}$/;

  function norm(s) {
    return String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
  }

  // The model: the item code with its brand prefix taken off.
  function modelFromCode(itemCode) {
    var parts = norm(itemCode).split(" ");
    if (parts.length > 1 && BRAND_PREFIX.test(parts[0])) return parts.slice(1).join(" ");
    return parts.join(" ");
  }

  // What to show, and what to record. description is only a fallback: a machine
  // typed in by hand has no code, and its own wording is the best there is.
  function shortNameFor(itemCode, description) {
    var code = norm(itemCode);
    if (!code) return String(description || "").trim();

    var byCode = OVERRIDES[code];
    if (byCode) return byCode;

    var model = modelFromCode(code);
    var byModel = OVERRIDES[model];
    if (byModel) return byModel;

    return model || String(description || "").trim();
  }

  // Anything in OVERRIDES that is only ever going to sit there unused - a
  // mistyped code, or one for a machine that has since gone - is worth knowing
  // about, since the symptom is silence: the machine simply keeps its default
  // name and nobody can see why. Checked against a list of real codes.
  function unusedOverrides(knownCodes) {
    var seen = {};
    (knownCodes || []).forEach(function (c) {
      seen[norm(c)] = true;
      seen[modelFromCode(c)] = true;
    });
    return Object.keys(OVERRIDES).filter(function (k) { return !seen[norm(k)]; });
  }

  window.MACHINE_NAMES = {
    shortNameFor: shortNameFor,
    modelFromCode: modelFromCode,
    unusedOverrides: unusedOverrides,
    OVERRIDES: OVERRIDES,
  };
})();
