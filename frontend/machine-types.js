// What kind of machine a model number is.
//
// Sales register a slip by typing the model and nothing else - "EBZ5100" -
// because that is the fast thing to type with a customer standing there. The
// documents that leave the building have to say what it IS, so the Sales
// Order, the Quotation and the customer's own slip all read "EBZ5100 Backpack
// Blower".
//
// The slip itself keeps what was typed. This only changes how a machine is
// NAMED on paper, never what is stored.
//
// EDIT THIS FILE to add a model. Nothing else needs changing, and
// tools/test-machine-types.js checks the list stays sane - no model in two
// types, nothing that would collide with another.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OM_MACHINE_TYPES = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // John's list, 14 Sep 2026. Grouped the way he gave it.
  const BY_TYPE = {
    "Backpack Brushcutter": ["BK3410", "BK3420", "BK4310", "131RB", "525RX", "531RB", "532RBS", "541RB"],
    "Handheld Blower": ["HBZ260", "HBZ260EZ", "HB2302", "525BX", "125B"],
    "Battery Handheld Blower": ["120iB", "525iB", "530iB"],
    "Backpack Blower": ["345BT", "350BT", "360BT", "530BT", "EBZ5100", "EBZ3000", "EBZ8500", "EBZ8550", "EB6200"],
    "Battery Backpack Blower": ["340iBT", "536LiB", "550iBTX"],
    "Battery Chainsaw": ["120i", "540iXP", "T536LiXP", "536LiXP", "T540iXP"],
    "Long Pole Trimmer": ["PHT1500", "LHT240TB26", "525HE4"],
    "Battery Long Pole Trimmer": ["520iHT4", "520iHE3"],
    "Short Pole Trimmer": ["PHT750", "525HF3S"],
  };

  // model -> type, flattened and upper-cased once.
  const TYPE_OF = {};
  for (const type of Object.keys(BY_TYPE)) {
    for (const model of BY_TYPE[type]) TYPE_OF[model.toUpperCase()] = type;
  }

  // The head noun of each type - BLOWER, BRUSHCUTTER, CHAINSAW, TRIMMER.
  // Used to tell "EBZ5100" from "EBZ5100 Backpack Leaf Blower": if the text
  // already says what the machine is, in any words, it is left alone rather
  // than having a second description stapled to it.
  const TYPE_WORDS = (() => {
    const skip = new Set(["BACKPACK", "HANDHELD", "BATTERY", "LONG", "SHORT", "POLE"]);
    const out = new Set();
    for (const type of Object.keys(BY_TYPE)) {
      for (const w of type.toUpperCase().split(/\s+/)) if (!skip.has(w)) out.add(w);
    }
    return out;
  })();

  // Whole words only. A model is never matched as part of a longer one: five
  // different machines begin "525" - 525RX is a brushcutter, 525BX a blower,
  // 525iB a battery blower, 525HE4 a long pole trimmer, 525HF3S a short one -
  // and a prefix match would label four of them wrongly.
  function tokensOf(text) {
    return String(text || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  }

  // The type for a machine as it was written, or "" when nothing is known.
  function typeFor(text) {
    for (const t of tokensOf(text)) {
      if (TYPE_OF[t]) return TYPE_OF[t];
    }
    return "";
  }

  // Does this already say what the machine is?
  function namesAType(text) {
    return tokensOf(text).some((t) => TYPE_WORDS.has(t));
  }

  // "EBZ5100" -> "EBZ5100 Backpack Blower".
  //
  // Left exactly as written when: the model is not on the list, or the text
  // already names a type. Somebody who took the trouble to write "EBZ5100
  // Backpack Leaf Blower 50.2cc" has said it better than this table can, and
  // a machine nobody listed is printed as typed rather than guessed at.
  function expand(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return s;
    if (namesAType(s)) return s;
    const type = typeFor(s);
    return type ? `${s} ${type}` : s;
  }

  return {
    BY_TYPE: BY_TYPE,
    TYPE_OF: TYPE_OF,
    TYPE_WORDS: TYPE_WORDS,
    typeFor: typeFor,
    namesAType: namesAType,
    expand: expand,
  };
});
