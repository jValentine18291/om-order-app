// The question asked before a slip goes to a customer on WhatsApp.
//
//   node tools/test-whatsapp-confirm.js
//
// WHY THIS IS WORTH A TEST OF ITS OWN
// This is the only button in the app that reaches a customer by itself. Share
// PDF hands the file to the share sheet and Open chat writes a draft, and in
// both of those somebody still picks the recipient and presses send inside
// another app - that step is the check. This one has none, and WhatsApp has no
// unsend for a business message. The button also sits low on a long slip,
// which is how it came to be tapped while scrolling past it.
//
// A confirm() is one line, and one line is exactly the kind of thing that gets
// removed while tidying, or lost when the send is wired up somewhere new. What
// it guards cannot be undone, so it is worth a test rather than a comment.
//
// WHAT IS CHECKED
//  1. Saying no sends NOTHING, and leaves the button as it was to try again.
//  2. Saying yes sends, once.
//  3. The question NAMES the slip and the number. "Are you sure?" gets a yes
//     without being read; a number has to be looked at, and a wrong number is
//     the mistake that actually costs something.
//  4. The number in the question is the number the SERVER will send to. These
//     are two separate expressions in two files, and if they ever disagree the
//     confirmation becomes a lie - it would show the contact number while the
//     message went to the WhatsApp one.
//  5. AUTOMATIC sending does not ask. It fires as the success card appears,
//     with a customer at the counter; a question there would be answered by
//     whoever was holding the phone, or not at all.
const path = require("path");
const fs = require("fs");

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const appSrc = read("frontend/app.js");
const serverSrc = read("backend/server.js");

// app.js is one long browser file rather than a module, so the two functions
// are lifted out of it by name and run on their own. Both are declared at the
// top level, where this file's style closes them with a "}" in column one.
function lift(name) {
  const start = appSrc.indexOf("function " + name + "(");
  if (start < 0) throw new Error(`${name}() is not in frontend/app.js any more`);
  const end = appSrc.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return appSrc.slice(start, end + 3);
}

// ---------------------------------------------------------------------------
// A counter, in miniature: a button, somebody to answer the question, and a
// record of what actually went out.
function bench({ answer }) {
  const log = { asked: [], sent: [], toasts: [] };
  const btn = {
    textContent: "Send to customer on WhatsApp",
    disabled: false,
    classList: { add() {} },
    _click: null,
    addEventListener(_ev, fn) { this._click = fn; },
  };
  const sandbox = {
    confirm: (msg) => { log.asked.push(msg); return answer; },
    // Stands in for the real send. If this runs, the customer got it.
    sendSlipWhatsApp: async (slip, opts) => {
      log.sent.push({ slip: slip.slip_number, auto: !!(opts && opts.auto) });
      return { ok: true, to: slip.whatsapp_number || slip.contact_number };
    },
    toast: (m, k) => log.toasts.push([m, k]),
  };
  const make = new Function(
    "confirm", "sendSlipWhatsApp", "toast",
    lift("confirmWhatsappSend") + "\n" + lift("wireWhatsappButton") +
    "\nreturn wireWhatsappButton;"
  );
  return { log, btn, wire: make(sandbox.confirm, sandbox.sendSlipWhatsApp, sandbox.toast) };
}

const SLIP = {
  slip_number: "00123",
  company: "GREENSCAPE PTE LTD",
  contact_name: "Mr Tan",
  contact_number: "62734000",
  whatsapp_number: "91234567",
};

const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log("\n-- saying no sends nothing --");
  {
    const { log, btn, wire } = bench({ answer: false });
    wire(btn, SLIP);
    btn._click();
    await tick();
    check("it asked", log.asked.length, 1);
    check("and nothing was sent", log.sent, []);
    // The whole point of declining is to try again, so the button has to be
    // left usable. A disabled button here would mean reopening the slip.
    check("the button is still usable", btn.disabled, false);
    check("and still says what it does", btn.textContent, "Send to customer on WhatsApp");
  }

  console.log("\n-- saying yes sends, once --");
  {
    const { log, btn, wire } = bench({ answer: true });
    wire(btn, SLIP);
    btn._click();
    await tick();
    check("asked once", log.asked.length, 1);
    check("sent once, by hand", log.sent, [{ slip: "00123", auto: false }]);
  }

  console.log("\n-- the question names the slip and the number --");
  {
    const { log, btn, wire } = bench({ answer: false });
    wire(btn, SLIP);
    btn._click();
    await tick();
    const q = log.asked[0] || "";
    check("the slip number is in it", q.includes("00123"), true);
    check("the WhatsApp number is in it", q.includes("91234567"), true);
    check("and who it is going to", q.includes("Mr Tan"), true);
    // Without this it reads as "sent, and you can take it back".
    check("it says it cannot be unsent", /cannot be unsent/i.test(q), true);
  }

  console.log("\n-- the number shown is the number the server sends to --");
  {
    // The server's own choice, read out of server.js rather than remembered.
    // Two expressions in two files that must not drift: if the server ever
    // preferred the contact number, the confirmation would name one number
    // while the message went to another - worse than not asking at all.
    const serverPicks = /const to = slip\.whatsapp_number \|\| slip\.contact_number/.test(serverSrc);
    check("the server prefers whatsapp_number, then contact_number", serverPicks, true);
    const appPicks = /slip\.whatsapp_number \|\| slip\.contact_number/
      .test(lift("confirmWhatsappSend"));
    check("and so does the question", appPicks, true);

    // Shown rather than asserted about: a slip with only a contact number must
    // name THAT, not an empty space.
    const { log, btn, wire } = bench({ answer: false });
    wire(btn, { slip_number: "00124", company: "ACME", contact_number: "62734000" });
    btn._click();
    await tick();
    check("a slip with no WhatsApp number names the contact number",
      (log.asked[0] || "").includes("62734000"), true);
  }

  console.log("\n-- automatic sending does not ask --");
  {
    // auto: true is the server setting, which fires the send as the card is
    // drawn. It must go through without a question - and it must still go.
    const { log, btn, wire } = bench({ answer: false });
    wire(btn, SLIP, { auto: true });
    await tick();
    check("nobody was asked", log.asked, []);
    check("and it sent anyway", log.sent, [{ slip: "00123", auto: true }]);
  }

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
