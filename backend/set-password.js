// set-password.js
// ============================================================================
// Gives somebody a password, from the server.
//
// HOW TO RUN (on the server, from the backend folder):
//
//   node set-password.js john
//
// It asks for the password rather than taking it on the command line, because
// a command line ends up in the terminal's history, in a screenshot, and in
// whatever anybody scrolls back to. It is not shown as it is typed.
//
// WHEN YOU NEED THIS
// Once, to give the first admin a password - before that there is nobody who
// can hand one out, and the Users screen in the app cannot be reached. After
// that, everything is done from Admin -> Users and this sits here unused,
// which is the right amount of use for a script that can set any password on
// the system.
//
// It can also put you back in if you ever lock yourself out.
// ============================================================================

if (process.env.OM_DB_PATH) {
  console.log("\nOM_DB_PATH is set. Refusing: run this from the backend folder,");
  console.log("against the live database, or you will set a password nobody uses.\n");
  process.exit(1);
}

const readline = require("readline");
const auth = require("./auth");

const who = String(process.argv[2] || "").trim();

if (!who) {
  const people = auth.listUsers();
  console.log("\n  Who? Give the id from this list:\n");
  for (const u of people) {
    console.log(`    ${u.id.padEnd(12)} ${String(u.name).padEnd(14)} ${u.role.padEnd(10)}` +
                `${u.has_password ? "has a password" : "no password yet"}${u.active ? "" : "  (not active)"}`);
  }
  console.log("\n  e.g.  node set-password.js john\n");
  process.exit(1);
}

const user = auth.listUsers().find((u) => u.id === who);
if (!user) {
  console.log(`\n  There is nobody called "${who}". Run it with no name to see the list.\n`);
  process.exit(1);
}

// Typed blind. Node has no built-in way to do this, so the trick is to take
// over the echo ourselves: readline writes nothing for each keystroke.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Enter, and the two ways a terminal says "stop".
      if (["\n", "\r", "\u0004"].includes(String(char))) process.stdin.removeListener("data", onData);
      else readline.clearLine(process.stdout, 0) && readline.cursorTo(process.stdout, 0) && process.stdout.write(question);
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

(async () => {
  console.log(`\n  Setting a password for ${user.name} (${user.id}, ${user.role}).`);
  if (user.has_password) console.log("  They already have one. This replaces it.");
  console.log("");

  const first = await askHidden("  New password (at least 8 characters): ");
  const again = await askHidden("  Type it again:                        ");

  if (first !== again) {
    console.log("\n  Those two do not match. Nothing has been changed.\n");
    process.exit(1);
  }
  try {
    auth.setPassword(user.id, first);
  } catch (e) {
    console.log(`\n  ${e.message} Nothing has been changed.\n`);
    process.exit(1);
  }
  console.log(`\n  Done. ${user.name} can now sign in.`);
  console.log("  Everything else is done from Admin -> Users inside the app.\n");
  process.exit(0);
})();
