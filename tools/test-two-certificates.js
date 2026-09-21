// One server, two names, two certificates.
//
//   node tools/test-two-certificates.js
//
// WHY THIS EXISTS
// The server answers to 192.168.1.7 in the office and to a .ts.net name over
// Tailscale. A certificate names who it is for, so one certificate cannot be
// right for both - and the office is the half that must not break. Dropping a
// Tailscale certificate over cert.pem would have every device at the counter
// refuse the server it has trusted for a year, on a morning when nobody at the
// counter changed anything.
//
// So the office certificate keeps answering everything, and the Tailscale one
// is used ONLY when a client asks for a .ts.net name. This checks that, by
// standing the real server up with two certificates and asking it both ways.
//
// WHAT IS CHECKED
//  1. A .ts.net name gets the Tailscale certificate.
//  2. An IP address - which sends no name at all - gets the office one.
//  3. So does any other name, so a stray hostname cannot reach for it.
//  4. A server with NO Tailscale certificate behaves exactly as it did before
//     this existed. That is the state every OM server is in until somebody
//     sets Tailscale up, so it is the case that must not regress.
//
// It needs openssl to make two throwaway certificates. Where there is none it
// says so and skips rather than failing - a missing tool is not a broken app.
const path = require("path");
const fs = require("fs");
const os = require("os");
const tls = require("tls");
const { execFileSync, spawn } = require("child_process");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const root = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-certs-"));
const PORT = 8791;

function openssl(args) {
  execFileSync("openssl", args, { stdio: "pipe", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
}

function makeCert(name, cn, san) {
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(dir, `${name}-key.pem`),
    "-out", path.join(dir, `${name}-cert.pem`),
    "-days", "2", "-subj", `/CN=${cn}`, "-addext", `subjectAltName=${san}`]);
}

try {
  execFileSync("openssl", ["version"], { stdio: "pipe" });
} catch (_) {
  console.log("\n  --  openssl not found, so the two-certificate check is skipped.");
  console.log("      Nothing is wrong; this test needs it to make throwaway certificates.\n");
  process.exit(0);
}

makeCert("office", "192.168.1.7", "IP:127.0.0.1,IP:192.168.1.7");
makeCert("ts", "om-server.tailtest.ts.net", "DNS:om-server.tailtest.ts.net");

// No copying of the backend folder: server.js resolves express and the rest
// from its own node_modules, and a copy in a temp directory finds none of it.
// Both certificate paths are env overrides instead, so the real folder is
// never written to and no private key is left lying in it.

// Which certificate does the server hand back when asked for this name?
function certFor(servername) {
  return new Promise((resolve, reject) => {
    const opts = { host: "127.0.0.1", port: PORT, rejectUnauthorized: false };
    if (servername) opts.servername = servername;
    const sock = tls.connect(opts, () => {
      const cn = (sock.getPeerCertificate().subject || {}).CN || "";
      sock.end();
      resolve(cn);
    });
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error("timed out")); });
    sock.on("error", reject);
  });
}

function start(env) {
  const child = spawn(process.execPath, [path.join(root, "backend", "server.js")], {
    env: { ...process.env, PORT: String(PORT), ITEMS_SOURCE: "sqlite",
           OM_CERT: path.join(dir, "office-cert.pem"),
           OM_KEY: path.join(dir, "office-key.pem"),
           OM_DB_PATH: path.join(dir, `db-${Math.random().toString(36).slice(2)}.db`), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      if (/running \(HTTPS\)/.test(out)) setTimeout(() => resolve({ child, out: () => out }), 300);
    });
  });
}

const stop = (s) => new Promise((r) => { s.child.on("exit", r); s.child.kill(); });

(async () => {
  console.log("\n-- both certificates present --");
  let srv = await start({
    OM_TS_CERT: path.join(dir, "ts-cert.pem"),
    OM_TS_KEY: path.join(dir, "ts-key.pem"),
  });
  check("it said it loaded the second one", /Tailscale certificate loaded/.test(srv.out()), true);
  check("a .ts.net name gets the Tailscale certificate",
    await certFor("om-server.tailtest.ts.net"), "om-server.tailtest.ts.net");
  // An IP address sends no name at all. This is the counter iPad.
  check("an address with no name gets the office one", await certFor(null), "192.168.1.7");
  // Nothing else may reach for it, whatever it calls itself.
  check("and so does any other name", await certFor("something.else.local"), "192.168.1.7");
  await stop(srv);

  console.log("\n-- no Tailscale certificate, which is every server until one is set up --");
  fs.unlinkSync(path.join(dir, "ts-cert.pem"));
  srv = await start({
    OM_TS_CERT: path.join(dir, "ts-cert.pem"),
    OM_TS_KEY: path.join(dir, "ts-key.pem"),
  });
  check("it does not claim to have one", /Tailscale certificate loaded/.test(srv.out()), false);
  check("nothing is broken by its absence",
    await certFor("om-server.tailtest.ts.net"), "192.168.1.7");
  check("and the office is served exactly as before", await certFor(null), "192.168.1.7");
  await stop(srv);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\n FAIL  the check could not run:", e.message, "\n");
  process.exit(1);
});
