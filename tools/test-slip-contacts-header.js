// THE SECOND CONTACT ON A SLIP'S HEADER. No database needed:
//
//   node tools/test-slip-contacts-header.js
//
// John, 27 Oct 2026: the slip window in View Slips and the technician's slip
// screen showed only the first contact. The second now shows whenever it has
// a name or a number, and a name with no number says "no number". The first
// keeps its old wording exactly.
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
function lift(name) {
  const start = appSrc.indexOf("function " + name + "(");
  if (start < 0) throw new Error(`${name}() is not in frontend/app.js any more`);
  const end = appSrc.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return appSrc.slice(start, end + 2);
}
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slipContactsHtml = new Function("escapeHtml", lift("slipContactsHtml") + "\nreturn slipContactsHtml;")(escapeHtml);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
const lines = (slip) => [...slipContactsHtml(slip).matchAll(/<div class="vs-sub">(.*?)<\/div>/g)].map((m) => m[1]);

check("the first contact, as it always read",
  lines({ contact_name: "Mr Tan", contact_number: "9123 4567" }), ["Contact: Mr Tan · 9123 4567"]);
check("a second with a number",
  lines({ contact_name: "Mr Tan", contact_number: "9123 4567", contact2_name: "Ah Kow", contact2_number: "8111 2222" }),
  ["Contact: Mr Tan · 9123 4567", "Contact 2: Ah Kow · 8111 2222"]);
check("a second with a name and no number says so",
  lines({ contact_name: "Mr Tan", contact_number: "9123 4567", contact2_name: "Ah Kow" }),
  ["Contact: Mr Tan · 9123 4567", 'Contact 2: Ah Kow · <span class="vs-nonum">no number</span>']);
check("a second with a number and no name",
  lines({ contact_name: "Mr Tan", contact2_number: "8111 2222" }), ["Contact: Mr Tan", "Contact 2: 8111 2222"]);
check("blanks are not a contact",
  lines({ contact_name: "Mr Tan", contact2_name: "  ", contact2_number: "" }), ["Contact: Mr Tan"]);
check("nobody at all, nothing at all", slipContactsHtml({}), "");
check("a name is escaped", lines({ contact2_name: "<b>A&B</b>" }),
  ['Contact 2: &lt;b&gt;A&amp;B&lt;/b&gt; · <span class="vs-nonum">no number</span>']);
check("both headers use it", (appSrc.match(/\$\{slipContactsHtml\(slip\)\}/g) || []).length, 2);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
