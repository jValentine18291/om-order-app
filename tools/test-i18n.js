// The Chinese interface, checked without a browser.
//
//   node tools/test-i18n.js
//
// i18n.js is a browser file - an IIFE that hangs itself off window - so it is
// given a window and read back, the same way fogger-tubes.js is tested.
//
// WHAT THIS GUARDS
// A dictionary is an object literal, and a repeated key in an object literal
// takes its LAST value in silence. That is not theoretical: "Received" is
// written twice, once for a shipment (已收货) and once for a machine received
// at the counter (收件), and every "Received" in the app had quietly become
// 收件. "Sales Order" was written twice with two different words. Nothing
// reported either one - the file parses, the app runs, and the wrong word
// simply appears.
//
// So: a key may be repeated only if both copies say the same thing. Where the
// two meanings really differ, the English has to differ too, which is why a
// purchase order says "Goods received" rather than "Received".
const fs = require("fs");
const path = require("path");

const FILE = path.resolve(__dirname, "..", "frontend", "i18n.js");
const src = fs.readFileSync(FILE, "utf8");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

console.log("\n-- it loads --");
// A minimal window. The file reads localStorage and installs a MutationObserver
// on document.body at boot; with readyState "loading" it waits instead, which
// is what lets this run with no DOM at all.
const store = {};
global.window = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  confirm: () => true,
};
global.localStorage = global.window.localStorage;
global.document = {
  readyState: "loading",
  documentElement: {},
  addEventListener: () => {},
};
new Function(src)();
const I = global.window.OM_I18N;
check("it hangs itself off window", !!I, true);
check("and offers the language it decided on", typeof I.language, "function");

console.log("\n-- who gets Chinese --");
// The switch belongs to everyone now, so a stored choice decides and the role
// only supplies the default. Nobody moves language because of that: the
// defaults are exactly what they were.
const lang = (role, choice) => {
  store["om_role"] = role;
  if (choice === undefined) delete store["om_lang"];
  else store["om_lang"] = choice;
  return I.language();
};
check("a technician still opens in Chinese", lang("tech"), "zh");
check("sales still opens in English", lang("sales"), "en");
check("so does the purchaser", lang("purchaser"), "en");
check("so does admin", lang("admin"), "en");
check("and a phone with no role at all", lang(""), "en");
check("a technician who chose English gets English", lang("tech", "en"), "en");
check("sales who chose Chinese gets Chinese", lang("sales", "zh"), "zh");
check("and a nonsense value falls back to the role", lang("tech", "klingon"), "zh");

console.log("\n-- no key means two different things --");
const re = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*$|^\s*"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*")/gm;
const seen = new Map();
const conflicts = [];
let m;
while ((m = re.exec(src))) {
  const key = m[1] !== undefined ? m[1] : m[2];
  const val = m[3] === undefined ? null : m[3];   // null = value on the next line
  if (seen.has(key) && seen.get(key) !== val) conflicts.push(key);
  else seen.set(key, val);
}
check("every repeated key says the same thing both times", conflicts, []);

console.log("\n-- every pattern is anchored --");
// The safety rule the file is built on: a phrase is translated only when the
// WHOLE text matches. An unanchored pattern would rewrite the middle of a
// customer's name or a part description coming out of AutoCount.
const pats = [];
const pre = /\[\s*(\/(?:\\.|\[[^\]]*\]|[^/\\])+\/[gimsuy]*)\s*,/g;
while ((m = pre.exec(src))) pats.push(m[1]);
check("there are patterns to check", pats.length > 0, true);
const loose = pats.filter((p) => !(p.startsWith("/^") && /\$\/[gimsuy]*$/.test(p)));
check("none of them can match a fragment", loose, []);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
