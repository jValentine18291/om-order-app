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
// does.
//
// .load() is the part that matters: requiring the module only defines the
// functions. Without the call this reported DRIVE_KEY_FILE as "(not set)" on a
// server where it was set perfectly well - which sent someone looking for a
// missing key that was never missing.
let serviceEnv = null;
try {
  serviceEnv = require(path.resolve(__dirname, "..", "backend", "serviceEnv.js"));
  serviceEnv.load();
} catch (e) {
  console.log("  (could not read the service settings: " + e.message + ")");
}

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
  // "Not set" on its own does not say WHICH problem it is, and the two want
  // completely different things doing about them: one is a setting to add,
  // the other is a Google account that has to be created first. So say which,
  // using the names the service actually holds - names only, never values.
  let names = [];
  try { names = Object.keys(serviceEnv ? serviceEnv.read() : {}).sort(); } catch (_) {}
  // Most specific first. A key path that IS set settles it on its own - the
  // state of the registry is beside the point once we know what to look at.
  if (c.keyFile) {
    console.log("  DRIVE_KEY_FILE points at a file that could not be read, or that is not");
    console.log("  a service account key. Check the path exists and is valid JSON with");
    console.log("  client_email and private_key in it.");
  } else if (!names.length) {
    console.log("  The OMService settings could not be read at all, so this cannot tell");
    console.log("  whether the key is missing or just not visible from here.");
    console.log("  Run it on the server as Administrator, or pass the file directly:");
    console.log("");
    console.log("      node tools\\show-drive-account.js C:\\om-order-app\\backend\\drive-key.json");
  } else if (!names.includes("DRIVE_KEY_FILE")) {
    console.log("  The service holds " + names.length + " setting(s), and DRIVE_KEY_FILE is not");
    console.log("  among them — so Google was never set up on this server at all:");
    console.log("");
    for (const n of names) console.log("      " + n);
    console.log("");
    console.log("  That needs a Google service account creating and its key file put on");
    console.log("  this server before a sheet can be written to. Nothing else here works");
    console.log("  until then.");
  }
  console.log("");
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
