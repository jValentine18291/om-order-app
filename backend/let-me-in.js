// let-me-in.js
// ============================================================================
// Opens an account so that somebody can choose their own 6-digit code in the
// app. This is how the FIRST admin gets in; after that it is one tap on
// Admin -> People & devices and this sits here unused.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node let-me-in.js              <- shows everybody and where they stand
//   node let-me-in.js john         <- lets John choose a code, in the app
//
// Then open the app, tap that name, and it asks for a new code.
//
// WHY IT NO LONGER ASKS FOR THE CODE HERE
// It used to. set-password.js took the code at the server console with the
// echo turned off - the usual trick - and on a Windows console the trick did
// not hold: the digits appeared on screen anyway, and what was captured could
// not be relied on. John set a code, typed it correctly into the app, and was
// told it was wrong.
//
// So the terminal is out of the business of handling codes altogether. There
// is now ONE way a code is ever chosen - the six dots in the app - which is
// also the one that was already tested, already translated, and already
// refuses 123456. A second path that is used once a year is a path that is
// broken and nobody knows.
//
// This writes no code and reveals none. It clears whatever is stored and sets
// the flag that lets that person choose a new one.
// ============================================================================

if (process.env.OM_DB_PATH) {
  console.log("");
  console.log("OM_DB_PATH is set. Refusing: this is meant for the live database");
  console.log("on the server. Run it from the backend folder with nothing set.");
  console.log("");
  process.exit(1);
}

const auth = require("./auth");

const who = String(process.argv[2] || "").trim();
const people = auth.listUsers();

function state(u) {
  if (!u.active) return "not active";
  if (u.has_password) return "has a code";
  if (u.setup_open) return "waiting to choose one";
  return "cannot sign in yet";
}

if (!who) {
  console.log("");
  console.log(`  Signing in is ${auth.requireLogin() ? "REQUIRED" : "not required yet"}.`);
  console.log("");
  for (const u of people) {
    console.log(`    ${u.id.padEnd(12)} ${String(u.name).padEnd(14)} ${u.role.padEnd(10)} ${state(u)}`);
  }
  console.log("");
  console.log("  To let somebody choose a code:   node let-me-in.js john");
  console.log("");
  process.exit(0);
}

const user = people.find((u) => u.id === who);
if (!user) {
  console.log(`\n  There is nobody called "${who}". Run it with no name to see the list.\n`);
  process.exit(1);
}

try {
  auth.openForSetup(user.id);
} catch (e) {
  console.log(`\n  ${e.message}\n`);
  process.exit(1);
}

console.log("");
console.log(`  ${user.name} can now choose a code.`);
if (user.has_password) console.log("  Whatever they had before has stopped working.");
console.log("");
console.log("  Next: open the app, tap that name, and it will ask for a new");
console.log("  6-digit code. Nobody else can use the name until they have.");
console.log("");
