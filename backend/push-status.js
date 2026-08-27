// backend/push-status.js — what the push list actually contains, and whether
// each device can be reached.
//
// Run it on the server:
//     node backend\push-status.js
//     node backend\push-status.js --send      (also sends a real test to each)
//
// "It doesn't work on that phone" has two quite different causes, and this
// separates them:
//   - the phone is NOT in the list  -> it never subscribed. The app could not
//     register its service worker, which on Android means the certificate is
//     not properly trusted (clicking through the warning is not enough).
//   - the phone IS in the list but the send fails -> it subscribed fine and the
//     push service is refusing. The reason it gives is printed.
//
// Endpoints are capability URLs: anyone holding one can send notifications to
// that device. Only the host and a short fingerprint are printed, never the URL.
const crypto = require("crypto");
const db = require("./db");
const push = require("./push");

const SEND = process.argv.includes("--send");

// Which push service, from the endpoint's host. Each vendor runs its own.
function service(endpoint) {
  let host = "";
  try { host = new URL(endpoint).host; } catch (_) { return "unknown"; }
  if (host.endsWith("push.apple.com")) return "Apple  (iPhone/iPad)";
  if (host.includes("fcm.googleapis.com") ||
      host.includes("android.googleapis.com")) return "Google (Android/Chrome)";
  if (host.includes("mozilla.com")) return "Mozilla (Firefox)";
  if (host.includes("notify.windows.com")) return "Microsoft (Edge)";
  return host;
}

const fingerprint = (e) => crypto.createHash("sha256").update(e).digest("hex").slice(0, 8);

(async () => {
  push.init(db);
  const rows = db.prepare("SELECT * FROM push_subscriptions ORDER BY role, user_id").all();

  if (!rows.length) {
    console.log("\nNo device has turned notifications on.\n");
    return;
  }

  console.log(`\n${rows.length} device(s) subscribed:\n`);
  console.log("  ROLE        WHO     DEVICE                   ADDED              ID");
  console.log("  " + "-".repeat(74));
  for (const r of rows) {
    console.log(
      "  " + String(r.role || "-").padEnd(11) +
      " " + String(r.user_id || "-").padEnd(7) +
      " " + service(r.endpoint).padEnd(24) +
      " " + String(r.created_at || "-").padEnd(18) +
      " " + fingerprint(r.endpoint)
    );
  }

  // Which push services are represented at all. A role with iPhones but no
  // Android device is the whole answer on its own.
  const kinds = new Set(rows.map((r) => service(r.endpoint)));
  console.log("\n  Push services in use: " + [...kinds].join(", "));
  if (![...kinds].some((k) => k.startsWith("Google"))) {
    console.log("\n  No Android device is subscribed. The phone never registered,");
    console.log("  so nothing was ever going to reach it - see DEVICE-SETUP.md,");
    console.log("  Android. Clicking through the certificate warning is not enough:");
    console.log("  Chrome refuses to run the app's background worker on a site whose");
    console.log("  certificate it does not trust, and that worker is what receives");
    console.log("  notifications. The certificate has to be installed.");
  }

  if (!SEND) {
    console.log("\n  Add --send to send a real test notification to each device.\n");
    return;
  }

  console.log("\nSending a test to each device:\n");
  for (const r of rows) {
    const res = await push.testOne(db, r.endpoint);
    console.log(`  ${fingerprint(r.endpoint)}  ${service(r.endpoint).padEnd(24)} ` +
                (res.ok ? "accepted by the push service" : `FAILED - ${res.reason}`));
  }
  console.log("\n  \"accepted\" means the push service took it. If a phone still shows");
  console.log("  nothing, the notification was blocked on the phone itself - Android:");
  console.log("  Settings > Apps > Chrome > Notifications, and check battery");
  console.log("  optimisation is not restricting Chrome.\n");
})();
