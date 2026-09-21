# Sending the Service Slip to the customer on WhatsApp

**Working, since 21 September 2026.** A slip was sent from the app and arrived
on a phone, with the PDF attached. The settings are in the service, the
template is approved, and the server reports itself ready:

    GET https://192.168.1.7:8443/api/whatsapp/status
    {"enabled":true,"configured":true,"auto_send":false}

That is the one command worth knowing on this side. It answers "why is the
button missing?" without guessing: `enabled` is `WHATSAPP_ENABLED`,
`configured` means the phone number id and token are both set, and the button
only appears when both are true. `auto_send` is deliberately false — see
"Manual, or automatic".

Ready was not the same as working, though, and for four days it was not. The
first send was accepted by Meta, given a genuine message id, and never
delivered, because the Meta app was unpublished. That is worth reading before
touching any of this: see "The send that says SENT and never arrives" below.

## How it works

When a slip is registered, the success card offers **Send to customer on
WhatsApp**. The app builds the slip PDF in the browser — the same code that
produces the copy staff look at — and posts it to this server, which uploads it
to Meta and sends it attached to an approved message template.

The PDF is deliberately **not** rebuilt on the server. Two generators would
drift apart, and the customer would eventually receive something subtly
different from the document that was signed.

**View Slips** has the same button, so a send that failed can be retried. It
never sends automatically there — opening an old slip to look at it must not
re-send it to the customer.

## Manual, or automatic

Two switches, both **off** unless set to `true`:

- `WHATSAPP_ENABLED` — allows sending at all. With this off the button never
  appears and the server refuses the request even if one is sent.
- `WHATSAPP_AUTO_SEND` — sends the moment a slip is registered, no button
  press.

**Start with automatic off.** A mistyped number on auto-send puts a customer's
signed slip in a stranger's hands instantly, and WhatsApp can only unsend for a
short window. The button is one extra tap and lets staff see the number first.
Turning it on later is one line here — no app deploy.

## The other settings

    WHATSAPP_PHONE_NUMBER_ID   1232499416620504
    WHATSAPP_TOKEN             permanent System User token — never logged
    WHATSAPP_TEMPLATE          approved template name
    WHATSAPP_TEMPLATE_LANG     its language code (default "en")

These live in the OMService service configuration alongside the AutoCount
credentials. Set them from an **Administrator** Command Prompt on the server:

    C:\nssm\nssm.exe edit OMService

NSSM is not on the PATH, so the full path is the command — typing `nssm` alone
answers "not recognized", which has now cost two people ten minutes. The
Environment tab holds every setting; **add** a line and leave the rest alone.

Never `nssm set ... AppEnvironmentExtra`: it replaces the whole list and would
wipe the AutoCount login along with everything else.

## Phone numbers

Staff type these by hand, so the app accepts `9123 4567`, `+65 9123 4567`,
`6591234567` and `65-9123-4567`, and adds `65` to a bare 8-digit mobile.

It **refuses** anything it cannot read confidently rather than guessing — an 8
digit number that does not start 8 or 9 is rejected with a message asking for
the country code, because a wrong number here sends a signed slip to a stranger.

### The number OM sends FROM

The office landline, **+65 6743 4039** (John, 16 Sep 2026). It is not
registered on the WhatsApp app, which it must not be — a number on the Business
Platform cannot also be a WhatsApp or WhatsApp Business app account, and one
already registered has to be deleted from WhatsApp first.

A landline is allowed. Verification is by **voice call** rather than SMS: Meta
rings the number and reads the code aloud, so somebody has to be at the phone
when we do it. Registering it does not affect the telephony — 6743 4039 goes on
ringing as an ordinary office line.

Added and voice-verified 16 Sep 2026. Meta's own identifiers for it:

    WhatsApp Business account ID   29180188664920249
    Phone Number ID                1232499416620504

The Phone Number ID is the one the app needs; it is an address, not a secret,
and is useless to anyone without the token.

### The 6-digit PIN

Registering the number sets a **two-step verification PIN**. It is not in this
file and must not be: it is the credential that stops somebody else moving
6743 4039 onto their own WhatsApp account.

It is needed again to RE-register the number — after a migration, a reset, or
if the number is ever removed and added back — and Meta will not show it again
or reset it on request. Keep it wherever the AutoCount password is kept, not in
the repository and not in a chat message.

### The WhatsApp Business profile

What customers see next to the message:

    Display name   Outboard and Marine Pte Ltd
    Category       Professional Services
    Time zone      (GMT+08:00) Asia/Singapore
    Address        9 Kaki Bukit Road 1, #01-03, Eunos Technolink, S 415938
    Email          sales@omprotools.com.sg
    Website        https://gardenequipment.com.sg

