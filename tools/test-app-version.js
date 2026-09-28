// The server tells every phone which app it is holding.
// Run against a throwaway database, never the real one:
//
//   node tools/test-app-version.js C:/temp/scratch.db
//
// WHAT THIS IS GUARDING. A phone finds out it is behind by comparing the
// X-App-Version header on an /api reply with the version its own service
// worker is serving. The header is read out of frontend/sw.js at boot, by a
// regular expression - so a reformatted sw.js, a single quote instead of a
// double one, or a renamed constant would leave the header empty, every phone
// would quietly go back to waiting for the browser to notice a new worker, and
// nothing anywhere would say so. That is the failure this exists to catch.
//
// It starts a real server on a spare port and asks it, rather than re-reading
// the file and agreeing with itself.
const path = require("path");
const fs = require("fs");
const http = require("http");
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

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}` + (ok ? "" : `\n        got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
}

// The one place a deploy is stamped.
const swText = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "sw.js"), "utf8");
const swVersion = (swText.match(/const\s+CACHE\s*=\s*"([^"]+)"/) || [])[1] || "";

const PORT = 8300 + (process.pid % 300);

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(new Error("timed out")); });
  });
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { return await get("/api/version"); } catch (_) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("the server never came up");
}

(async () => {
  console.log("-- the version is stamped in one place --");
  check("sw.js carries a version", /^om-order-v\d+$/.test(swVersion), true);

  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, "..", "backend"),
    env: { ...process.env, PORT: String(PORT), OM_DB_PATH: target, HTTPS: "" },
    stdio: "ignore",
  });

  try {
    await waitForServer();

    console.log("\n-- and the server hands it to every phone that asks --");
    const v = await get("/api/version");
    check("/api/version answers", v.status, 200);
    check("  with the version out of sw.js", JSON.parse(v.body).version, swVersion);
    check("  and never from a cache", v.headers["cache-control"], "no-store");

    console.log("\n-- on the header of an ordinary reply, which is the point --");
    // No extra request per phone per few minutes: the answer rides on a reply
    // the app already wanted.
    const users = await get("/api/auth/users");
    check("an ordinary route carries the header", users.headers["x-app-version"], swVersion);
    check("  and says the header may be read", users.headers["access-control-expose-headers"], "X-App-Version");

    console.log("\n-- including the replies nobody wanted --");
    // A phone being refused is still a phone that may be a week behind.
    const missing = await get("/api/slips/NOPE-NOT-A-SLIP");
    check("a 404 carries it too", missing.headers["x-app-version"], swVersion);
  } finally {
    server.kill();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nAll good.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nBlew up: " + e.message);
  process.exit(1);
});
