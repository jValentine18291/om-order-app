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
credentials. Set them with `nssm edit OMService` — **not** `nssm set
AppEnvironmentExtra`, which replaces the whole list and would wipe the
AutoCount login.

## Phone numbers

Staff type these by hand, so the app accepts `9123 4567`, `+65 9123 4567`,
`6591234567` and `65-9123-4567`, and adds `65` to a bare 8-digit mobile.

It **refuses** anything it cannot read confidently rather than guessing — an 8
digit number that does not start 8 or 9 is rejected with a message asking for
the country code, because a wrong number here sends a signed slip to a stranger.

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

## What is still missing (all on Meta's side)

1. **Business verification** — still Unverified. Needs ACRA documents, takes days.
2. **An approved template** — Utility category, with a **Document** header.
   Name `service_slip_confirmation`, language **English** (`en`), and **four**
   body variables in this exact order:

       {{1}} customer name        e.g. Mr Tan
       {{2}} slip number          e.g. 00123
       {{3}} date received        e.g. 25 Aug 2026
       {{4}} equipment            e.g. Husqvarna 365 Chainsaw

   The order is fixed by the approved template - changing it in Meta without
   changing `whatsapp.js` would put the slip number where the name goes.

   The date is the date the slip was REGISTERED, not today, so re-sending an
   older slip from View Slips still reads correctly. Equipment names the first
   machine and counts the rest ("Automower 550 EPOS and 2 more") rather than
   listing them all, which would wrap into a wall of text on a phone.
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