Everything below the time zone was added 21 Sep 2026, after the first real
message went out looking anonymous. Set in WhatsApp Manager → Phone numbers →
the number → **Profile**.

#### The profile picture, and the circle

The logo is `logo-obm-leaf.png` in the husqvarna-presentation assets folder -
a green ring with the leaf inside it, drawn to the edges of its square.

**WhatsApp shows profile pictures as circles**, and a circle inscribed in that
square lands exactly on the ring and shaves it. So the file to upload is not
the logo: it is the logo scaled to about 78% on a white square, which leaves
the ring whole with room to spare. `OM-whatsapp-profile.png`, 1000x1000, built
that way and checked against a simulated circular crop before uploading.

Uploading it has to be done by hand. Meta builds the file input in JavaScript
when the button is clicked, so it never exists in the page for automation to
reach, and the dialog that opens is Windows', not the browser's.

**"and", not "&".** Meta rejected `Outboard & Marine Pte Ltd` outright — *"Your
display name violates WhatsApp guidelines"*, against the rule "don't add
unnecessary punctuation, emojis or symbols". Spelling it out passed on the
first try, and it is closer to the ACRA name Meta verified us under, OUTBOARD
AND MARINE (PTE.) LIMITED. Do not try to put the ampersand back later: a
display name change goes through review and would fail the same rule.

Business description was left empty. It is optional and editable any time in
Meta Business Suite → Business assets, so it need not hold up the number.

## The log

