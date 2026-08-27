// backend/push.js — web push notifications
// ============================================================================
// Tells sales, on their phone, that a technician has finished a repair and it
// is waiting to be priced. Before this they only found out by opening the app.
//
// HOW IT WORKS, BRIEFLY
// A browser that agrees to notifications hands us a "subscription": an address
// at its own vendor's push service (Google's for Chrome, Apple's for Safari)
// plus two keys. We store it, and to notify that device we post an encrypted
// message to that address. The vendor delivers it, and the app's service worker
// wakes up and shows it. Nothing runs on the phone in between.
//
// WHAT IT NEEDS
//   - HTTPS with a certificate the device trusts. Not optional: a browser will
//     not hand out a subscription over an untrusted connection. See
//     DEVICE-SETUP.md.
//   - Outbound HTTPS from this server to the push services.
//   - On iOS: the app must have been added to the Home Screen, and iOS 16.4 or
//     later. Safari tabs on iOS get nothing.
//
// WHAT IT DOES NOT NEED — and this is the difference from the WhatsApp work —
// no account, no third party, no verification. The keys below are generated
// here, by us, on first run.
// ============================================================================

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const KEY_FILE = path.join(__dirname, "vapid.json");

// The keypair identifies this server to the push services. It is generated once
// and then must never change: every subscription a device has given us is tied
// to the public half, so replacing the file silently breaks all of them.
// Gitignored — the private key is a credential.
function loadKeys() {
  try {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    if (saved.publicKey && saved.privateKey) return saved;
  } catch (_) { /* first run */ }

  const fresh = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEY_FILE, JSON.stringify(fresh, null, 2));
  console.log("[push] generated a new VAPID keypair in backend/vapid.json");
  console.log("[push] keep that file: every device's subscription is tied to it");
  return fresh;
}

const keys = loadKeys();
// The contact address is what a push service uses to reach the operator if this
// server misbehaves. It has to be a mailto: or https: URL.
webpush.setVapidDetails(
  process.env.PUSH_CONTACT || "mailto:sales@gardenequipment.com.sg",
  keys.publicKey,
  keys.privateKey
);

// ---- storage ---------------------------------------------------------------
// One row per device, not per person: someone with a phone and a tablet gets
// told on both, which is what they would expect.
function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      user_id    TEXT NOT NULL DEFAULT '',
      role       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
}

function subscribe(db, { subscription, user_id = "", role = "" }) {
  const s = subscription || {};
  const keysIn = s.keys || {};
  if (!s.endpoint || !keysIn.p256dh || !keysIn.auth) {
    const e = new Error("Incomplete push subscription.");
    e.status = 400;
    throw e;
  }
  // Re-subscribing replaces the row rather than adding another: a browser hands
  // back the same endpoint, and the person or role attached to it may have
  // changed since.
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id, role)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth,
       user_id = excluded.user_id, role = excluded.role`
  ).run(s.endpoint, keysIn.p256dh, keysIn.auth, String(user_id), String(role));
  return { ok: true };
}

function unsubscribe(db, endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(String(endpoint || ""));
  return { ok: true };
}

function countFor(db, roles) {
  const marks = roles.map(() => "?").join(",");
  return db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE role IN (${marks})`)
           .get(...roles).n;
}

// ---- sending ---------------------------------------------------------------
// Never throws: a notification failing must not take a slip update down with
// it. The status change is the thing that matters; telling people is a
// courtesy on top.
async function notify(db, roles, payload) {
  let sent = 0, gone = 0, failed = 0;
  const marks = roles.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM push_subscriptions WHERE role IN (${marks})`
  ).all(...roles);

  await Promise.all(rows.map(async (row) => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      // 404 or 410 means the browser threw the subscription away — the app was
      // deleted, or notifications were turned off in the phone's settings.
      // Keeping it would mean retrying a dead address for ever.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(row.endpoint);
        gone++;
      } else {
        failed++;
        // Not every failure comes from the push service. A malformed key fails
        // here, before any request is made, and carries no status at all — so
        // logging only the status code prints "undefined undefined" and tells
        // whoever is reading it nothing.
        const status = err && err.statusCode ? `HTTP ${err.statusCode}` : "no response";
        const detail = (err && (err.body || err.message)) || "unknown";
        console.error(`[push] send failed (${status}): ${String(detail).slice(0, 200)}`);
      }
    }
  }));

  if (sent || gone || failed) {
    console.log(`[push] ${payload.title}: ${sent} sent` +
                (gone ? `, ${gone} expired and removed` : "") +
                (failed ? `, ${failed} failed` : ""));
  }
  return { sent, gone, failed };
}

module.exports = {
  publicKey: keys.publicKey,
  init,
  subscribe,
  unsubscribe,
  countFor,
  notify,
};
