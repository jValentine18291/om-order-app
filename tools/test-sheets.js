// The location log sheet, against a stand-in Google.
//
//   node tools/test-sheets.js
//
// Runs entirely offline: a local HTTP server answers as Google's token and
// Sheets endpoints, so the signing, the scope asked for, the header-row
// behaviour and the shape of an appended row are all exercised without an
// account, a key, or a single byte leaving the machine.
//
// The rule this guards hardest: an existing first row is NEVER overwritten. It
// might be a header somebody styled, or a row of real data, and destroying it
// would ruin the very thing the sheet exists to keep.
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPath = path.join(os.tmpdir(), "om-sheets-test-key.json");
fs.writeFileSync(keyPath, JSON.stringify({
  client_email: "om-service@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
}));

// The stand-in sheet: whatever the module has written into it so far.
let sheetRows = [];
const seen = { tokenRequests: 0, headerWrites: 0, appends: [], reads: 0 };

const server = http.createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(body).toString();
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.url === "/token") {
      seen.tokenRequests++;
      const assertion = new URLSearchParams(raw).get("assertion");
      const [h, c, sig] = assertion.split(".");
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(`${h}.${c}`);
      const un = (x) => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      seen.signatureValid = verifier.verify(publicKey, un(sig));
      seen.claim = JSON.parse(un(c).toString());
      return send(200, { access_token: "test-token-123", expires_in: 3600 });
    }

    if (req.headers.authorization !== "Bearer test-token-123") {
      return send(401, { error: { message: "bad token" } });
    }

    // Reading A1:J1 to see whether a header is already there.
    if (req.method === "GET" && /\/values\//.test(req.url)) {
      seen.reads++;
      return send(200, sheetRows.length ? { values: [sheetRows[0]] } : {});
    }
    // Writing the header row.
    if (req.method === "PUT" && /\/values\//.test(req.url)) {
      seen.headerWrites++;
      sheetRows[0] = JSON.parse(raw).values[0];
      return send(200, { updatedCells: sheetRows[0].length });
    }
    // Appending a row.
    if (req.method === "POST" && /:append/.test(req.url)) {
      const row = JSON.parse(raw).values[0];
      seen.appends.push({ row, raw: req.url.includes("valueInputOption=RAW"),
                          insertRows: req.url.includes("insertDataOption=INSERT_ROWS") });
      sheetRows.push(row);
      return send(200, { updates: { updatedRows: 1 } });
    }
    send(404, { error: { message: "unexpected " + req.method + " " + req.url } });
  });
});

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.SHEETS_ENABLED = "true";
  process.env.LOCATION_SHEET_ID = "sheet-abc";
  process.env.DRIVE_KEY_FILE = keyPath;
  process.env.SHEETS_API_BASE = base;
  process.env.DRIVE_TOKEN_URL = base + "/token";
  const sheets = require(path.resolve(__dirname, "..", "backend", "sheets.js"));

  try {
    console.log("\n-- set-up --");
    check("readiness", sheets.readiness(), { enabled: true, configured: true, missing: [] });
    check("the address to share the sheet with", sheets.serviceAccountEmail(),
      "om-service@example.iam.gserviceaccount.com");

    console.log("\n-- the first change writes the header --");
    const at = new Date(2026, 8, 4, 15, 7, 3);   // 4 Sep 2026, 15:07:03 local
    await sheets.appendLocationChange({
      itemCode: "SZEN 848BE058B2", description: "GASKET, CYLINDER",
      oldShelf: "R4E1", newShelf: "R7B2",
      who: "I", role: "purchaser", outcome: "updated in AutoCount", source: "Find Part", at,
    });
    check("header written once", seen.headerWrites, 1);
    check("the columns", sheetRows[0], sheets.LOCATION_COLUMNS);
    check("the row", seen.appends[0].row, [
      "2026-09-04", "15:07:03", "SZEN 848BE058B2", "GASKET, CYLINDER",
      "R4E1", "R7B2", "I", "purchaser", "updated in AutoCount", "Find Part",
    ]);
    check("sent as RAW so nothing is reinterpreted", seen.appends[0].raw, true);
    check("and as an insert, not an overwrite", seen.appends[0].insertRows, true);

    console.log("\n-- the signature and the scope --");
    check("Google could verify the signature", seen.signatureValid, true);
    check("asked for the Sheets scope, not Drive's", seen.claim.scope,
      "https://www.googleapis.com/auth/spreadsheets");

    console.log("\n-- an existing first row is never overwritten --");
    const before = sheetRows[0];
    await sheets.appendLocationChange({
      itemCode: "SHUQ 5372641-01", description: "SPARK PLUG",
      oldShelf: null, newShelf: "A1",
      who: "KS", role: "admin", outcome: "updated in AutoCount", source: "IPL", at,
    });
    check("still written only that once", seen.headerWrites, 1);
    check("row one untouched", sheetRows[0], before);
    // A part that had no location says so rather than leaving a blank cell,
    // which could as easily mean "nobody filled this in".
    check("no previous location reads as (none)", seen.appends[1].row[4], "(none)");

    console.log("\n-- a refused attempt is recorded too --");
    // The point of an audit sheet is the attempts as much as the successes.
    await sheets.appendLocationChange({
      itemCode: "SZEN 848BE058B2", description: "GASKET, CYLINDER",
      oldShelf: "R7B2", newShelf: "ZZZ",
      who: "WJ", role: "tech", outcome: "REFUSED - not a purchaser or admin", source: "Find Part", at,
    });
    check("the outcome column carries it", seen.appends[2].row[8], "REFUSED - not a purchaser or admin");

    console.log("\n-- one token for all of it --");
    check("signed once, reused", seen.tokenRequests, 1);

    console.log("\n-- switched off, and half set up --");
    process.env.SHEETS_ENABLED = "false";
    check("off means skipped, not thrown",
      await sheets.appendLocationChange({ itemCode: "X", newShelf: "Y" }),
      { skipped: "SHEETS_ENABLED is not true" });
    process.env.SHEETS_ENABLED = "true";
    process.env.LOCATION_SHEET_ID = "";
    check("no sheet id means skipped, and says which",
      await sheets.appendLocationChange({ itemCode: "X", newShelf: "Y" }),
      { skipped: "not configured: LOCATION_SHEET_ID" });
  } catch (e) {
    failures++;
    console.error("\nTHREW:", e);
  }

  fs.unlinkSync(keyPath);
  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  // Let the server finish closing before leaving: exiting out from under it
  // makes libuv print an assertion on Windows, and a test that ends in a
  // scary-looking crash is a test nobody trusts. Same as test-drive.js.
  process.exitCode = failures ? 1 : 0;
  server.close();
});
