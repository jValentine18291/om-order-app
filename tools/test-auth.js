// Passwords, sessions, and who is allowed to be signed in.
//
//   node tools/test-auth.js C:/temp/scratch.db
//
// WHY THIS IS THE MOST IMPORTANT TEST IN THE FOLDER
// Everything else here guards a number on a document. This guards whether a
// stranger can read every customer's name, number and signature, or raise a
// Sales Order in the company's name. Until now the answer was "yes, if they
// can reach the server" - the name on the first screen was a label the browser
// chose for itself and all seventy-five routes believed it. That was only
// survivable because the app could not be reached from outside the office.
//
// WHAT IS CHECKED, worst consequence first
//  1. The password is NOT in the database. Not in any column, in any form.
//  2. A wrong password is refused, and so is a right password for somebody who
//     has none set - a fresh account must not be an open door.
//  3. The same password hashes differently for two people, so a stolen
//     database cannot be attacked once for everybody at a time.
//  4. A token is not stored either, and a revoked one stops working at once.
//  5. Guessing is rate limited, and the message never says WHICH part was
//     wrong - the names are on the sign-in screen, so "no such person" would
//     be a free list of which accounts are real.
//  6. The switch is off until somebody turns it on, so a deploy cannot lock
//     the counter out of its own app.
const path = require("path");

