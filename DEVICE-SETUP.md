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

Chrome reads the web manifest, so the icon is simpler than on iOS. The
certificate, however, is **not optional if you want notifications** — see below.

### 1. Install the certificate

Download it from `https://192.168.1.7:8443/api/cert.pem`, then install it
through **Settings → Security → Encryption & credentials → Install a
certificate → CA certificate**. Android warns that someone could monitor the
device; that warning is about CA certificates in general, and this one is the
office server's own.

> **Clicking through the certificate warning in Chrome is not enough.** Chrome
> refuses to run a site's background worker on a connection whose certificate it
> does not trust, and that worker is the thing that receives notifications. The
> app itself still loads and works — which is why this looks like a
> notifications problem rather than a certificate one. Until the certificate is
> installed, the phone cannot subscribe at all, and nothing will ever arrive.

### 2. Add it to the home screen

Open the address, then **⋮ → Add to Home screen**.

### 3. Turn on notifications

Open **Need to Quote** and tap **Turn on** in the row at the top. The row shows
how many devices are being notified, so you can see it took.

### If notifications arrive only when she opens the app

This is the Android failure worth knowing about, because it does not look like a
failure — the notification does turn up, just hours late and only once the app
is opened.

On Android the notification is delivered to **Chrome**, which then wakes the
app's worker to show it. If Chrome is not running in the background, Google
holds the message in a queue and hands it over the moment Chrome next starts.
On iOS this cannot happen: the phone keeps its own connection open whether the
app is running or not, which is why an iPhone beside it works perfectly.

Two separate power savers have to be dealt with, and they are in different
places:

**1. Chrome's own.** In Chrome: **⋮ → Settings → Power saver → off** (some
versions call it Performance). This one is easy to miss because it lives inside
Chrome rather than in Android's settings, and it was the cause here.

**2. Android's.** **Settings → Apps → Chrome → Battery → Unrestricted.**
"Optimised" is the default and is not enough.

Samsung adds a third layer that overrides both: **Settings → Battery →
Background usage limits** — Chrome must not be in *Sleeping apps* or *Deep
sleeping apps*. Xiaomi, Oppo, Vivo and OnePlus need **Autostart** switched on
for Chrome, and Chrome locked in the recent-apps list.

Whatever the phone, do not swipe Chrome out of the recent-apps list. Several
manufacturers treat that as a force-stop, which kills the connection until
Chrome is opened again.

### If nothing arrives at all

**Settings → Apps → Chrome → Notifications** — Android gives each website its
own switch there, separate from the permission Chrome asked for, and it can be
off while Chrome still reports the site as allowed.

---

## Checking who is actually subscribed

On the server:

    node backend\push-status.js

It lists every subscribed device by role, which push service it belongs to
(Apple or Google) and when it was added. That distinguishes the two causes of
"my phone gets nothing":

- **the phone is not in the list** — it never subscribed, so nothing was ever
  going to reach it. On Android that is the certificate, above.
- **the phone is in the list** — add `--send` to send it a real test
  notification and print exactly what the push service says back.

Only the push service and a short ID are printed, never the full address: those
addresses are keys in their own right, and anyone holding one can send
notifications to that device.

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
