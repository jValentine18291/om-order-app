// How a value is made to fit one cell of a PDF meta card.
//
// WHY THIS EXISTS
// The service slip and the repair-details sheet both head themselves with a
// four-cell card: DATE RECEIVED, COMPANY, CONTACT, CONTACT NO. Both are sent
// to the customer, so both carry the customer's own company name, and that is
// the one value with no fixed length. "SembCorp Marine Facilities Pte Ltd"
// does not fit a quarter of an A4 page at 11pt.
//
// Both sheets used to draw only the first line that jsPDF's splitTextToSize
// returned and silently drop the rest, so that customer's slip said "SembCorp
// Marine" and nothing else. A short form of a company name on a document we
// send them is not a cosmetic problem; it is the wrong company.
//
// So: keep 11pt when it fits, otherwise step down to 7.6pt, and only when even
// that is too small fall back to two wrapped lines. Nothing is ever dropped
// without going through every one of those first.
//
// The two sheets differ in one number - the slip has an icon in the cell, so
// it has 4pt less room - which is exactly the kind of difference that lets two
// copies of the same code drift apart. Hence one module, called by both.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OM_PDF_FIT = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX = 11;    // the size the card is designed around
  const MIN = 7.6;   // still comfortably readable on paper
  const STEP = 0.3;

  // measure(text, size) -> width in the same units as room.
  // Returns { size, lines, wrapped, truncated } - lines is one string, or two
  // when even MIN was too small. Every returned line is guaranteed to measure
  // <= room at size.
  function fitCellText(text, room, measure, opts) {
    const o = opts || {};
    const max = o.max == null ? MAX : o.max;
    const min = o.min == null ? MIN : o.min;
    const step = o.step == null ? STEP : o.step;
    const s = String(text == null ? "" : text);

    let size = max;
    while (size > min && measure(s, size) > room) {
      size = Math.round((size - step) * 100) / 100;
      if (size < min) size = min;
    }
    if (measure(s, size) <= room) {
      return { size: size, lines: [s], wrapped: false, truncated: false };
    }
    const w = wrap(s, room, size, measure);
    return { size: size, lines: w.lines, wrapped: true, truncated: w.truncated };
  }

  // Greedy word wrap, capped at two lines, because the card is 56pt high and a
  // third line has nowhere to go.
  //
  // A single word longer than the cell stays on its own line rather than being
  // cut mid-word: better a name that overhangs by a hair than one that reads
  // as a different word.
  //
  // If two lines at the smallest size still will not hold it, the name is
  // marked with an ellipsis. That is the whole point of this file - a name we
  // could not print in full must not look like a name that ends there. Nothing
  // we have seen from the customer list gets this far.
  function wrap(s, room, size, measure) {
    const words = s.split(/\s+/).filter(Boolean);
    if (!words.length) return { lines: [s], truncated: false };
    const lines = [];
    let line = "";
    let i = 0;
    for (; i < words.length; i++) {
      const next = line ? line + " " + words[i] : words[i];
      if (line && measure(next, size) > room) {
        lines.push(line);
        line = words[i];
        if (lines.length === 2) break;
      } else {
        line = next;
      }
    }
    const truncated = lines.length === 2;
    if (!truncated && line) lines.push(line);
    if (truncated) lines[1] = ellipsize(lines[1], room, size, measure);
    return { lines: lines, truncated: truncated };
  }

  // Add "..." to the end of a line, dropping words off it until the mark fits.
  function ellipsize(line, room, size, measure) {
    let words = line.split(" ");
    while (words.length > 1 && measure(words.join(" ") + "…", size) > room) words.pop();
    return words.join(" ") + "…";
  }

  // The weights the meta card divides its width by, shared so the two sheets
  // lay their cells out identically. COMPANY gets the most because it is the
  // only one whose length is not known in advance.
  const META_WEIGHTS = { date: 1, company: 2.1, contact: 1.25, phone: 1 };

  return { fitCellText: fitCellText, META_WEIGHTS: META_WEIGHTS, MAX: MAX, MIN: MIN, STEP: STEP };
});