Every attempt, including the failures:

    backend/whatsapp-sends.log

    2026-08-25 10:01:35 | Slip 00001 | 6591234567 | SENT | wamid.TEST1 | JT (sales)
    2026-08-25 10:02:13 | Slip 00002 | - | FAILED | (#131047) Message failed... | JT (sales)

This answers the question staff will actually ask: *did the customer get it?*
WhatsApp rejects messages for reasons invisible from inside the app — template
withdrawn, no payment method, number not on WhatsApp — and the real reason from
Meta is recorded verbatim. Excluded from GitHub: it holds customer phone
numbers. It is copied by `backup-db.bat` along with the database.

## The template, word for word

Submit it EXACTLY as below. A template cannot be edited once approved — any
change means submitting again and waiting out another review — so the footer
and the button belong in the first submission, not a later one.

**Name** `service_slip_confirmation` · **Category** Utility · **Language**
English (`en`)

**Header:** Document. The slip PDF, passed at send time as a media id.

**Body:**

    Dear {{1}},

    We have received your equipment for servicing.

    Service Slip No.: {{2}}
    Date Received: {{3}}
    No. of Equipment: {{4}}

    Your signed service slip is attached for your reference.

**Footer:** `Automated message. Replies are not monitored.`

**Button:** Call phone number — label `Call us`, number `+65 6743 4039`.

### Why the footer and the button, and not a setting

There is no no-reply mode in WhatsApp. The customer always gets a text box,
and this app only sends: `whatsapp.js` has `sendSlip` and `uploadPdf` and
there is no webhook anywhere in the backend, so a reply reaches Meta and is
dropped with nobody at OM ever seeing it. John's decision (16 Sep 2026) is
that this is how it should work - questions go to the office by phone - so the
message has to SAY so, and give a one-tap way to do it.

Neither addition touches the code. `sendSlip` transmits two components, header
and body; a footer carries no parameter, and a Call button only needs one when
the number is dynamic. Ours is fixed, so the payload is unchanged.

## What Meta required

Kept as a list rather than deleted: if sending ever stops, it is far more
likely to be one of these four lapsing than a change in the code.

1. ~~**Business verification**~~ — **done** 16 Sep 2026. Domain
   `gardenequipment.com.sg` verified the same day by DNS TXT record.
2. ~~**An approved template**~~ — **approved 17 Sep 2026**, submitted the day
   before. WhatsApp Manager shows it **Active – Quality pending**, which is
   the approved state; the quality rating stays "pending" until messages have
   actually been sent. Utility category, with a **Document** header.
   Name `service_slip_confirmation`, language **English** (`en`), and **four**
   body variables in this exact order:

       {{1}} customer name        e.g. Mr Tan
       {{2}} slip number          e.g. 00123
       {{3}} date received        e.g. 25 Aug 2026
       {{4}} number of machines   e.g. 3

   The order is fixed by the approved template - changing it in Meta without
   changing `whatsapp.js` would put the slip number where the name goes.

   The date is the date the slip was REGISTERED, not today, so re-sending an
   older slip from View Slips still reads correctly. {{4}} is a COUNT, not a
   list - the template reads "No. of Equipment: {{4}}", and the machines are
   itemised on the attached slip anyway.
3. ~~**A payment method on the WhatsApp account**~~ — **done** 16 Sep 2026.
   Business-initiated messages (this is one) will not send without one, and
   the failure is a send error rather than anything visible in the app, so
   this is the first thing to check if sends start failing for everyone at
   once.
4. ~~**A phone number**~~ — **done** 16 Sep 2026, +65 6743 4039 Connected.
5. ~~**The app has to be PUBLISHED**~~ — **done 21 Sep 2026**, and it was the
   reason the first test send never arrived. Publishing needed a **privacy
   policy URL**, which needed a privacy policy: the site had none, and its
   footer linked to a `/privacy-policy/` that returned 404. The page now
   exists and is set in App settings → Basic. See below.

## The send that says SENT and never arrives

17 Sep 2026, the first real send. The app reported success, and the log agreed:

    2026-09-17 17:01:21 | Slip 00068 | 6593371539 | SENT | wamid.HBgKNjU5MzM3MTUzORUCABEYEjg4QkQ2QUMwQkIwODBDQkZDOQA= | John (admin)

Nothing arrived on the phone.

**The cause is that the Meta app is unpublished.** "OM Service Slips", app id
1641703167381415, sits in Development mode, and the Publish page in the app
dashboard says it plainly:

> No production data, including from app admins, developers or testers, will
> be delivered unless the app has been published.

So the Graph API accepts the message, allocates a real message id, and then
drops it. There is no error anywhere, because from the API's point of view
nothing went wrong.

### Ruling things out, in the order they were checked

Worth keeping, because every one of these looks plausible from the app side
and none of them was the problem:

- **The missing `+`.** The log shows `6593371539` with no plus, which looks
  wrong and is not. Meta's API wants the country code and no plus - their own
  examples read `16505551234`. Our code is right.
- **The wrong phone number.** `WHATSAPP_PHONE_NUMBER_ID` is 1232499416620504,
  which WhatsApp Manager confirms is +65 6743 4039, Connected. Not the test
  number: that one is +1 555 204-2573, id 1364565713396880, and it lives on a
  separate "Test WhatsApp Business Account" (1072019868648567) that we do not
  use for anything.
- **Billing.** The real account has a Visa on file and a S$0.00 balance. The
  Test account has no payment method, which does not matter.
- **The template.** Approved, and the send would have failed loudly otherwise.
- **`WHATSAPP_GRAPH_BASE` still pointing at the stand-in API.** This one was
  the leading theory and was wrong: the variable is not set on the server.

### How to tell those two apart next time

The message id in the log settles it in one glance, without asking anyone to
paste a token:

    wamid.TEST1                         the stand-in. Nothing was really sent.
    wamid.HBgKNjU5MzM3MTUzORUCABEY...   real Meta.

A real one is base64 and decodes to something readable:

    b'\x1c\x18\n6593371539\x15\x02\x00\x11\x18\x1288BD6AC0BB080CBFC9\x00'

The recipient's number is in there in plain digits, which also proves the
message was addressed correctly. A wamid is an identifier, not a credential -
it is safe to paste into a chat or an email. The token never is.

### It was the app. Publishing fixed it.

Published 21 Sep 2026; the same slip was sent again from the app and arrived,
PDF and all. Nothing in our code changed between the send that vanished and
the send that worked - the only difference was the app going Live.

So when a send is accepted and never arrives, and nothing in the log looks
wrong, **check the app's mode first**. It is the one cause that leaves no
trace anywhere on our side.

### What publishing needed

The Publish page lists one unmet requirement and greys the button out until it
is met: a **Privacy policy URL** in App settings.

The website does not currently have one. Its footer links to
`/privacy-policy/`, which returns **404** - a broken link on the live site,
independently of WhatsApp. `/terms-and-conditions/` and `/terms/` both work.
So a privacy policy page has to exist before the app can be published, and
pointing Meta at the terms page instead would be answering a different
question than the one it asked.

### Why no webhook made this expensive

None of the above was visible from inside the app. Meta reports delivery
failures through webhooks, and there is no webhook here - `whatsapp.js` only
sends. The log can therefore say SENT and mean "Meta accepted it", which is
not the same as "the customer has it", and on 17 Sep those two came apart for
the first time.

Worth fixing eventually, and not cheaply: a webhook needs a public HTTPS
endpoint, and this server is on the LAN at 192.168.1.7. Until then, SENT in
the log means accepted, no more than that.

### Submitting the template: two things that will bite again

**Never type `}}`.** The body editor auto-expands `{{` into a complete,
auto-numbered `{{1}}` and leaves the cursor after it. Typing the full `{{1}}`
gives `{{1}}1}}`, which looks close enough to miss on screen — it was caught by
reading the textarea value, not by looking. Type `Dear {{` and the editor
writes `Dear {{1}}` for you; the numbering follows the order you type them in.

**The sample document is fake on purpose.** Meta keeps the uploaded sample and
shows it to human reviewers, so a real signed slip would hand a customer's
name, phone number and signature to a third party for no benefit; Meta's own
warning on that page says not to include customer information. The generator is
`tools/make-sample-slip-pdf.py` — raw PDF, no dependencies — and the variable
samples (Mr Tan / 00123 / 16 Sep 2026 / 2) deliberately match what the sample
PDF says, so a reviewer sees one consistent story.

**Known Meta problem 2, the Register button (16 Sep 2026).** +65 6743 4039 was
added and voice-verified without trouble, but **Register** in Step 2 fails every
time with a red "Registration failed. Please try again." The console's own
message is worthless; the GraphQL reply underneath is not:

    mutation  register_devx_phone_number -> null
    message   "A server error field_exception occured. Check server logs..."
    severity  CRITICAL      api_error_code  -1
    is_transient  false     allow_user_retry  false
    fbtrace_id  BN+7IS56ibR  mid  a0ce9c12eae410e6f3cec58b3819bfd2

Read that before blaming the PIN, as we did twice. `api_error_code: -1` with
"check server logs" is an exception thrown inside Meta's resolver, not a
rejection of anything we sent, and **`allow_user_retry: false` means clicking
Register again cannot work** — the two of us wasted attempts learning that.

Ruled out at the time, each by looking rather than assuming: two-step
verification was off and unset (so no stale PIN), the display name carried no
review flag, and the number sat at status Pending, which is the normal
"verified, awaiting registration" state. A page reload to clear an unrelated
React crash (#185) changed nothing.

The suspected cause is the same binding fault as below: the orphaned **Test**
WhatsApp Business Account (ID 1072019868648567) is still in the portfolio, and
a resolver that finds the WABA from the app binding would reach the test
account rather than 29180188664920249 and throw exactly this.

**What worked**, same day: the documented Graph API call, which does not go
through the console's wrapper at all. Run from any machine with internet — it
touches Meta only, not the server, the database or AutoCount:

    $t = Read-Host 'Token'; $p = Read-Host 'PIN'; try { Invoke-RestMethod -Method Post `
      -Uri 'https://graph.facebook.com/v21.0/1232499416620504/register' `
      -Body @{ messaging_product='whatsapp'; pin=$p; access_token=$t } | ConvertTo-Json } `
      catch { $rd = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $rd.ReadToEnd() }

`Read-Host` rather than literals so neither secret lands in PowerShell history,
and the `catch` because `Invoke-RestMethod` throws away the response body on a
400 — which is where Meta puts the only useful part. It answered
`{"success": true}` first time, and the number went Pending -> **Connected** in
WhatsApp Manager.

Unlike the console this returns real error codes: 133005 wrong PIN, 133006 not
verified, 133008 too many attempts, 200/10 token permissions too narrow.

### The system user

    name         Outboard Marine      (not a typo - see below)
    id           61594060756802
    role         Employee             deliberately not Admin
    assets       OM Service Slips app           -> Develop app
                 Outboard and Marine Pte Ltd    -> Message templates (view and
                 manage), Phone numbers (view and manage), Messages
    scopes       whatsapp_business_messaging, whatsapp_business_management
    expiry       Never

"Phone numbers (view and manage)" is the one that carries *registrations*, so
it is not optional however tempting the shorter list looks. Expiry is **Never**
on purpose: a 60-day token would stop customer messages dead every two months
on an unattended server, with nothing in the app to explain why.

**Naming a system user is not free text.** Meta validates it against the
PERSONAL profile name policy, and says only "You chose an invalid system user
name." Rejected here: `OM Service Sender`, `OMServiceSender` ("Profile names
can't have too many capital letters"), `om service sender` ("Name not allowed"
- role words). `Outboard Marine` passed. Pick something that reads like a
person's name, mostly lower case, with no words like service, sender, bot or
admin in it.

**Known Meta problem, unresolved:** claiming a test number creates a WhatsApp
Business Account under the portfolio but never binds it to the app, so the app
reports "No phone numbers available for this app". Deleting the orphaned
account let a new one be created but did not fix the binding. This blocks the
*test* number only; a real number is added through **Step 2. Production setup**,
which binds from the app side. Escalate via **Contact support** in the account's
`...` menu if it recurs with the real number.

## Failure never breaks the slip

A failed send is reported and logged; the slip itself is already saved and is
the important part. The button returns to its normal state so it can be tried
again, and is never marked as sent when it was not.
