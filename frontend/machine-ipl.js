// machine-ipl.js — which parts belong to the machine in front of you.
// ============================================================================
// A technician repairing a Zenoah brushcutter and typing "clutch" was getting
// Husqvarna clutches mixed in with Zenoah ones, in whatever order the
// description happened to sort. This works out what "this machine's parts"
// means so the search can float them to the top.
//
// Two answers, in order of confidence:
//
//   the model   For the machines with a parts book loaded, the actual part
//               numbers in that book. Exact.
//   the brand   For everything else, the brand's own code prefix. A Husqvarna
//               machine is UHUQ ... and its parts are SHUQ ...; the same U/S
//               pair holds for every brand. Coarse, but right, and it works on
//               a machine nobody has a book for.
//
// Nothing is ever hidden on the strength of this - it only decides what sorts
// first. That is deliberate: oil, A8 SPARE PARTS, and a part that cross-fits
// from another model are all things a technician has to be able to find, and a
// wrong guess here would make them unfindable rather than merely lower down.
//
// Written to run in the browser and in node, so the matching can be tested
// against the real catalogue without a browser.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MachineIpl = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Codes as AutoCount holds them: a prefix, a space, then the maker's own
  // number. "UHUQ 525BX 967284201" is a machine; "SHUQ 522664401" is a part.
  // The machine search is the mirror of this - it takes exactly what starts
  // with U - so the two together cover the catalogue with no overlap and no gap.
  function codePrefix(code) {
    const first = String(code || "").trim().split(/\s+/)[0] || "";
    return first.toUpperCase();
  }

  // The parts prefix for a machine: same three letters, S instead of U.
  // Verified against the catalogue: UHUQ 525BX -> SHUQ parts, UZEN BK3410F51
  // -> SZEN parts.
  function brandPrefixFor(machine) {
    const p = codePrefix((machine || {}).machine_code);
    if (!/^U[A-Z]{2,5}$/.test(p)) return "";
    return "S" + p.slice(1);
  }

  // Which brand of book to look in, so a Husqvarna machine cannot match a
  // Zenoah model that happens to share a number.
  const BRAND_BY_PREFIX = {
    UHUQ: "Husqvarna", UZEN: "Zenoah", UPUL: "PulsFOG",
    UBLG: "Billy Goat", UFER: "Ferris", UGRA: "Grasshopper",
    UPER: "Peruzzo", UVIC: "Victa", URAY: "Rayco", UHCN: "Husqvarna Construction",
  };

  function norm(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // The model names one book covers. "BK3410FL / FL-S" is two, and the second
  // is a suffix rather than a name of its own.
  //
  // A key is matched two ways, and needs to pass only one:
  //
  //   as a whole word   "365" in "Husqvarna 365 Chainsaw". Short names are
  //                     real - the 365 is a chainsaw people ask for by that
  //                     number - and they are safe this way round, because a
  //                     word is a word: "3650MM" is not "365".
  //   as a run of text  "BK3410FL" inside the code "UZEN BK3410FL51". Machine
  //                     codes carry the model with a suffix stuck on the end,
  //                     so this one cannot be a whole word. Length 4 minimum,
  //                     or "FLS" would match half the catalogue.
  //
  // Anything under 3 characters is dropped either way.
  function modelKeys(entry) {
    const out = [];
    for (const raw of String((entry || {}).short || "").split("/")) {
      const k = norm(raw);
      if (k.length >= 3) out.push(k);
    }
    const full = norm((entry || {}).name);
    if (full.length >= 4 && !out.includes(full)) out.push(full);
    return out;
  }

  // The machine's own words, as whole words, for the short keys.
  function wordsOf(machine) {
    const m = machine || {};
    return new Set(
      String(`${m.machine_code || ""} ${m.machine_desc || ""}`)
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean)
    );
  }

  // The book for this machine, or "".
  //
  // Both halves have to agree: the brand, and the model name appearing in what
  // the machine is called. Requiring the brand is what makes this safe to run
  // on every machine - "365" turns up inside plenty of descriptions, and
  // without the brand check a Zenoah with 36.5cc on its label would be handed
  // a Husqvarna chainsaw's parts list.
  //
  // The longest match wins: "525HF3S" and "525HE4" both contain neither the
  // other, but a shorter key that IS contained in a longer one would otherwise
  // win by luck of ordering.
  function matchIplModel(machine, index) {
    const m = machine || {};
    const brand = BRAND_BY_PREFIX[codePrefix(m.machine_code)] || "";
    const hay = norm(`${m.machine_code || ""} ${m.machine_desc || ""}`);
    if (!hay) return "";

    const words = wordsOf(m);
    let best = "", bestLen = 0;
    for (const entry of index || []) {
      // A machine with no code at all was typed in by hand. Its description
      // still names the brand often enough to be worth trying, so the brand is
      // checked against the words rather than refused outright.
      const brandOk = brand
        ? entry.brand === brand
        : hay.includes(norm(entry.brand));
      if (!brandOk) continue;
      for (const key of modelKeys(entry)) {
        const hit = words.has(key) || (key.length >= 4 && hay.includes(key));
        if (hit && key.length > bestLen) { best = entry.id; bestLen = key.length; }
      }
    }
    return best;
  }

  // The part numbers in this book that the technician's search term matches.
  //
  // Filtered by the term rather than sent whole: a book runs to 338 parts and
  // the search only needs to know which of them are candidates for what was
  // actually typed. A handful of numbers travels; a parts list does not.
  function preferredNumbers(iplDoc, term, cap = 25) {
    const words = String(term || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length || !iplDoc) return [];
    const out = [];
    const seen = new Set();
    for (const fig of iplDoc.figures || []) {
      for (const p of fig.parts || []) {
        const num = String(p.part_number || "").trim();
        if (!num || seen.has(num)) continue;
        // The same test the catalogue search does: every word has to appear
        // somewhere, in the number or in what the part is called.
        const hay = `${num} ${p.description || ""} ${p.remarks || ""}`.toUpperCase();
        const haySquashed = hay.replace(/\s+/g, "");
        if (!words.every((w) => hay.includes(w) || haySquashed.includes(w.replace(/\s+/g, "")))) continue;
        seen.add(num);
        // Squashed to letters and digits, which is how the catalogue search
        // compares them: AutoCount holds "SHUQ 590 53 64-02" and the book has
        // "590 53 64-02", and neither spaces nor dashes are reliable in either.
        out.push(num.toUpperCase().replace(/[^A-Z0-9]/g, ""));
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  return { brandPrefixFor, matchIplModel, preferredNumbers, modelKeys, codePrefix, BRAND_BY_PREFIX };
});
