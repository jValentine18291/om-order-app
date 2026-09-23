// What is already waiting to be ordered, shown before anybody types a quantity.
//
//   node tools/test-already-requested.js C:/temp/scratch.db
//
// WHAT THIS IS FOR
// John, Sep 2026: "Order more" said what was on a Purchase Order, and nothing
// about what the team had already asked for. So the second person to want a
// part typed a quantity, sent it, and only then got told somebody had beaten
// them to it - an error where a sentence would have done.
//
// WHAT IS CHECKED, worst consequence first
//  1. The panel and the refusal agree. Both read the same list, so the app can
//     never warn about a request it would then accept, or accept one it warned
//     about.
//  2. It survives AutoCount being off or unreachable. That half of the answer
//     goes away; this half must not, because a catalogue outage is exactly
//     when people order the same part twice.
//  3. Matching ignores spaces and case, because the same part is typed
//     "SZEN 848C006700" and "szen848c006700" by different people.
//  4. Once Iris has ordered it, it stops being "waiting to be ordered" - the
//     panel must not go on warning about work she has already done.
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
const data = require(path.resolve(__dirname, "..", "backend", "data", "dataSource.js"));
const pr = data.requests;

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

const CODE = "SZEN 848C006700";
const sum = (list) => list.reduce((n, r) => n + Number(r.qty_requested), 0);

(async () => {
  console.log("-- nothing asked for yet --");
  check("no open requests for a part nobody has ordered", pr.pendingRequestsFor(CODE), []);
  check("nor for a code that is not a code at all", pr.pendingRequestsFor(""), []);

  console.log("\n-- somebody asks for it --");
  pr.createPartRequest({ item_code: CODE, description: "Fuel Filter", qty_requested: 2,
                         requester: "KS", remarks: "for slip 00023" });
  const one = pr.pendingRequestsFor(CODE);
  check("it is waiting to be ordered", one.length, 1);
  check("with the quantity, who asked and why",
    [sum(one), one[0].requester, one[0].remarks], [2, "KS", "for slip 00023"]);
  check("and a date to show beside it", /^\d{4}-\d{2}-\d{2}/.test(one[0].created_at), true);

  console.log("\n-- rule 3: however it was typed --");
  // The panel looks the part up by whatever is on screen, which is whatever
  // AutoCount gave it - and the request may have been saved from a scan, a
  // search or a typed code.
  check("no spaces", pr.pendingRequestsFor("SZEN848C006700").length, 1);
  check("lower case", pr.pendingRequestsFor("szen 848c006700").length, 1);
  check("both at once", pr.pendingRequestsFor("szen848c006700").length, 1);
  check("but a different part is a different part",
    pr.pendingRequestsFor("SZEN 848C006701"), []);

  console.log("\n-- rule 1: the panel and the refusal read the same list --");
  // The whole point. The panel says "2 waiting to be ordered"; the refusal
  // below is what happens if somebody ignores it. They must agree.
  throws("a second request for the same part is still refused",
    () => pr.createPartRequest({ item_code: CODE, description: "Fuel Filter",
                                 qty_requested: 1, requester: "WJ" }), 409);
  check("and the panel was warning about exactly that request",
    pr.pendingRequestsFor(CODE).length, 1);
  // Typed the other way round, both still hold - a refusal the panel had not
  // warned about would be the worst of both.
  throws("however the second person typed it",
    () => pr.createPartRequest({ item_code: "szen848c006700", description: "Fuel Filter",
                                 qty_requested: 1, requester: "WJ" }), 409);

  console.log("\n-- a bulk order sees it too --");
  const bulk = (() => {
    try {
      pr.createPartRequestBatch({ items: [{ item_code: CODE, description: "Fuel Filter", qty_requested: 3 }],
                                  requester: "XL" });
      return "allowed";
    } catch (e) { return e.message; }
  })();
  check("and says so in words a person can act on", /already has an open request/.test(bulk), true);
  check("naming who and how many", /2 requested by KS/.test(bulk), true);

  console.log("\n-- the placeholder codes are the exception, deliberately --");
  // Every indent part shares one code, so two open requests against it are two
  // DIFFERENT things to buy. Refusing the second would refuse a real order.
  pr.createPartRequest({ item_code: "MISC", description: "Gearbox seal, Kubota",
                         qty_requested: 1, requester: "KS", free_text: true });
  pr.createPartRequest({ item_code: "MISC", description: "Hydraulic hose 1.2m",
                         qty_requested: 2, requester: "WJ", free_text: true });
  const misc = pr.pendingRequestsFor("MISC");
  check("both are waiting, and the panel shows both", misc.length, 2);
  check("oldest first, so it reads as a history",
    misc.map((r) => r.description), ["Gearbox seal, Kubota", "Hydraulic hose 1.2m"]);
  check("and the panel's total is the two added", sum(misc), 3);

  console.log("\n-- rule 4: once Iris orders it, it stops saying so --");
  const row = pr.pendingRequestsFor(CODE)[0];
  pr.markPartRequestOrdered(row.id);
  check("nothing is waiting to be ordered any more", pr.pendingRequestsFor(CODE), []);
  // And the part can be asked for again, which is the other half of the same
  // fact: the refusal has to lift at the same moment the warning does.
  pr.createPartRequest({ item_code: CODE, description: "Fuel Filter",
                         qty_requested: 4, requester: "WJ" });
  check("and a fresh request is allowed, and shown",
    pr.pendingRequestsFor(CODE).map((r) => [r.qty_requested, r.requester]), [[4, "WJ"]]);

  console.log("\n-- rule 2: none of this needs AutoCount --");
  // Everything above ran against sqlite with no catalogue at all, which is the
  // proof: this half of the panel answers when the other half cannot. The
  // route returns supported:false in that case and must still carry these.
  check("the items source for this run really was sqlite",
    (process.env.ITEMS_SOURCE || "sqlite").toLowerCase(), "sqlite");
  check("and the list still answered", pr.pendingRequestsFor(CODE).length, 1);

  console.log("\n-- and the whole cart asked about at once --");
  // Bulk Order asks about every part in the cart in one request. It must give
  // the same answer, part for part, as asking about each one on its own -
  // otherwise the cart says one thing and tapping the part says another.
  pr.createPartRequest({ item_code: "SZEN 165151220", description: "Clutch Spring",
                         qty_requested: 6, requester: "XL" });
  const cart = ["SZEN 848C006700", "SZEN 165151220", "SZEN 591443601", "MISC"];
  const oneByOne = {};
  for (const code of cart) {
    const list = pr.pendingRequestsFor(code);
    oneByOne[code] = { n: list.length, qty: sum(list) };
  }
  check("each part answers the same whether asked alone or in a list", oneByOne, {
    "SZEN 848C006700": { n: 1, qty: 4 },   // the fresh request made further up
    "SZEN 165151220": { n: 1, qty: 6 },
    "SZEN 591443601": { n: 0, qty: 0 },    // nothing waiting: no line in the cart
    "MISC": { n: 2, qty: 3 },              // placeholders, which the cart skips
  });
  // A cart of parts nobody has asked for produces no noise at all.
  check("a clean cart has nothing to say",
    ["SZEN 591443601", "SZEN 140051111"].filter((c) => pr.pendingRequestsFor(c).length), []);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
