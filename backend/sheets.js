// sheets.js
// ============================================================================
// Append a row to a Google Sheet.
//
// WHY THIS EXISTS
// Part locations are already written to backend/location-updates.log, which is
// the durable record and stays that way. But that file lives on the server,
// and the people who want to know who moved a part are the people without a
// login to it. A Sheet is the copy they can actually open.
//
// The log file is the record; the Sheet is the view of it. If Google is
// unreachable the change still happens and the log still has it - see the
// caller, which never lets a failed append break a location change.
//
// SET-UP (all three, or it stays switched off)
//   SHEETS_ENABLED=true
//   LOCATION_SHEET_ID    the long id out of the sheet's own URL:
//                        docs.google.com/spreadsheets/d/<THIS BIT>/edit
//   DRIVE_KEY_FILE       the SAME service account key Drive already uses
//
// And in Google, two things this code cannot do for itself:
//   1. The Sheets API has to be enabled on the service account's project.
//   2. The sheet has to be SHARED with the service account's email, as an
//      Editor. Run tools/show-drive-account.js on the server to print it.
//
// A different scope from drive.js, so it mints its own token: a Drive token
// does not open sheets.googleapis.com, and widening the Drive one would hand
// every Drive call more authority than it needs.
// ============================================================================

const fs = require("fs");
const crypto = require("crypto");

const API_BASE = process.env.SHEETS_API_BASE || "https://sheets.googleapis.com";
const TOKEN_URL = process.env.DRIVE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const on = (v) => String(v || "false").toLowerCase() === "true";

function config() {
  return {
    enabled: on(process.env.SHEETS_ENABLED),
    locationSheetId: process.env.LOCATION_SHEET_ID || "",
    keyFile: process.env.DRIVE_KEY_FILE || "",
    // Which tab. Google names the first one "Sheet1" unless somebody renames
    // it, and a wrong name fails loudly rather than writing somewhere odd.
    tab: process.env.LOCATION_SHEET_TAB || "Sheet1",
  };
}

// Read from disk each time, like drive.js: rotating a key is a file copy and a
// restart. Never logged, never returned to the app.
function readKey() {
  const { keyFile } = config();
  if (!keyFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    if (!raw.client_email || !raw.private_key) return null;
    return { email: raw.client_email, key: raw.private_key };
  } catch (_) {
    return null;
  }
}

// Who to share the sheet with. An identity rather than a secret - it is the
// address printed in the Google console - but it is only ever read on the
// server, by tools/show-drive-account.js.
function serviceAccountEmail() {
  const k = readKey();
  return k ? k.email : "";
}

function readiness() {
  const c = config();
  const missing = [];
  if (!c.locationSheetId) missing.push("LOCATION_SHEET_ID");
  if (!c.keyFile) missing.push("DRIVE_KEY_FILE");
  else if (!readKey()) missing.push("DRIVE_KEY_FILE (unreadable or not a service account key)");
  return { enabled: c.enabled, configured: missing.length === 0, missing };
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let cached = { token: "", expires: 0 };

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.expires > now + 60) return cached.token;

  const k = readKey();
  if (!k) throw new Error("Google Sheets is not set up on this server (no service account key).");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: k.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(k.key))}`;

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new Error(`Google refused the service account: ${body.error_description || body.error || r.status}`);
  }
  cached = { token: body.access_token, expires: now + (Number(body.expires_in) || 3600) };
  return cached.token;
}

async function api(path, { method = "GET", body } = {}) {
  const token = await accessToken();
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { /* not JSON */ }
  if (!r.ok) {
    const msg = (parsed.error && (parsed.error.message || parsed.error.status)) || text.slice(0, 200) || r.status;
    throw new Error(`Sheets: ${msg}`);
  }
  return parsed;
}

// The columns, in order. Kept here so the header row and every appended row
// cannot disagree about what goes where.
//
// There is deliberately no "Result" column, and so ONLY CHANGES THAT ACTUALLY
// HAPPENED are written here - see the caller. A sheet that also held refused
// and no-change attempts, with nothing to tell them apart, would show an
// attempt that was blocked as though the part had moved. Those are still in
// location-updates.log on the server, which remains the full record.
const LOCATION_COLUMNS = [
  "Date", "Time", "Part No.", "Description",
  "Previous location", "New location", "Changed by", "Role",
];

// Written once, and only into a sheet whose first row is empty. A sheet that
// already has something in A1 is left alone: it may be a header somebody has
// styled, or - worse - a row of real data, and overwriting either would be
// destroying the thing this is meant to preserve.
async function ensureHeader() {
  const { locationSheetId, tab } = config();
  const range = encodeURIComponent(`${tab}!A1:H1`);
  const got = await api(`/v4/spreadsheets/${encodeURIComponent(locationSheetId)}/values/${range}`);
  const first = (got.values && got.values[0]) || [];
  if (first.length) return false;
  await api(
    `/v4/spreadsheets/${encodeURIComponent(locationSheetId)}/values/${range}?valueInputOption=RAW`,
    { method: "PUT", body: { values: [LOCATION_COLUMNS] } }
  );
  return true;
}

// One location change, one row.
//
// Date and time are written as separate columns and as text, because a sheet
// left to guess turns "4/9/2026" into September the 4th for half the world and
// April the 9th for the other half. ISO date, 24-hour time, no ambiguity.
async function appendLocationChange(entry) {
  const c = config();
  if (!c.enabled) return { skipped: "SHEETS_ENABLED is not true" };
  const r = readiness();
  if (!r.configured) return { skipped: `not configured: ${r.missing.join(", ")}` };

  await ensureHeader();

  const when = entry.at instanceof Date ? entry.at : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;

  const row = [
    date,
    time,
    entry.itemCode || "",
    entry.description || "",
    // An item that had no location reads as that, not as an empty cell: blank
    // could mean "was empty" or "nobody filled this column in".
    entry.oldShelf ? String(entry.oldShelf) : "(none)",
    entry.newShelf || "",
    entry.who || "",
    entry.role || "",
  ];

  await api(
    `/v4/spreadsheets/${encodeURIComponent(c.locationSheetId)}/values/${encodeURIComponent(c.tab)}:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values: [row] } }
  );
  return { appended: true };
}

module.exports = {
  config, readiness, serviceAccountEmail, appendLocationChange, LOCATION_COLUMNS,
};
