// THE PARTS BOOKS' REPLACEMENTS, IN FIND PART. Run against a throwaway database:
//
//   node tools/test-ipl-replacements-in-find-part.js C:/temp/scratch.db
//
// John, 27 Oct 2026: a part recorded in an IPL as "We fit instead" should also
// show in Find Part, under "If out of stock, use". His answers: everywhere the
// alternatives show (the card, and the out-of-stock line in part searches,
// which reads the same alternativesWithStock), and removed only in the parts
// book - so in Find Part it is tagged "From parts book" and has no cross.
//
// Checked: the repo finds replacements by item code, for many parts at once;
// the server lists them after the alternatives set in Find Part, without an
// id, marked from_ipl, and a code that is both is listed once, as the
// alternative; one keyed to the book alone does not reach Find Part; and the
// card draws the tag and leaves the cross off.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const PORT = 8300 + ((process.pid + 7) % 300);
function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(new Error("timed out")); });
  });
}
async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { return await get("/api/version"); } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("the server never came up");
}

(async () => {
  console.log("-- recorded in the parts books --");
  // The 536LiXP's control unit, as its book says: 586265201 replacing 578370701.
  data.replacements.add({ part_key: "HUS 578370701", ipl_key: "IPL:HUS:578370701",
    item_code: "HUS 586265201", description: "CONTROL UNIT", who: "WJ" });
  // A part with an alternative set in Find Part AND the same code from a book.
  data.alternatives.add("SZEN 140051111", "M1618GC 140051111R", "CY");
  data.replacements.add({ part_key: "SZEN 140051111", item_code: "M1618GC 140051111R", description: "SHOE", who: "WJ" });
  data.replacements.add({ part_key: "SZEN 140051111", item_code: "SZEN 140051111A", description: "SHOE ASSY", who: "WJ" });
  // One recorded against a part AutoCount does not hold: keyed to the book.
  data.replacements.add({ part_key: "IPL:HUS:999999999", ipl_key: "IPL:HUS:999999999",
    item_code: "HUS 111111111", description: "X", who: "WJ" });

  check("found by item code, many at once",
    data.replacements.forCodes(["HUS 578370701", "SZEN 140051111", "NOTHING"]),
    {
      "HUS 578370701": [{ item_code: "HUS 586265201", description: "CONTROL UNIT" }],
      "SZEN 140051111": [
        { item_code: "M1618GC 140051111R", description: "SHOE" },
        { item_code: "SZEN 140051111A", description: "SHOE ASSY" },
      ],
    });
  check("nothing asked, nothing answered", data.replacements.forCodes([]), {});

  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, "..", "backend"),
    env: { ...process.env, PORT: String(PORT), OM_DB_PATH: target, HTTPS: "", ITEMS_SOURCE: "sqlite" },
    stdio: "ignore",
  });
  try {
    await waitForServer();
    console.log("\n-- what the Find Part card asks for --");
    let r = JSON.parse((await get("/api/part-alternatives/" + encodeURIComponent("HUS 578370701"))).body).results;
    check("a book's replacement alone", r.map((x) => [x.item_code, x.from_ipl, x.id, x.description]),
      [["HUS 586265201", true, null, "CONTROL UNIT"]]);

    r = JSON.parse((await get("/api/part-alternatives/" + encodeURIComponent("SZEN 140051111"))).body).results;
    check("the alternative first and once, then the book's other one",
      r.map((x) => [x.item_code, !!x.from_ipl, x.id === null]),
      [["M1618GC 140051111R", false, false], ["SZEN 140051111A", true, true]]);

    r = JSON.parse((await get("/api/part-alternatives/" + encodeURIComponent("HUS 111111111"))).body).results;
    check("the replacement does not acquire alternatives of its own", r, []);
  } finally {
    server.kill();
  }

  console.log("\n-- the card --");
  const app = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "app.js"), "utf8");
  const fn = app.slice(app.indexOf("async function renderPartAlternatives("), app.indexOf("\n}\n", app.indexOf("async function renderPartAlternatives(")));
  check("tags it From parts book", /a\.from_ipl \? ` <span class="fp-alt-ipl">From parts book<\/span>`/.test(fn), true);
  check("and gives it no cross", /can && !a\.from_ipl \?/.test(fn), true);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
