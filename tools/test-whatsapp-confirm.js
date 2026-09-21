// The questions asked before anything reaches a customer.
//
//   node tools/test-whatsapp-confirm.js
//
// THE TWO BUTTONS THAT TOUCH A CUSTOMER
//   Send to customer on WhatsApp - sends the message and the signed PDF, now.
//                                  Nothing else in the app reaches a customer
//                                  by itself, and WhatsApp has no unsend for a
//                                  business message.
//   Open chat                    - sends nothing, but files the slip in Drive
//                                  and makes that PDF readable by whoever
//                                  holds the link, then opens WhatsApp with
//                                  the message ready for somebody to send.
//
// Both sit low on a long slip, which is how the first one came to be tapped
// while scrolling past it.
//
// WHAT IS CHECKED
//  1. Saying no does NOTHING - no send, no Drive filing, no chat opened - and
//     leaves the button usable so it can be tried again.
//  2. Saying yes does it, once.
//  3. Each question NAMES the customer, and names the right one: the number
//     shown is the one the SERVER sends to. Those are separate expressions in
//     separate files, and if they drift the question names one number while
//     the message goes to another, which is worse than not asking.
//  4. Open chat does not claim to send. It does not, and staff who come to
//     believe it does will trust it to have delivered a slip it only drafted.
//  5. Nothing is filed to Drive before the answer. The link is the part that
//     cannot be taken back.
//  6. AUTOMATIC sending does not ask. It fires as the success card appears,
//     with a customer at the counter.
//
// AND WHY THE QUESTION IS A SHEET OF OUR OWN RATHER THAN confirm()
// A browser only opens a new tab for a few seconds after a real tap. Probed in
// Chrome while this was written: a 4-second stall still opened, 6 seconds was
// refused - the 5-second window. Open chat must file the slip in Drive before
// it can build the message, so the clock is already running during the upload;
// a confirm() in front of it would have to be read within the same budget, and
// dialog-plus-upload goes over. The tab is then refused and the button does
// nothing, silently. Tapping the sheet's own button is a fresh tap, which
// hands the upload the full window - the same budget it had before any
// confirmation existed. That is why confirmAction() exists and why this file
// checks the buttons are wired to it.
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
const indexSrc = read("frontend/index.html");

// app.js is one long browser file rather than a module, so the functions under
// test are lifted out by name and run on their own. All are declared at the top
// level, where this file's style closes them with a "}" in column one.
function lift(name) {
  let start = appSrc.indexOf("function " + name + "(");
  if (start < 0) throw new Error(`${name}() is not in frontend/app.js any more`);
  // Keep the "async" when there is one, or the lifted copy loses its awaits.
  if (appSrc.slice(start - 6, start) === "async ") start -= 6;
  const end = appSrc.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return appSrc.slice(start, end + 3);
}

// ---------------------------------------------------------------------------
// A counter, in miniature: a button, somebody to answer the question, and a
// record of everything that actually left the building.
function bench({ answer, drive = { enabled: true, configured: true }, failOn = [] }) {
  const log = { asked: [], sent: [], filed: [], opened: [], toasts: [] };
  const btn = {
    textContent: "Send to customer on WhatsApp",
    innerHTML: "Open chat",
    disabled: false,
    dataset: { wa: "6591234567" },
    classList: { add() {} },
    _click: null,
    addEventListener(_ev, fn) { this._click = fn; },
  };
  const env = {
    // Stands in for the sheet. Records the question rather than drawing it,
    // and answers it the way this bench was told to. A question with choices
    // is answered with ids, the way the real sheet answers it - everything
    // ticked on yes, nothing on no.
    confirmAction: async (q) => {
      log.asked.push(q);
      if (!q.choices) return answer;
      return answer ? q.choices.filter((c) => c.checked).map((c) => c.id) : [];
    },
    sendSlipWhatsApp: async (slip, opts) => {
      const id = Number((opts && opts.contact) || 1);
      log.sent.push({ slip: slip.slip_number, auto: !!(opts && opts.auto), contact: id });
      if (failOn.includes(id)) return { ok: false, error: `no answer from contact ${id}` };
      return { ok: true, to: id === 2 ? slip.contact2_number : (slip.whatsapp_number || slip.contact_number) };
    },
    driveStatus: async () => drive,
    driveStoreSlip: async (slip, opts) => {
      log.filed.push({ slip: slip.slip_number, shared: !!(opts && opts.share) });
      return "https://drive.example/" + slip.slip_number;
    },
    waOpeningMessage: () => "message text",
    toast: (m, k) => log.toasts.push([m, k]),
    windowOpen: (url) => log.opened.push(url),
  };

  const body =
    lift("customerContact") + "\n" +
    lift("slipContacts") + "\n" +
    lift("confirmWhatsappSend") + "\n" +
    lift("wireWhatsappButton") + "\n" +
    lift("confirmOpenChat") + "\n" +
    // window.open is the one thing that cannot be passed in as a name, so the
    // page's window is supplied instead.
    lift("openCustomerChat") + "\n" +
    "return { wireWhatsappButton, openCustomerChat };";
  const make = new Function(
    "confirmAction", "sendSlipWhatsApp", "driveStatus", "driveStoreSlip",
    "waOpeningMessage", "toast", "window", body
  );
  const api = make(env.confirmAction, env.sendSlipWhatsApp, env.driveStatus,
                   env.driveStoreSlip, env.waOpeningMessage, env.toast,
                   { open: env.windowOpen });
  return { log, btn, ...api };
}

