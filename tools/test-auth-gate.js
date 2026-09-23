// Does the lock actually lock? Against the real server, over HTTP.
//
//   node tools/test-auth-gate.js
//
// WHY THIS IS SEPARATE FROM test-auth.js
// That one checks the lock mechanism: scrypt, tokens, revoking. This one
// checks the DOOR - that the mechanism is actually fitted to it, and fitted to
// all of it. Those are different failures. A perfect password system that one
// route forgets to consult is not a security feature, it is a security
// feeling, and that is exactly the state this app was in: four routes out of
// seventy-five checked a role, and the role was a word the browser made up.
//
// So this stands the real server up and asks it questions the way a phone -
// or somebody on the company VPN who is not supposed to be there - would.
//
// WHAT IS CHECKED
//  1. With the switch OFF, nothing changes. That is how it ships, and a deploy
//     that quietly locked the counter out would be an outage, not a fix.
//  2. With it ON, an unauthenticated request to /api gets 401. Not some
//     routes. The ones carrying customer names, and the ones that write.
//  3. The sign-in screen still works while locked, or there is no way in.
//  4. A real token gets through, and a revoked one stops.
//  5. Roles are enforced from the SESSION. A technician cannot become an admin
//     by saying so, which is precisely what the old checks allowed.
//  6. The app itself is still served, because the sign-in page is part of it.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const root = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-gate-"));
const DB = path.join(dir, "gate.db");
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;

// Passwords are set through the module, against the same database the server
// will open - the server has no route for the first one, on purpose.
process.env.OM_DB_PATH = DB;
require(path.join(root, "backend", "db"));
const auth = require(path.join(root, "backend", "auth"));
const PW = "481920";      // six digits
auth.setPassword("john", PW);          // admin
auth.setPassword("kangmin", PW);       // technician
auth.openForSetup("carmen");           // waiting to choose her own

