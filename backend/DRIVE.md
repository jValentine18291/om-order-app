# Filing PDFs in Google Drive

Two documents are kept in Drive: every **Service Slip**, and every **Repair
Quotation** that goes out. Each has its own folder inside the company Shared
Drive.

A slip is *shared* when it is sent to a customer on WhatsApp — the message
carries a link, so that file is readable by anyone holding the URL. A quotation
is **only filed**; it reaches the customer as an attachment off the phone, so
nothing about it is ever made public.

## The settings

All on the server, never in the repo. From an **Administrator** Command
Prompt:

    C:\nssm\nssm.exe edit OMService

NSSM is not on the PATH — the full path is the command. Everything lives on the
**Environment** tab: **add** a line, leave the rest alone. That box also holds
the AutoCount login and the WhatsApp token, and `nssm set ... AppEnvironmentExtra`
would replace the whole list.

    DRIVE_ENABLED                true, or nothing is uploaded at all
    DRIVE_FOLDER_ID              where Service Slips are filed
    DRIVE_QUOTATION_FOLDER_ID    where Repair Quotations are filed
    DRIVE_KEY_FILE               path to the service account's JSON key

Restart the service afterwards — `deploy.bat` does it.

Leave a folder id unset and that document is simply not filed. The other one
carries on: a folder nobody has made yet is not a fault.

## Adding a folder

1. **Find out who to share with.** On the server:

       cd /d C:\om-order-app
       node tools\show-drive-account.js

   It prints the app's own address, something like
   `om-service-drive@...iam.gserviceaccount.com`. That is an identity, not a
   credential — it is what goes in Google's Share box. The private key sitting
   beside it in the same file is the secret and is never printed.

2. **Make the folder inside the Shared Drive** — under *Shared drives* in the
   sidebar, not My Drive.

   This matters. The service account has no storage of its own, so it cannot
   own files in anybody's personal Drive. In a Shared Drive the files belong to
   the company, so they survive someone leaving and nothing has to be
   re-authorised.

3. **Share it with that address as Content manager** — it creates and updates
   files, not just reads them. Untick "Notify people"; the account has no inbox.

4. **Take the id out of the address bar.** In
   `https://drive.google.com/drive/folders/1BxTRRJ0...` the id is the part
   after `folders/`.

5. Set it with `nssm edit` as above, and deploy.

## What ends up in each folder

    ServiceSlip_00042 - KIAT & KIAT CONTRACTOR.pdf
    Quotation_QT-00042 - KIAT & KIAT CONTRACTOR.pdf
    Quotation_QT-00042-2 - KIAT & KIAT CONTRACTOR.pdf

A slip is filed when it is registered and replaced in place when it is edited,
so the link a customer already has keeps working and there is one file per
slip.

A quotation is named after the quotation rather than the slip. A revision has a
different number and becomes a file of its own, so the folder shows what was
quoted and what changed; re-sending the same number replaces that file.

## When it does not work

Filing is a convenience and never blocks the document. A Drive that is switched
off, not set up, or unreachable is reported once — "Sent, but not filed to
Drive: ..." — and the slip or quotation carries on. The record in the app is
safe either way, and the copy is already in the sender's hands.

Two failures worth knowing by sight:

- **"not set up (missing DRIVE_QUOTATION_FOLDER_ID)"** — the setting has not
  been added, or the service was not restarted after adding it.
- **404 on upload** — the file was deleted from Drive by hand. The app notices,
  treats it as new and uploads a fresh copy rather than failing for good.

`GET /api/drive/status` answers whether Drive is on and configured, without
saying anything secret.

## Why there are no Google libraries here

The official client pulls in several hundred packages for what is two HTTP
calls and a signature. A deploy here is a git pull and an npm install on a
machine in the workshop, so every dependency is one more thing that can break
one. `drive.js` signs its own token with node's crypto and calls the REST API.
