# Sending the Service Slip to the customer on WhatsApp

Built and tested against a stand-in Meta API. **It is switched off**, and it
cannot send until the Meta side is finished — see "What is still missing".

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

    WHATSAPP_PHONE_NUMBER_ID   from the WhatsApp API Setup page
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

## What is still missing (all on Meta's side)

1. **Business verification** — submitted 16 Sep 2026 and **In review**; Meta
   said about two working days. Domain `gardenequipment.com.sg` verified the
   same day by DNS TXT record.
2. **An approved template** — Utility category, with a **Document** header.
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
3. **A payment method on the WhatsApp account** — business-initiated messages
   (this is one) will not send without one.
4. **A phone number** — see the note below.

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
