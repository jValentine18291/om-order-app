// fogger-tubes.js
// ============================================================================
// PulsFOG tube types, and what one cut piece of each costs.
//
// THIS IS THE FILE TO EDIT WHEN A TUBE PRICE CHANGES. Nothing else needs
// touching - the buttons, the quantity prompt and the arithmetic all read from
// here. Bump the cache version in sw.js afterwards or phones keep the old
// prices.
//
// Source: "PulsFOG Tube Type & Pricing", the sheet the workshop already works
// from (scanned 3 Sep 2026). Entered 4 Sep 2026.
//
// WHY THIS EXISTS AT ALL
// These tubes are cut to length from a roll, so a repair never consumes a
// whole stock unit. The workshop was doing the fraction by hand on a paper
// table, which is exactly the sort of sum that goes wrong at the bench on a
// busy afternoon.
//
//   unitQty   the fraction of ONE roll that a single cut piece uses
//   unitPrice the price of a whole roll, as the sheet prints it
//   each      what one piece costs, as the sheet prints it
//
// "each" is not used for the money - the line is stored as (unitQty x pieces)
// at unitPrice, so AutoCount deducts the right fraction of a roll. It is kept
// because it is what the sheet shows and what the technician expects to see,
// and because checkTubeTable() below uses it to catch a mistyped price.
//
// NOTE FOR WHOEVER EDITS THIS NEXT: several tube types share one item code and
// each has its OWN price - Z00126.03 alone runs $25.00, $26.60, $23.50 and
// $20.00 depending on the tube. That is not a typo in this table; it is what
// the sheet says. It is also why the app has to keep the tube type against the
// line, or two tubes off the same roll would collapse into one wrong figure.
(function () {
  "use strict";

  // In the order the workshop reads them off the sheet, which is the order the
  // buttons appear in.
  var TUBES = [
    { code: "SPUL KACC Z00126.03", type: "222",  unitQty: 0.04,  unitPrice: 25.00,  each: 1.00 },
    { code: "SPUL KACC Z00126.03", type: "311",  unitQty: 0.075, unitPrice: 26.60,  each: 2.00 },
    { code: "SPUL KACC Z00126.03", type: "178",  unitQty: 0.085, unitPrice: 23.50,  each: 2.00 },
    { code: "SPUL KACC Z00126.03", type: "142",  unitQty: 0.265, unitPrice: 20.00,  each: 5.30 },

    { code: "SPUL KACC Z00416",    type: "S310", unitQty: 0.04,  unitPrice: 45.00,  each: 1.80 },

    { code: "SPUL KACC Z00156",    type: "122y", unitQty: 0.15,  unitPrice: 100.00, each: 15.00 },
    { code: "SPUL KACC Z00156",    type: "140",  unitQty: 0.31,  unitPrice: 77.10,  each: 23.90 },
    { code: "SPUL KACC Z00156",    type: "141",  unitQty: 0.21,  unitPrice: 77.14,  each: 16.20 },
    { code: "SPUL KACC Z00156",    type: "170",  unitQty: 0.085, unitPrice: 100.00, each: 8.50 },

    { code: "SPUL KACC Z00035",    type: "96y",  unitQty: 0.085, unitPrice: 330.59, each: 28.10 }
  ];

  // A mistyped price here becomes a wrong figure on a customer's invoice, and
  // nothing downstream would question it. The sheet gives the same number two
  // ways, so they can be checked against each other: unitQty x unitPrice should
  // land on "each", give or take the rounding the sheet itself does (it prints
  // 0.075 x $26.60 = $2.00, not $1.995). More than two cents apart means a
  // digit went astray while editing.
  function checkTubeTable() {
    var bad = [];
    for (var i = 0; i < TUBES.length; i++) {
      var t = TUBES[i];
      if (Math.abs(t.unitQty * t.unitPrice - t.each) > 0.02) {
        bad.push(t.type + ": " + t.unitQty + " x " + t.unitPrice.toFixed(2) +
                 " = " + (t.unitQty * t.unitPrice).toFixed(3) +
                 ", but the sheet says " + t.each.toFixed(2));
      }
    }
    return bad;
  }

  // Does this machine look like a thermal fogger? The model is free text typed
  // at registration, so there is nothing structured to go on - only what the
  // person at the counter wrote.
  //
  // Deliberately GENEROUS. Getting it wrong in one direction shows ten buttons
  // on a chainsaw job, which a technician ignores; getting it wrong the other
  // way hides the feature with no way to reach it, on the one machine that
  // needs it. So punctuation and spacing are stripped and "fog" anywhere is
  // enough: Fogger, PulsFOG, PulseFog, "thermal fogging machine", K-10-SP,
  // K10SP and "K 10 SP" all match.
  function looksLikeFogger(desc) {
    var s = String(desc || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return s.indexOf("FOG") !== -1 || s.indexOf("K10") !== -1;
  }

  function tubeByType(type) {
    for (var i = 0; i < TUBES.length; i++) {
      if (TUBES[i].type === type) return TUBES[i];
    }
    return null;
  }

  window.FOGGER_TUBES = {
    list: TUBES,
    byType: tubeByType,
    looksLikeFogger: looksLikeFogger,
    check: checkTubeTable
  };
})();
