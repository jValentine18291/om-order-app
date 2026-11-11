// LINK AN APP ORDER TO A SALES ORDER STAFF FINISHED IN AUTOCOUNT THEMSELVES.
//
//   cd /d C:\om-order-app
//   node tools\link-order-to-autocount.js SO-2026-00304 SO-2611-040
//   node tools\link-order-to-autocount.js SO-2026-00304 SO-2611-040 --apply
//
// RUN THIS ON THE SERVER. Without --apply it only looks and reports.
//
// Slip 00289, 10 Nov 2026: sending the order to AutoCount failed halfway, and
// left SO-2611-040 in AutoCount while the app kept its placeholder
// SO-2026-00304. The office then corrected SO-2611-040 by hand and raised a
// Delivery Order from it, so that is now the real order. This does for the
// app what a successful send would have done: records SO-2611-040 as the
// AutoCount document and takes its number, so the slip shows one number and
// picks up the DO by itself like every other order.
//
// AutoCount is only READ (one SELECT for the order, one for what was raised
// from it). The only thing written is the app's own record of the order.
const path = require("path");

try { require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load(); }
catch (e) { console.log("  (could not read the service settings: " + e.message + ")"); }

const [appSo, acSo] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((s) => String(s || "").trim().toUpperCase());
const apply = process.argv.includes("--apply");
if (!appSo || !acSo) {
  console.log("\n  Usage: node tools\\link-order-to-autocount.js <app order> <AutoCount SO> [--apply]\n");
  process.exit(2);
}

const repo = require(path.resolve(__dirname, "..", "backend", "data", "sqliteRepo.js"));
const say = (s = "") => console.log("  " + s);
function stop(why) { say(""); say("NOT CHANGED: " + why); say(""); process.exit(1); }

(async () => {
  console.log("");
  if ((process.env.ITEMS_SOURCE || "").toLowerCase() !== "autocount") {
    stop("this is not the server - AutoCount is not switched on here.");
  }
  const { query } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));
  const acRepo = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));

  // The app's side.
  const order = repo.getOrder(appSo);
  if (!order) stop(`the app has no order ${appSo}.`);
  const slipNo = String(order.notes || "").replace(/^S\/S:\s*/, "").trim();
  const slip = slipNo ? repo.slips.getSlip(slipNo) : null;
  say(`App order    ${order.so_number}  (slip ${slipNo || "?"}${slip ? ", " + slip.company : ""})`);
  say(`             debtor ${slip ? slip.debtor_code || "(none)" : "?"}, last error: ${order.autocount_error || "(none)"}`);
  if (order.autocount_doc_no) stop(`${appSo} is already linked to ${order.autocount_doc_no}.`);
  const taken = repo.getOrder(acSo);
  if (taken) stop(`${acSo} is already an order in the app (slip ${String(taken.notes || "").replace(/^S\/S:\s*/, "")}).`);

  // AutoCount's side - read only.
  const rows = await query(
    `SELECT DocNo, DocDate, DebtorCode, DebtorName, Cancelled, NetTotal
       FROM SO WHERE DocNo = @d`, { d: acSo });
  if (!rows.length) stop(`AutoCount has no Sales Order ${acSo}.`);
  const so = rows[0];
  const d = so.DocDate instanceof Date ? so.DocDate.toLocaleDateString("en-SG") : String(so.DocDate || "").slice(0, 10);
  say(`AutoCount    ${so.DocNo}  ${d}  ${String(so.DebtorCode || "").trim()} ${String(so.DebtorName || "").trim()}`);
  say(`             total ${Number(so.NetTotal || 0).toFixed(2)}${String(so.Cancelled).trim() === "T" ? "  ** CANCELLED **" : ""}`);
  if (String(so.Cancelled).trim() === "T") stop(`${acSo} is cancelled in AutoCount.`);
  if (slip && slip.debtor_code && String(so.DebtorCode || "").trim() !== String(slip.debtor_code).trim()) {
    stop(`${acSo} is for debtor ${String(so.DebtorCode).trim()}, but slip ${slipNo} is for ${slip.debtor_code}.`);
  }

  const raised = await acRepo.chainFrom([acSo]);
  say(`Raised from it: ${raised.length ? raised.map((r) => `${r.doc_no} (${r.kind}, ${r.doc_date})`).join(", ") : "nothing yet"}`);
  say("");

  if (!apply) {
    say(`Looks right? Run it again with --apply to link ${appSo} to ${acSo}.`);
    say("Nothing has been changed.");
    console.log("");
    return;
  }

  repo.slips.setOrderAutocountDocNo(appSo, acSo);
  const renamed = repo.slips.renameOrder(appSo, acSo);
  if (!renamed.ok) stop(renamed.reason);
  say(`DONE: ${appSo} is now ${renamed.so_number}, linked to AutoCount's ${acSo}.`);
  say(`Open slip ${slipNo} in the app and it will pick up the DO.`);
  console.log("");
})().catch((e) => { console.error("\n  Failed: " + e.message + "\n"); process.exit(1); });
