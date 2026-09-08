// Which PO lines the "Add lines" picker offers, and which it leaves out.
//
//   node tools/test-picker-lines.js
//
// Going back into a half-shipped order should show what is still to come, not
// the whole order again. This runs the REAL renderPickerLines out of app.js
// against stubs, so what is checked is the shipped code and not a description
// of it.
const fs = require("fs");
const vm = require("vm");

const src = fs.readFileSync("P:/1-SCAN/om-order-app/frontend/app.js", "utf8");
const start = src.indexOf("function renderPickerLines()");
if (start < 0) throw new Error("renderPickerLines not found");
// To the blank line before the next top-level declaration.
const end = src.indexOf("\nfunction addPickedLines", start);
const fn = src.slice(start, end);

let html = "";
const sandbox = {
  escapeHtml: (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  trimNum: (n) => String(Number(n)),
  $: () => ({ set innerHTML(v) { html = v; }, addEventListener() {} }),
  spkPo: null, shipDraft: null, spkShowAll: false,
};
vm.createContext(sandbox);
vm.runInContext(fn, sandbox);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
// Which PO lines the picker offered, by the index it sends back to addPickedLines.
const offered = () => [...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]));
const filled = () => [...html.matchAll(/data-line="\d+"[\s\S]*?value="([^"]*)"/g)].map((m) => m[1]);

// PO-2609-016 as John described it, half of it already on an earlier shipment.
sandbox.spkPo = { doc_no: "PO-2609-016", items: [
  { seq: 1, item_code: "SHUQ 577317601", description: "Joint",  uom: "UNIT", qty: 2,  outstanding: 2,  allocated: 2 },
  { seq: 2, item_code: "SHUQ 505180901", description: "Hose",   uom: "UNIT", qty: 3,  outstanding: 3,  allocated: 3 },
  { seq: 3, item_code: "SHUQ 576594201", description: "Reel",   uom: "UNIT", qty: 10, outstanding: 10, allocated: 8 },
  { seq: 4, item_code: "SHUQ 531147157", description: "Seal",   uom: "UNIT", qty: 10, outstanding: 10, allocated: 0 },
]};

console.log("\n-- going back into a half-shipped order --");
sandbox.shipDraft = { id: 12, lines: [] };
sandbox.spkShowAll = false;
sandbox.renderPickerLines();
check("only what is still unspoken for", offered(), [2, 3]);
check("filled in with what is left", filled(), ["2", "10"]);
check("and it offers the rest back", /Show 2 lines already on a shipment/.test(html), true);
check("and the ones shown say what is claimed", /8 on another shipment/.test(html), true);

console.log("\n-- show all --");
sandbox.spkShowAll = true;
sandbox.renderPickerLines();
check("every line", offered(), [0, 1, 2, 3]);
check("the spoken-for ones start empty", filled(), ["", "", "2", "10"]);
check("and it can be put back", /Hide lines already on a shipment/.test(html), true);

console.log("\n-- a line already on THIS shipment is never hidden --");
// The whole of line 1 is on the shipment being edited. The server leaves that
// shipment out of `allocated`, so it arrives as 0 - but even so the line has
// to show, filled in, or a quantity typed by mistake could never be corrected.
sandbox.spkPo.items[0].allocated = 0;
sandbox.shipDraft = { id: 12, lines: [
  { po_no: "PO-2609-016", po_seq: 1, item_code: "SHUQ 577317601", qty: 2, po_qty: 2 },
]};
sandbox.spkShowAll = false;
sandbox.renderPickerLines();
check("it is there", offered().includes(0), true);
check("showing what is on it", filled()[0], "2");
check("and says so", /already on this one/.test(html), true);

console.log("\n-- one already on this shipment, and fully claimed elsewhere too --");
sandbox.spkPo.items[0].allocated = 2;
sandbox.renderPickerLines();
check("still offered, because it is mine to correct", offered().includes(0), true);
check("mine shown, not the leftover", filled()[0], "2");

console.log("\n-- nothing left on the order at all --");
sandbox.shipDraft = { id: null, lines: [] };
sandbox.spkPo = { doc_no: "PO-DONE", items: [
  { seq: 1, item_code: "A", description: "Gasket", uom: "UNIT", qty: 5, outstanding: 5, allocated: 5 },
]};
sandbox.renderPickerLines();
check("says so rather than showing an empty box",
  /Everything on this order is already on a shipment/.test(html), true);
check("and the way back is still there", /Show 1 line already on a shipment/.test(html), true);

console.log("\n-- a supplier who ships more than was ordered --");
sandbox.spkShowAll = true;
sandbox.renderPickerLines();
check("can still be recorded", offered(), [0]);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
