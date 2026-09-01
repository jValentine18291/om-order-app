// drive.js
// ============================================================================
// Keeps a copy of every Service Slip PDF in a staff-only Google Drive folder,
// and hands out a link to ONE slip when it is sent to its customer.
//
// WHY A LINK AND NOT AN ATTACHMENT
// WhatsApp will only list a customer in the share sheet once something has been
// sent to them, so attaching the PDF to a brand-new customer meant: open the
// chat, send a message, come back to the app, share, pick the chat. A link
// rides inside the message itself, so it is one trip.
//
// WHY NO GOOGLE LIBRARIES
// The official client pulls in several hundred packages for what is two HTTP
// calls and a signature. Deploys here are a git pull and an npm install on a
// machine in the workshop, so every dependency is a thing that can break a
// deploy. This signs its own token with node's crypto and calls the REST API.
//
// WHY A SERVICE ACCOUNT AND A SHARED DRIVE
// A service account has no Drive storage of its own, so it cannot own files in
// somebody's My Drive. In a Shared Drive the storage belongs to the company, so
// files survive anyone leaving and nothing has to be re-authorised. This is why
// the folder must live in a Shared Drive, not in a personal Drive.
//
// SETTINGS (all on the server, never in the repo)
//   DRIVE_ENABLED        "true" to allow uploads at all. Default off.
//   DRIVE_FOLDER_ID      the staff-only folder inside the Shared Drive
//   DRIVE_KEY_FILE       path to the service account's JSON key
//   DRIVE_API_BASE       override the API host (used by the tests)
//   DRIVE_TOKEN_URL      override the token endpoint (used by the tests)
// ============================================================================

const fs = require("fs");
const crypto = require("crypto");

const API_BASE = process.env.DRIVE_API_BASE || "https://www.googleapis.com";
const TOKEN_URL = process.env.DRIVE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";

const on = (v) => String(v || "false").toLowerCase() === "true";

function config() {
  return {
    enabled: on(process.env.DRIVE_ENABLED),
    folderId: process.env.DRIVE_FOLDER_ID || "",
    keyFile: process.env.DRIVE_KEY_FILE || "",
  };
}

// The key is read from disk each time it is needed rather than held in memory,
// so replacing a rotated key is a file copy and a restart, not a code change.
// Never logged, and never returned to the app.
function readKey() {
  const { keyFile } = config();
  if (!keyFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    if (!raw.client_email || !raw.private_key) return null;
    return { email: raw.client_email, key: raw.private_key };
  } catch (_) {
    return null;                    // unreadable or not JSON: treated as absent
  }
}

// Switched on AND actually set up, reported separately so the app can say "not
// configured" instead of failing at the moment somebody presses a button.
function readiness() {
  const c = config();
  const missing = [];
  if (!c.folderId) missing.push("DRIVE_FOLDER_ID");
  if (!c.keyFile) missing.push("DRIVE_KEY_FILE");
  else if (!readKey()) missing.push("DRIVE_KEY_FILE (unreadable or not a service account key)");
  return { enabled: c.enabled, configured: missing.length === 0, missing };
}

// ---- Auth -------------------------------------------------------------------
// A service account proves who it is by signing a short-lived claim with its
// private key and trading that for an access token. Tokens last an hour; this
// keeps one and renews a minute early rather than signing on every upload.
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let cached = { token: "", expires: 0 };

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.expires > now + 60) return cached.token;

  const k = readKey();
  if (!k) throw new Error("Google Drive is not set up on this server (no service account key).");

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
    // The key itself is never included in the message.
    throw new Error(`Google refused the service account: ${body.error_description || body.error || r.status}`);
  }
  cached = { token: body.access_token, expires: now + (Number(body.expires_in) || 3600) };
  return cached.token;
}

async function api(path, { method = "GET", headers = {}, body } = {}) {
  const token = await accessToken();
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { /* not JSON */ }
  if (!r.ok) {
    const msg = (parsed.error && (parsed.error.message || parsed.error.status)) || text.slice(0, 200) || r.status;
    throw new Error(`Drive: ${msg}`);
  }
  return parsed;
}

// ---- Uploading --------------------------------------------------------------
// One file per slip, replaced in place when the slip is edited and sent again,
// so a customer opening an old link sees the current document rather than a
// second file appearing beside the first.
function multipart(meta, pdf) {
  const boundary = "om" + crypto.randomBytes(12).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, pdf, tail]) };
}

async function uploadSlip({ slipNumber, company, pdf, fileId = "" }) {
  const { folderId } = config();
  const name = `ServiceSlip_${slipNumber}${company ? " - " + String(company).replace(/[\\/:*?"<>|]/g, "").trim() : ""}.pdf`;

  // Updating keeps the id, and so keeps any link already sent to a customer
  // working. Creating is only for a slip Drive has not seen before.
  const meta = fileId ? { name } : { name, parents: [folderId] };
  const { boundary, body } = multipart(meta, pdf);
  const path = fileId
    ? `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=id`
    : `/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`;

  const saved = await api(path, {
    method: fileId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return saved.id;
}

// Anyone holding the link may read THIS file. Drive permissions are per file,
// so this exposes the one slip and nothing else: the folder cannot be listed,
// and no other customer's slip is reachable from it.
async function shareFile(fileId) {
  await api(`/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
}

// Straight to the file rather than Drive's viewer: on a phone the viewer asks
// people to sign in or install something, and the customer only wants the PDF.
function downloadLink(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

// Put a slip in Drive, and hand out a link only when it is actually going to a
// customer. Filing every slip is the archive; a slip nobody sends has no reason
// to be readable by anyone holding a link, so `share` is off by default and the
// send path is the only thing that turns it on.
//
// `fileId` is whatever was stored last time, so a re-send replaces the file
// instead of piling up copies.
async function storeAndShare({ slipNumber, company, pdf, fileId = "", share = false }) {
  const r = readiness();
  if (!r.enabled) throw new Error("Google Drive is switched off on this server.");
  if (!r.configured) throw new Error(`Google Drive is not set up: missing ${r.missing.join(", ")}.`);

  let id;
  try {
    id = await uploadSlip({ slipNumber, company, pdf, fileId });
  } catch (e) {
    // The stored id can go stale - a file deleted from Drive by hand. Rather
    // than failing for good, take it as new and upload a fresh copy.
    if (fileId && /404|not found/i.test(e.message)) {
      id = await uploadSlip({ slipNumber, company, pdf, fileId: "" });
    } else {
      throw e;
    }
  }
  if (!share) return { fileId: id, link: "" };
  await shareFile(id);
  return { fileId: id, link: downloadLink(id) };
}

module.exports = { config, readiness, storeAndShare, downloadLink, uploadSlip, shareFile };
