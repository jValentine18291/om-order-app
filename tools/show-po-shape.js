// Which PO columns the app decided to use.
//
//   cd /d C:\om-order-app
//   node tools\show-po-shape.js
//
// RUN THIS ON THE SERVER. The app works out the shape of AutoCount's PO and
// PODtl tables at startup, choosing from a list of names each version might
// use. That guess is invisible until a screen looks subtly wrong - lines in
// the wrong order, a blank supplier - so this prints what it actually picked.
//
// COLUMN NAMES ONLY. It reads no purchase orders and prints no data.
const path = require("path");

try { require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load(); }
catch (e) { console.log("  (could not read the service settings: " + e.message + ")"); }

const acRepo = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));

(async () => {
  const source = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
  console.log("");
  if (source !== "autocount") {
    console.log("  ITEMS_SOURCE is \"" + source + "\", so the app is not reading AutoCount at all.");
    console.log("  Run this on the server, where the service sets it to autocount.");
    console.log("");
    process.exitCode = 1;
    return;
  }

  let shape;
  try {
    shape = await acRepo.purchaseOrderShape();
  } catch (e) {
    console.log("  Could not reach AutoCount: " + e.message);
    console.log("");
    process.exitCode = 1;
    return;
  }

  if (!shape) {
    console.log("  The PO / PODtl tables are not the shape the app expects, so the");
    console.log("  Purchase Orders screen will say it cannot read them.");
    console.log("");
    console.log("  Run backend\\inspect-po.js to see what is actually there.");
    console.log("");
    process.exitCode = 1;
    return;
  }

  const show = (label, value, why) => {
    const v = value ? value : "(not found)";
    console.log("  " + label.padEnd(22) + v + (why ? "   " + why : ""));
  };

  console.log("  The columns the Purchase Orders screen is using:\n");
  console.log("  PO");
  show("  document number", shape.mNo);
  show("  date", shape.docDate);
  show("  supplier", shape.creditorName || shape.creditorCode,
       shape.creditorName || shape.creditorCode ? "" : "<- the supplier column will be blank");
  show("  cancelled flag", shape.cancelled);
  console.log("");
  console.log("  PODtl");
  show("  item code", shape.dtlItem);
  show("  description", shape.dtlDesc);
  show("  unit", shape.dtlUom);
  show("  quantity", shape.dtlQty);
  show("  outstanding", shape.outstanding || shape.transferred,
       shape.outstanding ? "" : shape.transferred ? "(ordered minus transferred)" : "(ordered qty only)");
  show("  LINE ORDER", shape.dtlSeq,
       shape.dtlSeq ? "" : "<- lines will fall back to alphabetical");
  console.log("");
  console.log("  If the line order on screen still does not match the PO in AutoCount,");
  console.log("  the sequence column is named something else. Run");
  console.log("  backend\\inspect-po.js and send me the PODtl column list.");
  console.log("");
})();
