# OM Order Entry — Phase 1

A mobile-friendly PWA for scanning/entering item codes, building an order request,
reviewing it, and submitting it. Phase 1 uses **mock item data** and a **local SQLite
database**. It does **not** connect to AutoCount yet.

## What it does (Phase 1 scope)

- Mobile-friendly web app / installable PWA — no login
- Barcode/QR scanning page (device camera)
- Manual item-code entry fallback
- Mock item lookup (item master in local DB)
- Add multiple item lines, set quantity per line
- Review screen before submission
- Submit → stores the request in a local SQLite database
- Generates a mock Sales Order number (e.g. `SO-2026-00001`)

## Tech stack

- **Backend:** Node.js + Express, SQLite (via `better-sqlite3`, with an automatic
  fallback to Node's built-in `node:sqlite` if the native module can't build)
- **Frontend:** Vanilla HTML/CSS/JS PWA (no build step), camera scanning via
  `html5-qrcode`
- The Express server also serves the frontend, so you run **one** thing.

---

## Folder structure

```
om-order-app/
├── README.md
├── backend/
│   ├── package.json
│   ├── db.js          # schema + SQLite driver (with fallback)
│   ├── seed.js        # loads mock item data
│   ├── server.js      # Express API + serves frontend
│   └── .gitignore
└── frontend/
    ├── index.html     # 3 screens: entry, review, confirm
    ├── styles.css
    ├── app.js         # state, scanning, cart, submit
    ├── manifest.json  # PWA manifest
    ├── sw.js          # service worker (app-shell cache)
    ├── icon-192.png
    └── icon-512.png
```

---

## Setup & run on Windows

### 1. Install Node.js
Download the **LTS** installer from <https://nodejs.org> (v18 or newer; v22 recommended)
and run it with default options. Verify in a new Command Prompt / PowerShell:

```cmd
node -v
npm -v
```

### 2. Install dependencies

```cmd
cd om-order-app\backend
npm install
```

> `better-sqlite3` ships prebuilt binaries for Windows, so this just works.
> If your environment ever fails to build it, the app automatically falls back to
> Node's built-in SQLite — no action needed.

### 3. Seed the mock item data (run once)

```cmd
npm run seed
```

You should see `Seeded 20 mock items into om_orders.db`.

### 4. Start the app

```cmd
npm start
```

You'll see: `OM Order App (Phase 1) running at http://localhost:3000`

### 5. Open it

- On the **same PC:** open <http://localhost:3000> in Chrome/Edge.
- On your **phone** (same Wi-Fi): find the PC's IP with `ipconfig` (look for
  *IPv4 Address*, e.g. `192.168.1.42`), then open `http://192.168.1.42:3000`
  on the phone.

> **Camera note:** browsers only allow camera access over `https://` or
> `http://localhost`. On `localhost` scanning works directly. From a phone over
> plain `http://<ip>`, the camera will be blocked — use **Manual entry** there, or
> serve over HTTPS (e.g. via `ngrok http 3000`) to enable scanning on the phone.
> Manual entry always works everywhere.

---

## Try it

Manual codes to type in (or scan the matching barcodes):

| Item code   | Barcode         | Item |
|-------------|-----------------|------|
| `525IB`     | 9501234500011   | Husqvarna 525iB Handheld Blower |
| `536LIXP`   | 9501234500028   | Husqvarna 536LiXP Battery Chainsaw |
| `K770`      | 9501234500059   | K770 Power Cutter |
| `VICTA18`   | 9501234500165   | Victa 18" Corded Lawn Mower |

Add a few lines, set quantities, **Review request**, then **Submit request**.
You'll get a mock SO number and the order is saved in `backend/om_orders.db`.

## Inspect the database (optional)

The data lives in `backend/om_orders.db`. Open it with any SQLite viewer
(e.g. [DB Browser for SQLite](https://sqlitebrowser.org/)) to see the
`orders` and `order_lines` tables.

## API reference

| Method | Path                  | Purpose |
|--------|-----------------------|---------|
| GET    | `/api/items/:code`    | Mock lookup by item code **or** barcode |
| GET    | `/api/items`          | Full mock catalogue |
| POST   | `/api/orders`         | Submit order; returns mock SO number |
| GET    | `/api/orders/:so`     | Retrieve a submitted order |

## Reset everything

Stop the server (Ctrl+C), delete `backend/om_orders.db` (and any
`om_orders.db-shm` / `om_orders.db-wal`), then run `npm run seed` again.

---

## Not in Phase 1 (deferred)

- AutoCount integration (real item master, real SO creation)
- Authentication / user accounts
- Real pricing, stock levels, customer selection
