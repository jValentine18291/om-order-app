// require-login.js
// ============================================================================
// Turns the sign-in requirement on and off.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node require-login.js            <- says which it is now
//   node require-login.js on         <- nobody reaches the app without signing in
//   node require-login.js off        <- back to how it was before logins existed
//
// WHY THIS IS A SWITCH AND NOT JUST HOW THE APP WORKS
// Turning logins on is the one change that can stop every phone in the
// building at once. Deploying it as simply "on" would mean the counter
// discovers it at ten past nine, with a customer in front of them and nobody
// holding a password. So it deploys OFF, and the order of the day is:
//
//   1. deploy
//   2. node let-me-in.js john, then choose your code in the app
//   3. sign in and let everybody else in (Admin -> People & devices)
//   4. have one technician sign in on their own phone and do a real job
//   5. THEN run this with "on"
//
// And if something is wrong, "off" puts it back in one command - no deploy, no
// git, no waiting. That is the whole reason it exists.
//
// It changes one row in one table. It does not touch a password, a session or
// a slip, and it needs no restart: the setting is read fresh on every request.
// ============================================================================

if (process.env.OM_DB_PATH) {
  console.log("");
  console.log("OM_DB_PATH is set. Refusing: this is meant for the live database");
  console.log("on the server, and pointing it elsewhere would switch logins on");
  console.log("for a copy nobody uses. Run it from the backend folder.");
  console.log("");
  process.exit(1);
}

const auth = require("./auth");

const arg = String(process.argv[2] || "").toLowerCase();

if (!arg) {
  const on = auth.requireLogin();
  const people = auth.listUsers();
  const ready = people.filter((u) => u.has_password && u.active);
  console.log("");
  console.log(`  Signing in is ${on ? "REQUIRED" : "not required"}.`);
  console.log(`  ${ready.length} of ${people.filter((u) => u.active).length} people have a password.`);
  console.log("");
  if (!on) console.log("  To turn it on:   node require-login.js on");
  else console.log("  To turn it off:  node require-login.js off");
  console.log("");
  process.exit(0);
}

if (arg !== "on" && arg !== "off") {
  console.log(`\n"${process.argv[2]}" is not on or off.\n`);
  process.exit(1);
}

if (arg === "on") {
  // Refusing here is the difference between a careful change and a locked
  // door. An admin with no password cannot sign in, and nobody else can give
  // them one - there would be no way back in except this script, which is on
  // the server, which is the one place the person who needs it is not.
  const admins = auth.listUsers().filter((u) => u.role === "admin" && u.active && u.has_password);
  if (!admins.length) {
    console.log("");
    console.log("  Refusing: not one admin has a password yet, so turning this on");
    console.log("  would lock everybody out of the app - including whoever would");
    console.log("  have to hand out the passwords.");
    console.log("");
    console.log("  Let yourself in first:   node let-me-in.js john");
    console.log("");
    process.exit(1);
  }
  const ready = auth.listUsers().filter((u) => u.active && u.has_password).length;
  const total = auth.listUsers().filter((u) => u.active).length;
  if (ready < total) {
    console.log("");
    console.log(`  Note: ${total - ready} of ${total} people still have no password.`);
    console.log("  They will not be able to use the app until you give them one.");
    console.log("");
  }
}

auth.setRequireLogin(arg === "on");
console.log("");
console.log(`  Signing in is now ${auth.requireLogin() ? "REQUIRED" : "not required"}.`);
console.log("  It takes effect immediately - no restart.");
console.log("");
