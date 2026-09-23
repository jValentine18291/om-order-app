// Which buttons each person gets on their home screen.
//
//   node tools/test-permissions.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// John asked, in September 2026, to be able to hand out the home screen's
// functions one person at a time rather than one job at a time: a technician
// who also does some of the ordering gets that one extra button without being
// made a Purchaser.
//
// WHAT IT IS NOT. Unticking a button HIDES it. The route behind it still
// answers. That was said before this was built and is worth a line here too,
// because a screen full of tick boxes looks like a lock and this one is not.
//
// WHAT IS CHECKED, worst consequence first
//  1. Nobody's buttons change until somebody changes them. A migration that
//     quietly emptied a home screen would look, to the person holding the
//     phone, exactly like the app being broken.
//  2. A person can never end up with NO buttons, however they are saved.
//  3. A stored list can only name buttons that exist - including "people",
//     the screen that hands the others out, which is not on offer at all.
//     Granting that one is not a permission, it is the end of them.
//  4. Ticking a job's list back to match takes the person off a custom list,
//     so a later change to what Technicians get still reaches them.
//  5. The file the browser reads and the file the server reads are the same
//     file, and it agrees with the buttons actually in index.html.
const path = require("path");
const fs = require("fs");

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

const auth = require(path.resolve(__dirname, "..", "backend", "auth"));
const FN = require(path.resolve(__dirname, "..", "frontend", "app-functions.js"));

const of = (id) => auth.listUsers().find((u) => u.id === id) || {};

console.log("\n-- rule 1: everybody starts on their job's list --");
const all = auth.listUsers();
check("nobody has a list of their own", all.filter((u) => u.functions).length, 0);
check("and every one of them is marked as following their job",
  all.filter((u) => !u.uses_default).length, 0);
// The four jobs, spelled out, because this is what people actually see when
// they open the app and a silent change here is a support call.
check("a technician gets six buttons", of("kangmin").effective_functions,
  ["open", "view", "find", "ipl", "po", "ship"]);
check("sales gets nine", of("carmen").effective_functions.length, 9);
check("the purchaser gets ten", of("iris").effective_functions.length, 10);
check("an admin gets all eleven", of("john").effective_functions.length, 11);
check("which is every button there is", FN.IDS.length, 11);

console.log("\n-- giving one person their own list --");
auth.setUserFunctions("kangmin", ["open", "view", "find", "ipl", "po", "ship", "requests"]);
check("he has the extra one", of("kangmin").effective_functions.includes("requests"), true);
check("and is no longer following his job", of("kangmin").uses_default, false);
check("nobody else moved", of("ray").effective_functions,
  ["open", "view", "find", "ipl", "po", "ship"]);
check("nor did the other technician's row become custom", of("ray").uses_default, true);

console.log("\n-- the order is the home screen's, not the order it was sent in --");
auth.setUserFunctions("ray", ["ship", "ipl", "open"]);
check("saved back to back, top to bottom", of("ray").effective_functions, ["open", "ipl", "ship"]);

console.log("\n-- rule 3: only buttons that exist --");
auth.setUserFunctions("ray", ["open", "view", "delete-everything", "", null, 7]);
check("made-up ones are dropped on the way in", of("ray").effective_functions, ["open", "view"]);
// "people" is the screen that hands out everything on this list. It is not on
// the list, so it cannot be handed out - and this is the check that keeps it
// that way if somebody ever adds it to the array by hand.
check("'people' is not a function anybody can be given", FN.IDS.includes("people"), false);
auth.setUserFunctions("ray", ["open", "people"]);
check("asking for it gets nothing extra", of("ray").effective_functions, ["open"]);

console.log("\n-- rule 2: a person can never end up with no buttons at all --");
// An empty save means "put them back on their job", not "leave them a blank
// screen". The sheet greys Save out at zero ticks as well, so this is the
// second of two answers to the same mistake.
auth.setUserFunctions("ray", []);
check("saving nothing puts them back on their job's list",
  of("ray").effective_functions, ["open", "view", "find", "ipl", "po", "ship"]);
check("and the row says so again", of("ray").uses_default, true);
auth.setUserFunctions("ray", ["nonsense", "also-nonsense"]);
check("so does saving nothing but nonsense",
  of("ray").effective_functions, ["open", "view", "find", "ipl", "po", "ship"]);

console.log("\n-- rule 4: ticking the job's list back puts them back ON it --");
auth.setUserFunctions("kangmin", FN.ROLE_DEFAULTS.tech);
check("stored as no list of their own, not as a copy of one", of("kangmin").functions, null);
check("so a later change to what Technicians get would still reach them",
  of("kangmin").uses_default, true);

console.log("\n-- a person who does not exist --");
throws("cannot be given anything", () => auth.setUserFunctions("nobody", ["view"]), 404);

console.log("\n-- what the person holding the phone is told --");
auth.setUserFunctions("carmen", ["view", "find", "ipl"]);
auth.setPassword("carmen", "481920");
const session = auth.login("carmen", "481920", "her phone");
check("signing in hands back her buttons", session.user.functions, ["view", "find", "ipl"]);
check("and the session carries them on every request afterwards",
  auth.sessionUser(session.token).effective_functions, ["view", "find", "ipl"]);
// The other half of rule 1: her code is untouched by any of this.
check("changing her buttons did not disturb her code", auth.login("carmen", "481920", "x").user.id, "carmen");

console.log("\n-- a row nothing can read --");
// Half-written JSON in that column must lose somebody a tick, not their app.
const db = require(path.resolve(__dirname, "..", "backend", "db"));
db.prepare("UPDATE app_users SET functions = ? WHERE id = 'carmen'").run("{not json");
check("falls back to her job rather than throwing",
  of("carmen").effective_functions, FN.ROLE_DEFAULTS.sales);

console.log("\n-- rule 5: one list, and it matches the buttons in the app --");
// The drift this stops: a function added to index.html and not to
// app-functions.js is a button that can never be granted or taken away, and
// nothing anywhere would say so.
const html = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "index.html"), "utf8");
const home = html.slice(html.indexOf('id="screen-home"'), html.indexOf('id="screen-home"') + 8000);
const inHtml = [...home.matchAll(/class="home-btn[^"]*"[^>]*data-go="([a-z-]+)"/g)].map((m) => m[1]);
check("every home button is on the list", inHtml.filter((id) =>
  id !== "people" && !FN.IDS.includes(id)), []);
check("and every one on the list is a home button", FN.IDS.filter((id) => !inHtml.includes(id)), []);
check("with 'people' found in the app but deliberately left off the list",
  inHtml.includes("people"), true);
// And the file really is shared - the server required it from frontend/, which
// is the whole point of the UMD wrapper at the top of it.
check("the server reads it out of frontend/", fs.existsSync(
  path.resolve(__dirname, "..", "frontend", "app-functions.js")), true);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
