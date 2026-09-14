// The customer's company name on the two PDFs we send them.
//
//   node tools/test-pdf-fit.js
//
// THE BUG THIS GUARDS
// The meta card at the head of the service slip and of the repair-details
// sheet divided the page into four cells and drew, for each, only the first
// line jsPDF's splitTextToSize returned - throwing the rest away without a
// mark. So "SembCorp Marine Facilities Pte Ltd" printed as "SembCorp Marine",
// "SHENAZ TRADING PTE LTD" as "SHENAZ", and "PESTOLOGY PTE LTD" as
// "PESTOLOGY PTE". On a document that goes to the customer, that is not a
// truncated string; it is the wrong company name.
//
// The fix shrinks the type before it ever wraps, and only wraps to two lines
// when even the smallest size will not do. What follows checks the property
// that matters: whatever comes back fits, and nothing is dropped short of that
// last resort.
//
// WHAT THIS DOES NOT CHECK
// jsPDF's Helvetica metrics. There is no jsPDF in Node here (it loads from a
// CDN in the browser), so the measurer below is a stand-in. The real widths
// were measured in the browser against jsPDF itself; at the weights in
// META_WEIGHTS, on an A4 page with 40pt margins, the COMPANY cell runs
// x=136.3 to x=338.6 and the longest real customer names land like this:
//
//   PESTOLOGY PTE LTD                       11pt    one line
//   SHENAZ TRADING PTE LTD                  11pt    one line
//   KIAT & KIAT CONTRACTOR                  11pt    one line
//   SembCorp Marine Facilities Pte Ltd    10.4pt    one line
//   Nanyang Technological University (Facilities)
//                                            8pt    one line
//   SINGAPORE UNIVERSITY OF TECHNOLOGY AND DESIGN ESTATES
//                                          7.4pt    two lines, both complete
//
// - every one of them clear of the next cell by 14pt or more.
const path = require("path");
const F = require(path.resolve(__dirname, "..", "frontend", "pdf-fit.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

// A stand-in for jsPDF's getTextWidth: every glyph the same width. Wrong about
// any particular string, right about the thing being tested - that the fit
// narrows until the measurer says it fits, and never reports otherwise.
const EM = 0.6;
const measure = (text, size) => text.length * size * EM;

console.log("-- a name that already fits is left at full size --");
let r = F.fitCellText("PESTOLOGY PTE LTD", 200, measure);
check("kept at 11pt", r.size, 11);
check("on one line, whole", r.lines, ["PESTOLOGY PTE LTD"]);
check("not wrapped", r.wrapped, false);

console.log("\n-- a name that does not fit is shrunk, not cut --");
// 17 chars at 11pt measures 112.2; give it 90 and it must come down.
r = F.fitCellText("PESTOLOGY PTE LTD", 90, measure);
check("smaller than 11pt", r.size < 11, true);
check("still one line, still whole", r.lines, ["PESTOLOGY PTE LTD"]);
check("and it actually fits", measure(r.lines[0], r.size) <= 90, true);

console.log("\n-- it stops shrinking at the floor, then wraps --");
const SUTD = "SINGAPORE UNIVERSITY OF TECHNOLOGY AND DESIGN ESTATES";
r = F.fitCellText(SUTD, 240, measure);
check("never smaller than the floor", r.size >= F.MIN, true);
check("wrapped", r.wrapped, true);
check("to two lines", r.lines.length, 2);
check("both of which fit", r.lines.every((l) => measure(l, r.size) <= 240), true);
check("nothing was dropped", r.truncated, false);
check("and together they are the whole name", r.lines.join(" "), SUTD);

console.log("\n-- and when even two lines will not hold it, it says so --");
// The one case that still loses words. It must not look like a name that
// simply ends there - that is the whole bug this file exists for. Nothing on
// the customer list reaches this; a 53-character name fits two lines at 7.4pt
// in the real cell.
r = F.fitCellText(SUTD, 120, measure);
check("flagged as truncated", r.truncated, true);
check("and marked where it stops", r.lines[1].endsWith("…"), true);
check("the mark still fits the cell", measure(r.lines[1], r.size) <= 120, true);

console.log("\n-- the floor is a floor, not a suggestion --");
r = F.fitCellText("X".repeat(400), 40, measure);
check("size is exactly the floor", r.size, F.MIN);
check("two lines at most", r.lines.length <= 2, true);

console.log("\n-- a word longer than the cell is left whole --");
// Better a name that overhangs by a hair than one that reads as a different
// word. "SUPERCALIFRAGILISTIC" is not a company, but a 30-character Malay or
// Tamil trading name is, and cutting one mid-word invents a word.
r = F.fitCellText("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA BHD", 60, measure);
check("the long word survives intact", r.lines[0], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
check("and so does the rest", r.lines[1], "BHD");

console.log("\n-- nothing in, nothing out --");
check("empty string", F.fitCellText("", 100, measure).lines, [""]);
check("null reads as empty", F.fitCellText(null, 100, measure).lines, [""]);
check("a number is a string", F.fitCellText(12345678, 100, measure).lines, ["12345678"]);

console.log("\n-- the cell widths the card is built from --");
// COMPANY is widest because it is the only value whose length is not known in
// advance: a date is a date, a phone number is eight digits, a contact is a
// person's name. If somebody rebalances these, the company name is the one
// that starts falling over again.
const w = F.META_WEIGHTS;
check("COMPANY is the widest cell", w.company > Math.max(w.date, w.contact, w.phone), true);
check("the four weights", [w.date, w.company, w.contact, w.phone], [1, 2.1, 1.25, 1]);
// A4 less 40pt margins each side, the geometry both sheets use.
const W = 595.28 - 80;
const total = w.date + w.company + w.contact + w.phone;
check("so COMPANY gets about 202pt of an A4 page", Math.round((W * w.company) / total), 202);

console.log("\n-- the two sheets agree, allowing for the slip's icon --");
// The slip has an icon in the cell and so passes 4pt less room. Same name,
// same cell: the sizes must be within one step of each other, or the two
// documents a customer receives are visibly different.
const cellW = (W * w.company) / total;
const slip = F.fitCellText("SembCorp Marine Facilities Pte Ltd", cellW - 28, measure);
const sheet = F.fitCellText("SembCorp Marine Facilities Pte Ltd", cellW - 24, measure);
check("both keep it on one line", [slip.wrapped, sheet.wrapped], [false, false]);
check("within one step of each other", Math.abs(slip.size - sheet.size) <= F.STEP + 1e-9, true);

console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
process.exit(failures ? 1 : 0);
