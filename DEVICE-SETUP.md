# Putting the app on a phone or tablet

> **Deploying a new version?** That is `deploy.bat` in this folder — right-click,
> Run as administrator. It pulls, installs anything new and restarts the
> service, stopping at the first step that fails rather than restarting over a
> half-finished pull.

Ten minutes per device, and the order matters. The certificate has to be trusted
**before** the app is added to the home screen, because iOS decides the icon
once, when you add it, and never asks again.

---

## iPhone and iPad

### 1. Trust the certificate — both halves

The office server uses its own certificate rather than one bought from a
certificate authority. Until the device trusts it you get a security warning on
every visit, and — less obviously — the home-screen icon never appears.

**a. Install it.** On the device, open:

    https://192.168.1.7:8443/api/cert.pem

Then **Settings → General → VPN & Device Management** → tap the downloaded
profile → **Install**.

> Use the `/api/` address. A device that already has the app installed cannot
> load the plain `/cert.pem`: the app's service worker intercepts it, its own
> fetch fails on the untrusted certificate, and the page hangs. Every version of
> the worker ever shipped ignores anything under `/api/`, so that address always
> reaches the server. On a device that has never had the app, either works.

**b. Turn it on.** This is a **separate switch**, and the step everyone misses:

    Settings → General → About → Certificate Trust Settings

Scroll to the bottom. The certificate is listed there with a toggle of its own.
**Installing the profile does not turn it on.** Until you do, iOS still treats
the site as untrusted, and the symptom is not a warning — it is a home screen
showing a plain letter tile where the leaf should be.

### 2. Add it to the home screen

Open `https://192.168.1.7:8443/` in Safari, then **Share → Add to Home Screen**.

The preview in that sheet shows the icon iOS is about to use. If it shows the
leaf, you are done. If it shows a plain letter, step 1b has not taken effect —
go back and check the toggle rather than adding it anyway.

### If the icon is wrong and the certificate is definitely trusted

Remove the home-screen shortcut and add it again. iOS takes the icon at the
moment you add it and never re-fetches, so a shortcut created before the
certificate was trusted keeps its letter tile for ever.

### 3. Turn on notifications (sales, purchaser, admin)

Open **Need to Quote** and tap **Turn on** in the row at the top. The phone asks
once; allow it.

This is **per device**, not per person. Someone with a phone and a tablet turns
it on in both places and is told on both. The row tells you how many devices are
currently being notified, so you can see it took.

On iOS this only works for the app **added to the Home Screen**, on iOS 16.4 or
later. Open in a Safari tab, the row hides itself rather than offering a button
that cannot work. Do step 2 first.

If the row says notifications are blocked, that is the phone's own setting and
the app cannot undo it: **Settings → Notifications → OM Service**, or in Safari
**Settings → Safari → Notifications**.

---

## Android

Chrome reads the web manifest, so it is simpler: open the address, accept the
certificate warning, then **⋮ → Add to Home screen**. Trusting the certificate
is still worth doing to stop the warning on every visit — install the same file
through **Settings → Security → Encryption & credentials → Install a
certificate → CA certificate**.

---

## Why the app is on HTTPS at all

The camera — barcode and QR scanning — is only available to a page served over
HTTPS. That is why the server carries a certificate rather than running plain,
and why every device needs this once.

---

## What each address is for

| Address | What it does |
| --- | --- |
| `https://192.168.1.7:8443/` | the app |
| `https://192.168.1.7:8443/api/cert.pem` | the certificate, from any device |
| `https://192.168.1.7:8443/cert.pem` | the same file, for a device without the app |

Only the public certificate is served. Every device already receives it during
the TLS handshake, so this exposes nothing; the private key stays on the server
and is never sent.
