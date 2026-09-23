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
const path = require("path");
const db = require("./db");
// The one list of what the home screen has on it, shared with the browser -
// the same arrangement service-items.js and machine-types.js use.
const FN = require(path.join(__dirname, "..", "frontend", "app-functions.js"));

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
    `SELECT s.id AS session_id, u.id, u.name, u.role, u.tech, u.active, u.functions
       FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`
  ).get(tokenHash(token));
  if (!row || !row.active) return null;
  db.prepare("UPDATE app_sessions SET last_seen = datetime('now','localtime') WHERE id = ?")
    .run(row.session_id);
  return withFunctions(row);
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
    `SELECT id, name, role, tech, active, setup_open, functions,
            CASE WHEN password_hash = '' OR password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
            password_set_at
       FROM app_users ${activeOnly ? "WHERE active = 1" : ""} ORDER BY role, name`
  ).all().map(withFunctions);
}

// The stored JSON turned back into a list, plus what it works out to.
//
// A row that cannot be parsed - hand-edited, half-written - falls back to the
// job rather than throwing. Somebody losing their buttons because of a stray
// comma is a worse failure than the edit not taking.
function withFunctions(row) {
  if (!row) return row;
  let own = null;
  try { own = row.functions ? JSON.parse(row.functions) : null; } catch (_) { own = null; }
  const user = { ...row, functions: Array.isArray(own) ? own : null };
  return { ...user, effective_functions: FN.functionsFor(user), uses_default: FN.isDefault(user) };
}

// Give somebody their own list, or put them back on their job's.
//
// An empty list means "follow the job" rather than "no buttons at all": see
// functionsFor() for why the two have to be tellable apart, and note that a
// person with nothing ticked therefore gets their job's list back. That is the
// safer way round - the alternative is a screen with nothing on it and no
// explanation.
function setUserFunctions(userId, list) {
  const user = db.prepare("SELECT id, role FROM app_users WHERE id = ?").get(String(userId));
  if (!user) { const e = new Error("No such person."); e.status = 404; throw e; }
  const clean = FN.clean(list);
  // Ticking exactly what the job gives is not a custom list, it is the job -
  // so it is stored as nothing. That is how somebody is put BACK on their
  // job's list: tick it to match and save. Without this the row would say
  // "custom" forever, and a later change to what Technicians get would pass
  // this person by without anybody noticing.
  const same = clean.length && FN.isDefault({ role: user.role, functions: clean });
  db.prepare("UPDATE app_users SET functions = ? WHERE id = ?")
    .run(clean.length && !same ? JSON.stringify(clean) : null, String(userId));
  return withFunctions(db.prepare("SELECT * FROM app_users WHERE id = ?").get(String(userId)));
}

// SIX DIGITS. John's call, and the right trade for a workshop: it is typed on
// a phone with gloves half off, twenty times a day, by people who will write a
// long password on the back of the device rather than type it.
//
// Six digits is a million codes, which is not much - and the reason that is
// acceptable here is the lockout above, not the code itself. Eight wrong tries
// buys fifteen minutes, so working through a million takes about four years of
// uninterrupted guessing. What it would NOT survive is somebody walking off
// with the database file, where a million candidates is seconds of work; that
// is an argument for looking after backups, and it is written down in
// README so it is not rediscovered the hard way.
const CODE = /^\d{6}$/;

function setPassword(userId, password) {
  const pw = String(password == null ? "" : password).trim();
  if (!CODE.test(pw)) {
    const e = new Error("The code must be exactly 6 digits."); e.status = 400; throw e;
  }
  // A code everybody guesses first is not a code. These four are the ones that
  // turn up on every list of the commonest PINs there is.
  if (["123456", "000000", "111111", "654321"].includes(pw)) {
    const e = new Error("That code is too easy to guess. Pick another."); e.status = 400; throw e;
  }
  const user = db.prepare("SELECT id FROM app_users WHERE id = ?").get(String(userId));
  if (!user) { const e = new Error("No such person."); e.status = 404; throw e; }
  db.prepare(
    `UPDATE app_users SET password_hash = ?, password_set_at = datetime('now','localtime'),
            setup_open = 0 WHERE id = ?`
  ).run(hashPassword(pw), String(userId));
  return { id: String(userId) };
}

// Let somebody set their own code - for a new person, or one who has forgotten
// theirs. This is what an admin taps; it does not reveal anything and it does
// not choose anything. Their old code stops working immediately, which is what
// makes it a reset rather than a suggestion.
function openForSetup(userId) {
  const user = db.prepare("SELECT id FROM app_users WHERE id = ?").get(String(userId));
  if (!user) { const e = new Error("No such person."); e.status = 404; throw e; }
  db.prepare(
    "UPDATE app_users SET password_hash = '', password_set_at = NULL, setup_open = 1 WHERE id = ?"
  ).run(String(userId));
  return { id: String(userId), setup_open: true };
}

// The first code somebody chooses for themselves. Allowed only where an admin
// has opened the account - see setup_open in db.js for what that stops.
function firstCode(userId, password) {
  const id = String(userId || "");
  const user = db.prepare("SELECT * FROM app_users WHERE id = ? AND active = 1").get(id);
  if (!user || !user.setup_open || user.password_hash) {
    const e = new Error("This account is not waiting for a code. Ask John to open it for you.");
    e.status = 403; throw e;
  }
  setPassword(id, password);
  return { id };
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
    const e = new Error(`Too many wrong codes. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    e.status = 429; throw e;
  }

  const user = db.prepare("SELECT * FROM app_users WHERE id = ? AND active = 1").get(id);

  // The one case worth saying out loud: this person has been opened for setup
  // and has no code yet, so the screen should ask them to choose one rather
  // than tell them they got it wrong. It gives nothing away that the Users
  // screen has not already been told to give away - an admin opened it on
  // purpose, moments ago, having told them to go and do this.
  if (user && user.setup_open && !user.password_hash) {
    const e = new Error("Choose your 6-digit code."); e.status = 409; e.setup = true; throw e;
  }

  // Otherwise one message for everything: no such person, no code set, wrong
  // code. Three different messages would tell somebody which names are real
  // and which have never signed in - and the names are already on the screen.
  // Trimmed on BOTH sides. setPassword trims what it stores, so checking the
  // raw value would mean a code that was set and a code that was typed could
  // disagree about their own whitespace - and the person typing would have no
  // way of seeing why.
  const ok = user && user.password_hash
    && verifyPassword(String(password == null ? "" : password).trim(), user.password_hash);
  if (!ok) {
    const f = failures.get(id) || { count: 0, until: 0 };
    f.count += 1;
    f.until = Date.now() + LOCK_FOR_MS;
    failures.set(id, f);
    const e = new Error("That name and code do not match.");
    e.status = 401; throw e;
  }

  failures.delete(id);
  const token = createSession(user.id, device);
  const full = withFunctions(user);
  return {
    token,
    user: {
      id: user.id, name: user.name, role: user.role, tech: user.tech || "",
      functions: full.effective_functions,
    },
  };
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
  listUsers, setPassword, openForSetup, firstCode, login, setUserFunctions,
  requireLogin, setRequireLogin,
  // For the tests, which need to be able to put the lockout back.
  _resetFailures: () => failures.clear(),
};
