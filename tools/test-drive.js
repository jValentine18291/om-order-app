// The Drive module, against a stand-in Google.
//
//   node tools/test-drive.js
//
// Runs entirely offline: a local HTTP server answers as Google's token and
// Drive endpoints, so the signing, the multipart upload, the replace-in-place
// behaviour and the sharing call are all exercised without an account, a key,
// or a single byte leaving the machine.
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

// A throwaway key pair: the module must sign with it and Google must be able
// to verify that signature, which is the part worth proving.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPath = path.join(os.tmpdir(), "om-drive-test-key.json");
fs.writeFileSync(keyPath, JSON.stringify({
  client_email: "om-service@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
}));

const seen = { tokenRequests: 0, uploads: [], shares: [] };

const server = http.createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(body);
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.url === "/token") {
      seen.tokenRequests++;
      const assertion = new URLSearchParams(raw.toString()).get("assertion");
      const [h, c, sig] = assertion.split(".");
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(`${h}.${c}`);
      const un = (x) => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      seen.signatureValid = verifier.verify(publicKey, un(sig));
      seen.claim = JSON.parse(un(c).toString());
      return send(200, { access_token: "test-token-123", expires_in: 3600 });
    }

    if (req.url.startsWith("/upload/drive/v3/files")) {
      if (req.headers.authorization !== "Bearer test-token-123") return send(401, { error: { message: "bad token" } });
      const text = raw.toString("latin1");
      const meta = JSON.parse(text.slice(text.indexOf("{"), text.indexOf("}") + 1));
      // The id in the URL means "replace this file"; absent means "create one".
      const m = req.url.match(/files\/([^?]+)/);
      seen.uploads.push({
        method: req.method,
        replacingId: m ? decodeURIComponent(m[1]) : null,
        name: meta.name,
        parents: meta.parents || null,
        sharedDriveSupport: req.url.includes("supportsAllDrives=true"),
        pdfBytes: raw.length,
      });
      if (m && decodeURIComponent(m[1]) === "deleted-by-hand") {
        return send(404, { error: { message: "File not found: deleted-by-hand." } });
      }
      return send(200, { id: m ? decodeURIComponent(m[1]) : "new-file-id" });
    }

    if (req.url.includes("/permissions")) {
      const m = req.url.match(/files\/([^/]+)\/permissions/);
      seen.shares.push({ fileId: decodeURIComponent(m[1]), body: JSON.parse(raw.toString()) });
      return send(200, { id: "perm-1" });
    }
    send(404, { error: { message: "unexpected " + req.url } });
  });
});

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.DRIVE_ENABLED = "true";
  process.env.DRIVE_FOLDER_ID = "folder-abc";
  process.env.DRIVE_KEY_FILE = keyPath;
  process.env.DRIVE_API_BASE = base;
  process.env.DRIVE_TOKEN_URL = base + "/token";
  const drive = require(path.resolve(__dirname, "..", "backend", "drive.js"));

  try {
    check("readiness", drive.readiness(), { enabled: true, configured: true, missing: [] });

    const pdf = Buffer.from("%PDF-1.4 pretend document");

    // ---- A slip Drive has not seen before ----------------------------------
    const first = await drive.storeAndShare({
      slipNumber: "00042", company: "TAN LANDSCAPING PTE LTD", pdf, fileId: "", share: true,
    });
    check("signature verified by Google", seen.signatureValid, true);
    check("asked for the right scope", seen.claim.scope, "https://www.googleapis.com/auth/drive");
    check("created, not replaced", seen.uploads[0].method, "POST");
    check("filed in the staff folder", seen.uploads[0].parents, ["folder-abc"]);
    check("named for the slip", seen.uploads[0].name, "ServiceSlip_00042 - TAN LANDSCAPING PTE LTD.pdf");
    check("shared-drive aware", seen.uploads[0].sharedDriveSupport, true);
    check("shared with anyone holding the link", seen.shares[0].body, { role: "reader", type: "anyone" });
    check("link points at the file", first.link, "https://drive.google.com/uc?export=download&id=new-file-id");

    // ---- The same slip, edited and sent again ------------------------------
    const again = await drive.storeAndShare({
      slipNumber: "00042", company: "TAN LANDSCAPING PTE LTD", pdf, fileId: first.fileId, share: true,
    });
    check("replaced in place", seen.uploads[1].method, "PATCH");
    check("the same file", seen.uploads[1].replacingId, "new-file-id");
    check("not re-filed into the folder", seen.uploads[1].parents, null);
    check("so the customer's link still works", again.link, first.link);
    check("token reused, not re-signed", seen.tokenRequests, 1);

    // ---- Somebody deleted the file from Drive by hand ----------------------
    const recovered = await drive.storeAndShare({
      slipNumber: "00043", company: "ACME", pdf, fileId: "deleted-by-hand", share: true,
    });
    check("falls back to a fresh upload", recovered.fileId, "new-file-id");

    // ---- A name that would break a filename --------------------------------
    await drive.storeAndShare({ slipNumber: "00044", company: 'A/B:C*D?"E<F>G|H', pdf, fileId: "" });
    check("illegal filename characters stripped", seen.uploads.at(-1).name, "ServiceSlip_00044 - ABCDEFGH.pdf");

    // ---- Filed, but never sent ---------------------------------------------
    // Registration archives every slip. A slip nobody sends to a customer must
    // stay readable by staff alone, so filing must not hand out a link.
    const sharesBefore = seen.shares.length;
    const filed = await drive.storeAndShare({ slipNumber: "00045", company: "QUIET", pdf, fileId: "" });
    check("archiving still uploads", seen.uploads.at(-1).name, "ServiceSlip_00045 - QUIET.pdf");
    check("archiving shares nothing", seen.shares.length, sharesBefore);
    check("and hands out no link", filed.link, "");

    // ---- Repair Quotations, filed for staff --------------------------------
    // Their own folder, so the slips archive stays a list of slips. Filed and
    // nothing more: no link is created for one, because the customer's copy
    // goes as an attachment off the phone.
    process.env.DRIVE_QUOTATION_FOLDER_ID = "quotes-xyz";
    check("quotation filing is ready", drive.quotationReadiness(),
      { enabled: true, configured: true, missing: [] });

    const sharesBeforeQuote = seen.shares.length;
    const qid = await drive.storeQuotation({
      ref: "QT-00042", company: "TAN LANDSCAPING PTE LTD", pdf, fileId: "",
    });
    check("filed in the QUOTATION folder, not the slips one",
      seen.uploads.at(-1).parents, ["quotes-xyz"]);
    check("named for the quotation", seen.uploads.at(-1).name,
      "Quotation_QT-00042 - TAN LANDSCAPING PTE LTD.pdf");
    check("and shares nothing at all", seen.shares.length, sharesBeforeQuote);

    // A revision is a different document and becomes a file of its own, so the
    // folder shows what was quoted and what changed.
    await drive.storeQuotation({ ref: "QT-00042-2", company: "TAN LANDSCAPING PTE LTD", pdf, fileId: "" });
    check("a revision is its own file", seen.uploads.at(-1).name,
      "Quotation_QT-00042-2 - TAN LANDSCAPING PTE LTD.pdf");
    check("created, not replacing the first", seen.uploads.at(-1).method, "POST");

    // Re-sending the SAME number replaces its file rather than piling up.
    await drive.storeQuotation({ ref: "QT-00042", company: "TAN LANDSCAPING PTE LTD", pdf, fileId: qid });
    check("a re-send replaces in place", seen.uploads.at(-1).method, "PATCH");
    check("the same file", seen.uploads.at(-1).replacingId, qid);
    check("and is not re-filed into the folder", seen.uploads.at(-1).parents, null);

    // Without the folder set, quotations are not filed - and slips carry on.
    process.env.DRIVE_QUOTATION_FOLDER_ID = "";
    check("says what a quotation still needs",
      drive.quotationReadiness().missing, ["DRIVE_QUOTATION_FOLDER_ID"]);
    check("while slips are unaffected", drive.readiness().configured, true);
    let qerr = "";
    try { await drive.storeQuotation({ ref: "QT-1", company: "x", pdf, fileId: "" }); }
    catch (e) { qerr = e.message; }
    check("and refuses rather than filing it somewhere else",
      /DRIVE_QUOTATION_FOLDER_ID/.test(qerr), true);
    process.env.DRIVE_QUOTATION_FOLDER_ID = "quotes-xyz";

    // ---- Switched off ------------------------------------------------------
    process.env.DRIVE_ENABLED = "false";
    let err = "";
    try { await drive.storeAndShare({ slipNumber: "1", company: "x", pdf, fileId: "" }); }
    catch (e) { err = e.message; }
    check("refuses when switched off", /switched off/.test(err), true);

    process.env.DRIVE_ENABLED = "true";
    process.env.DRIVE_FOLDER_ID = "";
    check("says what is missing", drive.readiness().missing, ["DRIVE_FOLDER_ID"]);
  } catch (e) {
    failures++;
    console.error("\nTHREW:", e.message);
  }

  fs.unlinkSync(keyPath);
  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  // Let the server finish closing before leaving: exiting out from under it
  // makes libuv print an assertion on Windows, and a test that ends in a
  // scary-looking crash is a test nobody trusts.
  process.exitCode = failures ? 1 : 0;
  server.close();
});
