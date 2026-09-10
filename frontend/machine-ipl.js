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

  // The parts prefix for a brand NAME, for machines that were typed in by hand
  // and have no code of their own. Once the book is known the brand is known,
  // so a hand-typed "BK3410FL51 Brushcutter" still floats SZEN parts under its
  // own carburettor.
  function brandPrefixForBrandName(name) {
    const hit = Object.keys(BRAND_BY_PREFIX).find((k) => BRAND_BY_PREFIX[k] === name);
    return hit ? "S" + hit.slice(1) : "";
  }

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

  // A model name long enough to stand on its own without the brand to back it
  // up. "BK3410FL" is nobody else's; "365" is a number that turns up in all
  // sorts of text, which is the one the brand check exists to protect.
  const STANDS_ALONE = 5;

  // The book for this machine, or "".
  //
  // Where the machine came out of AutoCount its code names the brand, and the
  // brand has to agree - a Zenoah with 36.5cc on its label must not be handed
  // a Husqvarna 365 chainsaw's parts list.
  //
  // Where it was typed in by hand there is no code and often no brand word
  // either: slip 00024 came in as "BK3410FL51 Brushcutter", which says nothing
  // about Zenoah. So the model name is allowed to stand on its own, as long as
  // it is long enough to be nobody else's. That is what the length rule is
  // for, and it is why "365" alone is still not enough.
  //
  // The longest match wins: "525HF3S" and "525HE4" contain neither the other,
  // but a shorter key that IS inside a longer one would otherwise win by luck
  // of ordering.
  function matchIplModel(machine, index) {
    const m = machine || {};
    const brand = BRAND_BY_PREFIX[codePrefix(m.machine_code)] || "";
    const hay = norm(`${m.machine_code || ""} ${m.machine_desc || ""}`);
    if (!hay) return "";

    const words = wordsOf(m);
    let best = "", bestLen = 0;
    for (const entry of index || []) {
      const brandNamed = brand ? entry.brand === brand : hay.includes(norm(entry.brand));
      // A code that names a brand is authoritative: another brand's book is
      // not this machine's, however the model reads.
      if (brand && !brandNamed) continue;
      for (const key of modelKeys(entry)) {
        // Three ways a machine can name a book, and the length of what
        // actually matched is what a longer, more specific match is judged on.
        //
        //   the whole word      "365" in "Husqvarna 365 Chainsaw"
        //   inside the text     "BK3410FL" within the code "UZEN BK3410FL51"
        //   the start of it     "BK3410" written on the slip, against the book
        //                       "BK3410FL". Staff write the model short - the
        //                       hose variant does not matter to a repair - and
        //                       the book is named after the fuller model, so
        //                       without this the short form finds no book.
        let hitLen = 0;
        if (words.has(key)) hitLen = key.length;
        else if (key.length >= 4 && hay.includes(key)) hitLen = key.length;
        else {
          for (const w of words) {
            // Only a word long enough to be nobody else's may claim a book by
            // its opening: "525" starts four different books, "BK3410" one.
            //
            // And only one carrying a digit. Without that the brand word wins
            // it: one of the keys is the book's full name, "ZENOAH BK3410FL /
            // FL-S", and every Zenoah machine starts with "ZENOAH" - so any
            // Zenoah at all would have claimed the first Zenoah book in the
            // list. Every model number has a digit in it; no brand does.
            if (w.length >= STANDS_ALONE && /[0-9]/.test(w) &&
                key.startsWith(w) && w.length > hitLen) hitLen = w.length;
          }
        }
        if (!hitLen) continue;
        // With no brand to go on, only a name that stands alone counts.
        if (!brandNamed && hitLen < STANDS_ALONE) continue;
        if (hitLen > bestLen) { best = entry.id; bestLen = hitLen; }
      }
    }
    return best;
  }

  // The model numbers written on the machine, for matching against Desc2.
  //
  // AutoCount's Desc2 says which model a part is for - "BK3410", "K10SP",
  // "365, 372XP" - across 82% of the catalogue, which is far more than the 28
  // models with a parts book. It is kept by the people who know, as part of
  // ordinary work, so it is the best answer available to "does this part fit
  // this machine".
  //
  // What comes back is every word of the machine that could BE a model. A word
  // qualifies by carrying a digit, which is what separates "BK3410" and
  // "525BX" from "BRUSHCUTTER", "ZENOAH" and "THICK". Measured against 185
  // parts of the real catalogue: 129 distinct models named in Desc2, and not
  // one of them collides with an ordinary word from a machine description.
  //
  // So a technician's slip can read "BK3410", or "BK3410 Backpack Brushcutter",
  // or "BK3410 (thick hose)" - the model only has to stand as its own word.
  // What does NOT work is gluing a suffix on: "BK3410FL51" is a different word
  // from "BK3410" and matches nothing.
  function modelWordsFor(machine, cap = 8) {
    const out = [];
    for (const w of wordsOf(machine)) {
      if (w.length < 3 || w.length > 24) continue;
      if (!/[0-9]/.test(w)) continue;
      if (!out.includes(w)) out.push(w);
      if (out.length >= cap) break;
    }
    return out;
  }

  // Everything the search needs to know about the machine in front of you:
  // which book, and which brand's parts to float when the book has nothing.
  //
  // The brand comes off the machine's own code where there is one, and off the
  // matched book where there is not - so a hand-typed machine gets both.
  function fitFor(machine, index) {
    const iplId = matchIplModel(machine, index);
    const entry = (index || []).find((e) => e.id === iplId);
    const brand = brandPrefixFor(machine) ||
                  (entry ? brandPrefixForBrandName(entry.brand) : "");

    // The matched book's own name is a model too, and it gets past the rule
    // that a model word must carry a digit.
    //
    // That rule keeps BRUSHCUTTER and ZENOAH from matching anything, and it is
    // right for words read off a slip. But some models have no digit at all:
    // the LHTZ-A trimmer head is "LHTZ-A" in AutoCount's Desc2 and splits into
    // "LHTZ" and "A", neither of which qualifies - so its own parts would not
    // float even though AutoCount says which they are.
    //
    // Taking it from the book is safe where guessing is not: the book has
    // already been matched to this machine, so its name is not a guess about
    // what the machine is.
    //
    // Only when the book names ONE model. "BK3410FL / FL-S" mashed together is
    // a model nobody has ever written down, and its real name reaches Desc2
    // through the digit rule anyway.
    const models = modelWordsFor(machine);
    const one = entry && !String(entry.short || "").includes("/") ? norm(entry.short) : "";
    if (one.length >= 3 && !models.includes(one)) models.unshift(one);
    return { iplId, brand, models };
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

  return { fitFor, brandPrefixFor, brandPrefixForBrandName, matchIplModel,
           preferredNumbers, modelWordsFor, modelKeys, codePrefix,
           BRAND_BY_PREFIX, STANDS_ALONE };
});