const SLIP = {
  slip_number: "00123",
  company: "GREENSCAPE PTE LTD",
  contact_name: "Mr Tan",
  contact_number: "62734000",
  whatsapp_number: "91234567",
};

// The same slip with somebody else on it as well.
const TWO = {
  slip_number: "00125",
  company: "GREENSCAPE PTE LTD",
  contact_name: "Mr Tan",
  contact_number: "62734000",
  whatsapp_number: "91234567",
  contact2_name: "Ah Meng",
  contact2_number: "98765432",
};

const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log("\n-- the send: saying no sends nothing --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, SLIP);
    btn._click();
    await settle();
    check("it asked", log.asked.length, 1);
    check("and nothing was sent", log.sent, []);
    // The point of declining is to try again, so the button must be left
    // usable. A disabled one would mean reopening the slip.
    check("the button is still usable", btn.disabled, false);
    check("and still says what it does", btn.textContent, "Send to customer on WhatsApp");
  }

  console.log("\n-- the send: saying yes sends, once --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: true });
    wireWhatsappButton(btn, SLIP);
    btn._click();
    await settle();
    check("asked once", log.asked.length, 1);
    check("sent once, by hand", log.sent, [{ slip: "00123", auto: false, contact: 1 }]);
  }

  console.log("\n-- the send: the question names the customer --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, SLIP);
    btn._click();
    await settle();
    const q = log.asked[0] || {};
    check("the number shown is the WhatsApp one", q.to, "91234567");
    check("with who it belongs to", q.who, "Mr Tan");
    check("and which slip", q.sub, "Slip 00123");
    // Without this it reads as "sent, and you can take it back".
    check("it says it cannot be unsent", /cannot be unsent/i.test(q.detail || ""), true);
    check("and the button says what it will do", q.ok, "Send on WhatsApp");
  }

  console.log("\n-- automatic sending does not ask --");
  {
    // auto is the server setting, which fires the send as the card is drawn.
    // It must go through without a question - and it must still go.
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, SLIP, { auto: true });
    await settle();
    check("nobody was asked", log.asked, []);
    check("and it sent anyway", log.sent, [{ slip: "00123", auto: true, contact: 1 }]);
  }

  console.log("\n-- two contacts: the sheet offers both, ticked --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, TWO);
    btn._click();
    await settle();
    const q = log.asked[0] || {};
    check("it asked with a list, not one number", !!q.choices, true);
    check("both people are on it", (q.choices || []).map((c) => c.label),
      ["91234567", "98765432"]);
    check("named", (q.choices || []).map((c) => c.sub), ["Mr Tan", "Ah Meng"]);
    // John's call: somebody who wrote down a second contact meant them told.
    check("and both start ticked", (q.choices || []).map((c) => c.checked), [true, true]);
    check("saying no sends nothing at all", log.sent, []);
  }

  console.log("\n-- saying yes sends to each of them, once --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: true });
    wireWhatsappButton(btn, TWO);
    btn._click();
    await settle();
    check("two sends", log.sent, [
      { slip: "00125", auto: false, contact: 1 },
      { slip: "00125", auto: false, contact: 2 },
    ]);
    check("and the button names both", btn.textContent, "Sent to 91234567 and 98765432");
  }

  console.log("\n-- one of two fails: say which went --");
  {
    // The half that WENT is the thing somebody needs to know. "Could not send"
    // would have them try again and message the first person twice.
    const { log, btn, wireWhatsappButton } = bench({ answer: true, failOn: [2] });
    wireWhatsappButton(btn, TWO);
    btn._click();
    await settle();
    check("both were attempted", log.sent.length, 2);
    check("the button says what got through",
      /^Sent to 91234567 — retry the rest$/.test(btn.textContent), true);
    check("and it can be tried again", btn.disabled, false);
    check("the message names both halves",
      /Sent to 91234567, but no answer from contact 2/.test((log.toasts[0] || [])[0] || ""), true);
  }

  console.log("\n-- automatic sending reaches everyone, unasked --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, TWO, { auto: true });
    await settle();
    check("nobody was asked", log.asked, []);
    check("and both were sent to", log.sent.map((x) => x.contact), [1, 2]);
  }

  console.log("\n-- a second contact with no number is not a contact --");
  {
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, { ...TWO, contact2_number: "" });
    btn._click();
    await settle();
    // Back to the single-number sheet, not a list of one.
    check("it asks the plain question", !!(log.asked[0] || {}).choices, false);
    check("about the first contact", (log.asked[0] || {}).to, "91234567");
  }

  console.log("\n-- Open chat: saying no files nothing and opens nothing --");
  {
    const { log, btn, openCustomerChat } = bench({ answer: false });
    await openCustomerChat(btn, SLIP);
    check("it asked", log.asked.length, 1);
    // The link is the part that cannot be taken back, so it must not be made
    // until somebody has said yes to making it.
    check("nothing was filed to Drive", log.filed, []);
    check("and no chat was opened", log.opened, []);
  }

  console.log("\n-- Open chat: saying yes files it and opens the chat --");
  {
    const { log, btn, openCustomerChat } = bench({ answer: true });
    await openCustomerChat(btn, SLIP);
    check("filed, and shared", log.filed, [{ slip: "00123", shared: true }]);
    check("the chat opened once", log.opened.length, 1);
    check("at the customer's number",
      (log.opened[0] || "").startsWith("https://wa.me/6591234567"), true);
  }

  console.log("\n-- Open chat does not claim to send --");
  {
    const { log, btn, openCustomerChat } = bench({ answer: false });
    await openCustomerChat(btn, SLIP);
    const q = log.asked[0] || {};
    check("it says nothing is sent yet", /nothing is sent/i.test(q.detail || ""), true);
    check("and the button says open, not send", q.ok, "Open chat");
    // Drive is on in this bench, so the link it will publish has to be owned up
    // to. That sentence is the whole reason this button is worth asking about.
    check("the Drive link is spelled out", /anyone holding that link/i.test(q.detail || ""), true);
  }

  console.log("\n-- with Drive off, no link is promised --");
  {
    const { log, btn, openCustomerChat } = bench({
      answer: true, drive: { enabled: false, configured: false },
    });
    await openCustomerChat(btn, SLIP);
    // A warning about something that is not going to happen is how people
    // learn to stop reading these.
    check("no mention of a link", /link/i.test((log.asked[0] || {}).detail || ""), false);
    check("and nothing was filed", log.filed, []);
    check("but the chat still opened", log.opened.length, 1);
  }

  console.log("\n-- the number shown is the number the server sends to --");
  {
    // Read out of server.js rather than remembered. Two expressions in two
    // files that must not drift.
    // The route no longer picks a number at all - it names a contact and the
    // repository resolves it, so that a number in the request can never decide
    // where a customer's slip goes. The precedence moved with it.
    check("the route names a contact rather than a number",
      /slipContacts\(slip\)/.test(serverSrc), true);
    check("and it never reads a number out of the request",
      /req\.query\.(?:to|number)/.test(serverSrc), false);
    check("the repository prefers whatsapp_number, then contact_number",
      /slip\.whatsapp_number \|\| slip\.contact_number/.test(
        read("backend/data/sqliteRepo.js").slice(
          read("backend/data/sqliteRepo.js").indexOf("function slipContacts("))
          .slice(0, 900)), true);
    check("and so does the app, in one place",
      /slip\.whatsapp_number \|\| slip\.contact_number/.test(lift("slipContacts")), true);
    // Two copies of "who can this slip reach" - one here, one in the
    // repository, which is what actually resolves the number. They may word
    // things differently; they may not disagree about who exists.
    const repo = read("backend/data/sqliteRepo.js");
    const repoList = repo.slice(repo.indexOf("function slipContacts("));
    check("and the server keeps the same two, in the same order",
      /id: 1[\s\S]{0,400}?id: 2/.test(repoList.slice(0, 900)), true);

    // Shown rather than asserted about: a slip with only a contact number must
    // name THAT, not an empty space.
    const { log, btn, wireWhatsappButton } = bench({ answer: false });
    wireWhatsappButton(btn, { slip_number: "00124", company: "ACME", contact_number: "62734000" });
    btn._click();
    await settle();
    check("a slip with no WhatsApp number names the contact number",
      (log.asked[0] || {}).to, "62734000");
    check("and falls back to the company for who", (log.asked[0] || {}).who, "ACME");
  }

  console.log("\n-- the sheet the questions are drawn in --");
  {
    // confirmAction() is stubbed above, so the real one is checked here: the
    // ids it writes into have to exist, or every question throws at the counter.
    const src = lift("confirmAction");
    const ids = [...src.matchAll(/\$\("(ask-[a-z-]+)"\)/g)].map((m) => m[1]);
    check("it writes into at least the five parts", new Set(ids).size >= 5, true);
    const missing = [...new Set(ids)].filter((id) => !indexSrc.includes(`id="${id}"`));
    check("and every one of them is in index.html", missing, []);
    // A sheet that can be dismissed without answering leaves the caller waiting
    // for ever, holding a button it has already disabled.
    ["ask-go", "ask-no", "ask-x"].forEach((id) => {
      check(`${id} is wired to an answer`, src.includes(`$("${id}").onclick`), true);
    });
    check("escape closes it too", /Escape/.test(src), true);
  }

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
