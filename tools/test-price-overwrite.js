// Changing a price AutoCount ALREADY has - who may, and what still stops them.
//
//   node tools/test-price-overwrite.js C:/temp/scratch.db
//
// WHY THIS EXISTS
// Until now the app could only ever FILL IN a blank price. That was not a
// limitation, it was the safety: there is nothing to lose by writing into an
// empty column, and the app cannot undo anything it writes to the accounts.
// Letting one person replace an existing price removes that safety, so what is
// left in its place has to be checked, and checked by something other than
// somebody remembering.
//
// Three things are tested, and each is a mistake that would otherwise be
// invisible until it had already cost a real price:
//
//   1. The two permission lists AGREE. One lives in server.js and enforces;
//      the other in app.js and only decides whether a button is drawn. Editing
//      one and not the other either locks John out or shows everybody a button
//      the server will refuse.
//   2. setMissingPrice STILL cannot overwrite. It is the function every
//      automatic write goes through - a technician's typed price, the Sales
//      Order conversion - and none of those should ever have gained this new
//      power by proximity.
//   3. overwritePrice keeps every OTHER guard. It drops exactly one.
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
async function throws(what, fn, wantStatus) {
  try {
    await fn();
    failures++;
    console.log(` FAIL  ${what}: it was allowed`);
  } catch (e) {
    const ok = e.status === wantStatus;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${e.status} ${e.message}`);
  }
}

const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const serverSrc = read("backend/server.js");
const appSrc = read("frontend/app.js");
const acSrc = read("backend/data/autocountRepo.js");

// A list literal out of the source. Read rather than imported because one of
// the two files is browser code that cannot be required here at all.
function listFrom(src, name) {
  const m = src.match(new RegExp(name + "\\s*=\\s*\\[([^\\]]*)\\]"));
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

(async () => {
  console.log("-- the server and the browser must agree on who may do this --");
  const onServer = listFrom(serverSrc, "PRICE_OVERWRITE_USERS");
  const onClient = listFrom(appSrc, "CAN_OVERWRITE_PRICE");
  check("the server has a list", Array.isArray(onServer), true);
  check("the browser has one too", Array.isArray(onClient), true);
  check("they are the same", onServer, onClient);
  check("and John is on it", (onServer || []).includes("john"), true);
  // Identified by STAFF id, not initials: John's initials are the single
  // letter "J", and a permission hanging on one letter is one new colleague
  // away from being wrong.
  check("the id, not the initials", (onServer || []).includes("J"), false);

  console.log("\n-- the automatic writes must NOT have gained this power --");
  // Every unattended write - a technician's typed price at Save, the backstop
  // when Sales convert the slip - goes through updateItemPriceIfMissing, and
  // the deliberate "Set price" button through setMissingPrice. Both must still
  // refuse to touch a price that is there, and both prove it in the SQL rather
  // than by having read the current value a moment earlier.
  const missingFn = acSrc.slice(acSrc.indexOf("async function setMissingPrice"),
                                acSrc.indexOf("async function overwritePrice"));
  check("setMissingPrice still returns already_priced", /status:\s*"already_priced"/.test(missingFn), true);
  check("and still guards the UPDATE itself", /IS NULL OR .* = 0/.test(missingFn), true);
  const autoFn = acSrc.slice(acSrc.indexOf("async function updateItemPriceIfMissing"),
                             acSrc.indexOf("async function setMissingPrice"));
  // It has no UPDATE of its own - it hands off to setMissingPrice, so there is
  // exactly one implementation of the guard and the automatic path cannot drift
  // away from the deliberate one. What matters is that it still hands off THERE.
  check("the automatic write delegates to setMissingPrice", /setMissingPrice\s*\(/.test(autoFn), true);
  check("and never to overwritePrice", /overwritePrice/.test(autoFn), false);
  check("overwritePrice is a separate function, not a flag",
    /async function overwritePrice/.test(acSrc) && !/setMissingPrice\s*\([^)]*overwrite/.test(acSrc), true);

  console.log("\n-- overwritePrice drops ONE guard and keeps the rest --");
  const ac = require(path.resolve(__dirname, "..", "backend", "data", "autocountRepo.js"));
  // All of these are refused before any query runs, so no AutoCount is needed
  // to prove them - which is the point: they are the cheap guards that catch
  // the expensive mistakes.
  await throws("an unknown price type is refused",
    () => ac.overwritePrice("SZEN 1", "wholesale", 10), 400);
  await throws("a missing item code is refused",
    () => ac.overwritePrice("", "contractor", 10), 400);
  await throws("zero is refused",
    () => ac.overwritePrice("SZEN 1", "contractor", 0), 400);
  await throws("a negative price is refused",
    () => ac.overwritePrice("SZEN 1", "contractor", -5), 400);
  await throws("and the fat-finger ceiling still holds",
    () => ac.overwritePrice("SZEN 1", "contractor", 100001), 400);

  console.log("\n-- the route asks for an overwrite explicitly, never infers it --");
  // A client retrying a "set" on a part somebody else has just priced must not
  // become an overwrite by accident, so the flag is sent, not deduced from the
  // price already being there.
  check("the route reads an explicit flag", /overwrite\s*&&\s*!PRICE_OVERWRITE_USERS/.test(serverSrc), true);
  check("and refuses with 403 when it is not John", /403\).json\(\{\s*\n?\s*error: "Only John can change/.test(serverSrc), true);
  check("the browser sends the user id", /user_id:\s*\(getUser\(\)\s*\|\|\s*\{\}\)\.id/.test(appSrc), true);

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})();
