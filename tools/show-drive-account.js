// Who to share the Google Sheet (or Drive folder) with.
//
//   cd /d C:\om-order-app
//   node tools\show-drive-account.js
//
// RUN THIS ON THE SERVER, FROM THE APP FOLDER. The service account key only
// exists there, and this reads the address out of it so nobody has to go
// digging in the Google console.
//
// If the service settings cannot be read for any reason, the key file can be
// given directly instead:
//
//   node tools\show-drive-account.js C:\om-order-app\backend\drive-key.json
//
// The address is an identity, not a credential - it is what you type into
// Google's "Share" box. The private key sitting beside it in the same file is
// the secret, and is never printed, here or anywhere else.
const path = require("path");

// The env vars live on the service, not in a shell, so a bare `node` run has
// to be told where the key is. serviceEnv reads the same NSSM settings the app
// does, when it can.
try { require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")); } catch (_) { /* optional */ }

// An explicit path wins over the service settings, so this still works on a
// machine where the registry cannot be read.
if (process.argv[2]) process.env.DRIVE_KEY_FILE = process.argv[2];

const sheets = require(path.resolve(__dirname, "..", "backend", "sheets.js"));

const email = sheets.serviceAccountEmail();
const r = sheets.readiness();
const c = sheets.config();

console.log("");
if (!email) {
  console.log("  No service account key could be read.");
  console.log("  DRIVE_KEY_FILE is: " + (c.keyFile || "(not set)"));
  console.log("");
  console.log("  Set DRIVE_KEY_FILE to the service account .json on this server,");
  console.log("  then run this again.");
  process.exit(1);
}

console.log("  Share the sheet with this address, as an Editor:");
console.log("");
console.log("      " + email);
console.log("");
console.log("  Sheet logging is " + (c.enabled ? "ON" : "OFF (SHEETS_ENABLED is not true)"));
console.log("  Sheet id        : " + (c.locationSheetId || "(not set — LOCATION_SHEET_ID)"));
console.log("  Tab             : " + c.tab);
if (!r.configured) {
  console.log("");
  console.log("  Still missing   : " + r.missing.join(", "));
}
console.log("");
console.log("  The Sheets API also has to be enabled on that service account's");
console.log("  Google Cloud project, which is a one-off in the console.");
console.log("");