async function api(pathname, { token, method = "GET", body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

function start() {
  const child = spawn(process.execPath, [path.join(root, "backend", "server.js")], {
    env: { ...process.env, PORT: String(PORT), ITEMS_SOURCE: "sqlite", OM_DB_PATH: DB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      if (/running \(HTTP/.test(out)) setTimeout(() => resolve(child), 400);
    });
  });
}

(async () => {
  const server = await start();
  try {
    // The routes worth asking about: one that hands out customer names, one
    // that writes, and one that is only for admins.
    const READ = "/api/slips";
    const ADMIN = "/api/admin/users";

    console.log("\n-- rule 1: with the switch off, nothing changes --");
    check("it starts off", (await api("/api/auth/me")).json.require_login, false);
    check("a stranger can still read slips", (await api(READ)).status, 200);
    check("which is exactly how it behaved yesterday", true, true);

    console.log("\n-- signing in works whether or not it is required --");
    const bad = await api("/api/auth/login", { method: "POST", body: { user_id: "john", password: "wrong" } });
    check("a wrong password is refused", bad.status, 401);
    const inJohn = await api("/api/auth/login", { method: "POST", body: { user_id: "john", password: PW, device: "test" } });
    check("the right one is not", inJohn.status, 200);
    check("and it says who you are", inJohn.json.user.role, "admin");
    const johnToken = inJohn.json.token;

    const inKM = await api("/api/auth/login", { method: "POST", body: { user_id: "kangmin", password: PW, device: "phone" } });
    const kmToken = inKM.json.token;
    check("a technician can sign in too", inKM.json.user.role, "tech");

    console.log("\n-- the admin screens are shut even while the switch is off --");
    // These did not exist before logins did, so there is nothing to preserve -
    // and one of them sets somebody's password. Written permissive first and
    // caught here, which is the only reason it is not in production.
    check("a technician is refused", (await api(ADMIN, { token: kmToken })).status, 403);
    check("somebody with no token at all is refused", (await api(ADMIN)).status, 401);
    check("and setting a password needs an admin, not just a request",
      (await api("/api/admin/users/john/password", {
        method: "POST", body: { password: "654321" } })).status, 401);
    check("a technician cannot set one either",
      (await api("/api/admin/users/john/password", {
        token: kmToken, method: "POST", body: { password: "654321" } })).status, 403);
    check("while a real admin gets in", (await api(ADMIN, { token: johnToken })).status, 200);

    console.log("\n-- choosing your own code, over HTTP --");
    // Open to anyone signed in or not, because somebody choosing their first
    // code has no way to prove who they are yet. What stops it being a way
    // into a colleague's account is that an admin had to open it first.
    check("an account nobody opened refuses",
      (await api("/api/auth/first-code", {
        method: "POST", body: { user_id: "chiuyan", password: "302010" } })).status, 403);
    const firstIn = await api("/api/auth/first-code", {
      method: "POST", body: { user_id: "carmen", password: "302010", device: "counter" } });
    check("an opened one is let through", firstIn.status, 200);
    check("and signs her straight in", firstIn.json.user.id, "carmen");
    check("it cannot be used a second time",
      (await api("/api/auth/first-code", {
        method: "POST", body: { user_id: "carmen", password: "111222" } })).status, 403);

    console.log("\n-- a reset is a button, not a reveal --");
    check("an admin can reset somebody",
      (await api("/api/admin/users/carmen/reset", { token: johnToken, method: "POST" })).status, 200);
    check("her old code stops at once",
      (await api("/api/auth/login", {
        method: "POST", body: { user_id: "carmen", password: "302010" } })).status, 409);
    // The thing an admin CANNOT do, and the reason the reset button exists.
    const whatAdminSees = JSON.stringify((await api(ADMIN, { token: johnToken })).json);
    check("and nowhere does an admin see a code",
      /302010|481920/.test(whatAdminSees), false);

    console.log("\n-- rule 2: with the switch on, the door is shut --");
    auth.setRequireLogin(true);
    check("no token, no slips", (await api(READ)).status, 401);
    check("and it says why, so the app knows to ask",
      (await api(READ)).json.login_required, true);
    check("writing is shut too",
      (await api("/api/slips", { method: "POST", body: { company: "X" } })).status, 401);
    check("a made-up token is no token", (await api(READ, { token: "abc123" })).status, 401);

    console.log("\n-- rule 5: a role comes from the session, not from the request --");
    // THE old hole, exactly: this body used to be believed.
    check("saying 'role: admin' in the body buys nothing",
      (await api("/api/part-requests/batch/nope", {
        token: kmToken, method: "PATCH", body: { role: "admin" } })).status, 403);
    check("and an admin doing the same reaches the route properly",
      (await api("/api/part-requests/batch/nope", {
        token: johnToken, method: "PATCH", body: {} })).status, 404);

    console.log("\n-- rule 3: but the way in is still open --");
    check("the name list is readable", (await api("/api/auth/users")).status, 200);
    check("and signing in works",
      (await api("/api/auth/login", { method: "POST", body: { user_id: "john", password: PW } })).status, 200);

    console.log("\n-- rule 4: a real token gets through, a revoked one does not --");
    check("john can read slips", (await api(READ, { token: johnToken })).status, 200);
    const sessions = (await api("/api/admin/sessions", { token: johnToken })).json.sessions;
    const kmSession = sessions.find((s) => s.user_id === "kangmin" && !s.revoked_at);
    check("his devices are listed", !!kmSession, true);
    check("the technician can read slips too", (await api(READ, { token: kmToken })).status, 200);
    await api(`/api/admin/sessions/${kmSession.id}/revoke`, { token: johnToken, method: "POST" });
    check("until the phone is revoked", (await api(READ, { token: kmToken })).status, 401);
    check("and john is unaffected", (await api(READ, { token: johnToken })).status, 200);

    console.log("\n-- rule 6: the app itself is still served --");
    // The sign-in screen is part of the app. Gating it would be a locked door
    // with the handle on the inside.
    const page = await fetch(BASE + "/index.html");
    check("index.html loads without a token", page.status, 200);
    const ipl = await fetch(BASE + "/ipl/index.json");
    check("so do the parts drawings", ipl.status, 200);

    console.log("\n-- and it can be put back --");
    auth.setRequireLogin(false);
    check("off again", (await api(READ)).status, 200);
  } finally {
    server.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\n FAIL  the check could not run:", e.message, "\n");
  process.exit(1);
});