const target = process.argv[2];
const live = path.resolve(__dirname, "..", "backend", "om_orders.db");
if (!target) {
  console.error("Give a scratch database path, e.g. node " + path.basename(__filename) + " C:/temp/scratch.db");
  process.exit(2);
}
if (path.resolve(target) === live) {
  console.error("Refusing to run against the live database: " + live);
  process.exit(2);
}
process.env.OM_DB_PATH = target;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}
function throws(what, fn, wantStatus) {
  try {
    fn();
    failures++;
    console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = !wantStatus || e.status === wantStatus;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${e.message}`);
  }
}

const db = require(path.resolve(__dirname, "..", "backend", "db"));
const auth = require(path.resolve(__dirname, "..", "backend", "auth"));

const PW = "481920";          // six digits, as the workshop asked for

console.log("\n-- the staff who were already on the picker --");
const users = auth.listUsers();
check("they are all there", users.length, 13);
check("and not one of them can sign in yet",
  users.filter((u) => u.has_password).length, 0);
check("nor does the list carry a hash",
  Object.keys(users[0]).filter((k) => /hash|password_hash/.test(k)), []);

console.log("\n-- rule 2: an account with no password is not an open door --");
// The worst possible bug here: a fresh account accepting anything, or empty.
throws("an empty password does not get in", () => auth.login("john", "", "test"), 401);
throws("nor does any other", () => auth.login("john", PW, "test"), 401);
auth._resetFailures();

console.log("\n-- rule 1: the password is not in the database --");
auth.setPassword("john", PW);
// Every column of every table, not just the one we think it is in.
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
let leaked = [];
for (const t of tables) {
  const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
  for (const row of rows) {
    for (const [col, val] of Object.entries(row)) {
      if (typeof val === "string" && val.includes(PW)) leaked.push(`${t.name}.${col}`);
    }
  }
}
check("it appears nowhere, in any table, in any column", leaked, []);
const stored = db.prepare("SELECT password_hash FROM app_users WHERE id = 'john'").get().password_hash;
check("what is stored is a scrypt hash", /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(stored), true);

console.log("\n-- rule 3: two people, one password, two different hashes --");
auth.setPassword("carmen", PW);
const other = db.prepare("SELECT password_hash FROM app_users WHERE id = 'carmen'").get().password_hash;
check("the same password stored twice looks different", stored === other, false);
// Which is the whole point of a per-user salt: one guess cannot be tried
// against everybody at once.
check("because the salts differ", stored.split("$")[4] === other.split("$")[4], false);

console.log("\n-- signing in --");
throws("the wrong password is refused", () => auth.login("john", "wrong one", "iPad"), 401);
auth._resetFailures();
const session = auth.login("john", PW, "John's iPhone");
check("the right one is not", session.user.id, "john");
check("and it hands back who they are", [session.user.name, session.user.role], ["John", "admin"]);
check("with a token that is not guessable", session.token.length >= 48, true);

console.log("\n-- rule 4: the token is not stored either --");
const sessionRows = db.prepare("SELECT * FROM app_sessions").all();
check("the token itself is nowhere in the table",
  sessionRows.filter((r) => Object.values(r).includes(session.token)).length, 0);
check("but it does identify the person", (auth.sessionUser(session.token) || {}).id, "john");
check("and the device is remembered, for when one goes missing",
  sessionRows[0].device, "John's iPhone");
check("a made-up token is nobody", auth.sessionUser("not a real token"), null);

console.log("\n-- revoking a device stops it at once --");
const second = auth.login("john", PW, "the lost one");
check("two devices signed in", auth.listSessions("john").filter((s) => !s.revoked_at).length, 2);
auth.revokeSession(second.token);
check("the revoked one is nobody now", auth.sessionUser(second.token), null);
// And the other device is untouched - revoking is per device, not per person.
check("the other one still works", (auth.sessionUser(session.token) || {}).id, "john");

console.log("\n-- a deactivated person cannot use a token they already had --");
db.prepare("UPDATE app_users SET active = 0 WHERE id = 'john'").run();
check("their live session stops working", auth.sessionUser(session.token), null);
db.prepare("UPDATE app_users SET active = 1 WHERE id = 'john'").run();
check("and works again when they are put back", (auth.sessionUser(session.token) || {}).id, "john");

console.log("\n-- rule 5: guessing is expensive, and says nothing useful --");
auth._resetFailures();
let messages = new Set();
for (let i = 0; i < 8; i++) {
  try { auth.login("carmen", "wrong " + i, "x"); } catch (e) { messages.add(e.message); }
}
throws("locked out after eight tries", () => auth.login("carmen", PW, "x"), 429);
check("even with the RIGHT password", true, true);
// One message for every kind of failure. Three different ones would tell an
// attacker which names are real and which have never signed in.
check("and every refusal said the same thing", [...messages], ["That name and password do not match."]);
throws("a name that does not exist says it too",
  () => auth.login("nobody", "whatever", "x"), 401);
auth._resetFailures();

console.log("\n-- the code is six digits, and not a famous one --");
throws("five digits is refused", () => auth.setPassword("carmen", "12345"), 400);
throws("seven is too", () => auth.setPassword("carmen", "1234567"), 400);
throws("so are letters", () => auth.setPassword("carmen", "abcdef"), 400);
throws("and nothing at all", () => auth.setPassword("carmen", ""), 400);
// Six digits is a million codes. That is only enough because of the lockout
// above - and not at all if everybody picks the same four.
throws("123456 is not a code", () => auth.setPassword("carmen", "123456"), 400);
throws("nor is 000000", () => auth.setPassword("carmen", "000000"), 400);
throws("a person who does not exist cannot be given one",
  () => auth.setPassword("nobody", PW), 404);

console.log("\n-- choosing your own code the first time --");
// The hole this closes: without it, the first person to open the app could
// pick somebody else's name and choose a code for them.
throws("an account nobody opened refuses a first code",
  () => auth.firstCode("shirley", "302010"), 403);
auth.openForSetup("shirley");
check("opening it says so", auth.listUsers().find((u) => u.id === "shirley").setup_open, 1);
auth.firstCode("shirley", "302010");
check("now she has one", auth.listUsers().find((u) => u.id === "shirley").has_password, 1);
check("and the account closed itself behind her",
  auth.listUsers().find((u) => u.id === "shirley").setup_open, 0);
throws("so it cannot be used twice",
  () => auth.firstCode("shirley", "999888"), 403);
check("she can sign in with it", auth.login("shirley", "302010", "x").user.id, "shirley");

console.log("\n-- a reset lets them choose again, and stops the old one at once --");
auth.openForSetup("shirley");
auth._resetFailures();
throws("the old code no longer works", () => auth.login("shirley", "302010", "x"), 409);
check("and the app is told to ask for a new one", true, true);
auth._resetFailures();
auth.firstCode("shirley", "775533");
check("the new one works", auth.login("shirley", "775533", "x").user.id, "shirley");

console.log("\n-- nothing anywhere can read a code back --");
// The admin can RESET, not READ. Worth pinning down, because "let John see
// them" is a reasonable-sounding request that would undo the hash entirely.
const everything = JSON.stringify(auth.listUsers());
check("the list of people does not carry one", everything.includes("775533"), false);
const row = db.prepare("SELECT * FROM app_users WHERE id = 'shirley'").get();
check("nor does the row itself",
  Object.values(row).some((v) => String(v).includes("775533")), false);

console.log("\n-- rule 6: the switch starts off --");
check("nothing is enforced until somebody says so", auth.requireLogin(), false);
check("turning it on turns it on", auth.setRequireLogin(true), true);
check("and it can be turned back off", auth.setRequireLogin(false), false);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
