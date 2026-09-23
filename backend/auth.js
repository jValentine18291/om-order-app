// auth.js
// ============================================================================
// WHO IS USING THE APP, and what they may do.
//
// Until September 2026 the answer was "whoever says so". The name on the first
// screen was a label the browser chose for itself, and all seventy-five routes
// believed it - so "only Sales may edit a slip" was enforced by nothing but
// the browser's good manners. That was survivable while the app could only be
// reached from inside the office. It is about to be reachable over the company
// VPN, so it is not survivable any more.
//
// NO NEW DEPENDENCIES. Passwords are hashed with scrypt out of node:crypto
// rather than bcrypt, because bcrypt is a native module and this server has
// already been through one compile problem - better-sqlite3 carries a fallback
// for exactly that reason. scrypt is in the standard library, needs no build
// step, and is a password hash proper: deliberately slow, salted per user.
//
// WHAT IS STORED
//   - never the password. Only scrypt$N$r$p$salt$hash, salt random per user.
//   - never the session token. Only its SHA-256. A token is a password for as
//     long as it lives, and a database that leaks live sessions leaks every
//     phone at once.
//
// SESSIONS DO NOT EXPIRE ON A TIMER. John's call, and the right one for a
// workshop: a technician holding a carburettor should not be asked to type a
// password. The device is signed in once and stays signed in; a lost phone is
// dealt with by revoking its row, which is why each one records what it is and
// when it was last seen.
const crypto = require("crypto");
const db = require("./db");

// ---- Passwords -------------------------------------------------------------
// Defaults from Node's own documentation. N is the work factor and the only
// one worth tuning; 16384 takes a few tens of milliseconds here, which is
// slow enough to make guessing expensive and fast enough that nobody notices.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
          salt.toString("hex"), key.toString("hex")].join("$");
}

// Compared with timingSafeEqual rather than ===. A plain comparison stops at
// the first wrong byte, and how long it took is a clue about how much of the
// hash was right.
function verifyPassword(password, stored) {
  try {
    const [tag, N, r, p, saltHex, keyHex] = String(stored || "").split("$");
    if (tag !== "scrypt" || !saltHex || !keyHex) return false;
    const key = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"),
      keyHex.length / 2, { N: Number(N), r: Number(r), p: Number(p) });
    const want = Buffer.from(keyHex, "hex");
    return key.length === want.length && crypto.timingSafeEqual(key, want);
  } catch (_) {
    return false;
  }
}

// ---- Sessions --------------------------------------------------------------
const tokenHash = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

function createSession(userId, device) {
  // 32 bytes from the system's own source. Not Math.random(), which is
  // predictable and has no business anywhere near a credential.
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO app_sessions (user_id, token_hash, device) VALUES (?, ?, ?)"
  ).run(userId, tokenHash(token), String(device || "").slice(0, 120));
  return token;                         // the only time the token exists here
}

// The signed-in person behind a token, or null. Also stamps last_seen, which
// is what makes the Devices screen able to say "this one has not been used
// since March" - the phone in a drawer nobody remembers.
function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.id AS session_id, u.id, u.name, u.role, u.tech, u.active
       FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`
  ).get(tokenHash(token));
  if (!row || !row.active) return null;
  db.prepare("UPDATE app_sessions SET last_seen = datetime('now','localtime') WHERE id = ?")
    .run(row.session_id);
  return row;
}

function revokeSession(token) {
  db.prepare(
    "UPDATE app_sessions SET revoked_at = datetime('now','localtime') WHERE token_hash = ? AND revoked_at IS NULL"
  ).run(tokenHash(token));
}

function revokeSessionById(id) {
  const r = db.prepare(
    "UPDATE app_sessions SET revoked_at = datetime('now','localtime') WHERE id = ? AND revoked_at IS NULL"
  ).run(Number(id));
  return r.changes > 0;
}

// Every device a person has signed in on. Revoking one is how a lost phone is
// dealt with, so this is the screen that matters when something goes missing.
function listSessions(userId) {
  const where = userId ? "WHERE s.user_id = ?" : "";
  const rows = db.prepare(
    `SELECT s.id, s.user_id, u.name, s.device, s.created_at, s.last_seen, s.revoked_at
       FROM app_sessions s JOIN app_users u ON u.id = s.user_id
       ${where} ORDER BY s.revoked_at IS NOT NULL, s.last_seen DESC`
  );
  return userId ? rows.all(userId) : rows.all();
}

// ---- People ----------------------------------------------------------------
// Never the hash. This is read by the Users screen and by the sign-in screen,
// and a hash has no business travelling to a browser on either trip.
function listUsers({ activeOnly = false } = {}) {
  return db.prepare(
    `SELECT id, name, role, tech, active,
            CASE WHEN password_hash = '' OR password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
            password_set_at
       FROM app_users ${activeOnly ? "WHERE active = 1" : ""} ORDER BY role, name`
  ).all();
}

function setPassword(userId, password) {
  const pw = String(password || "");
  // Eight is the floor, not the advice. A workshop phone is typed on with
  // gloves half off; a rule long enough to be resented is a rule answered with
  // the same password everywhere.
  if (pw.length < 8) { const e = new Error("A password must be at least 8 characters."); e.status = 400; throw e; }
  const user = db.prepare("SELECT id FROM app_users WHERE id = ?").get(String(userId));
  if (!user) { const e = new Error("No such person."); e.status = 404; throw e; }
  db.prepare(
    "UPDATE app_users SET password_hash = ?, password_set_at = datetime('now','localtime') WHERE id = ?"
  ).run(hashPassword(pw), String(userId));
  return { id: String(userId) };
}

// ---- Signing in ------------------------------------------------------------
// Guessing is made expensive in memory rather than in the database: this is one
// process, restarts are rare, and a table of failures is a table somebody has
// to prune. Counted per PERSON, because the name is the part an attacker on
// the VPN already knows - the first screen lists them.
const failures = new Map();
const LOCK_AFTER = 8;
const LOCK_FOR_MS = 15 * 60 * 1000;

function lockedFor(userId) {
  const f = failures.get(userId);
  if (!f || f.count < LOCK_AFTER) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { failures.delete(userId); return 0; }
  return left;
}

function login(userId, password, device) {
  const id = String(userId || "");
  const wait = lockedFor(id);
  if (wait) {
    const e = new Error(`Too many wrong passwords. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    e.status = 429; throw e;
  }

  const user = db.prepare("SELECT * FROM app_users WHERE id = ? AND active = 1").get(id);
  // One message for "no such person", "no password set" and "wrong password".
  // Three different messages would tell somebody which names are real and
  // which of them have never signed in - and the names are already public.
  const ok = user && user.password_hash && verifyPassword(password, user.password_hash);
  if (!ok) {
    const f = failures.get(id) || { count: 0, until: 0 };
    f.count += 1;
    f.until = Date.now() + LOCK_FOR_MS;
    failures.set(id, f);
    const e = new Error("That name and password do not match.");
    e.status = 401; throw e;
  }

  failures.delete(id);
  const token = createSession(user.id, device);
  return { token, user: { id: user.id, name: user.name, role: user.role, tech: user.tech || "" } };
}

// ---- The switch ------------------------------------------------------------
// Off until somebody turns it on, so this can be deployed, every password set
// up calmly, and only THEN enforced - rather than a deploy that locks the
// counter out of its own app at ten past nine. See backend/require-login.js.
function requireLogin() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'require_login'").get();
  return String((row && row.value) || "off").toLowerCase() === "on";
}

function setRequireLogin(on) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('require_login', ?) " +
             "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "on" : "off");
  return requireLogin();
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, sessionUser, revokeSession, revokeSessionById, listSessions,
  listUsers, setPassword, login,
  requireLogin, setRequireLogin,
  // For the tests, which need to be able to put the lockout back.
  _resetFailures: () => failures.clear(),
};
