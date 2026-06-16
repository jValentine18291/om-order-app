# Data Layer — how the AutoCount swap will work

The backend's data access is isolated so the source can be swapped without
touching routes or the frontend. This was done in Phase 1 (while still on mock
data) specifically so Phase 3 (AutoCount) is a small, contained change.

## Structure

```
backend/
  server.js                     ← routes only; HTTP in, JSON out. No SQL.
  db.js                         ← SQLite setup + schema + auto-seed (unchanged)
  data/
    repository.contract.js      ← the interface every source must implement (docs)
    sqliteRepo.js               ← current source: all SQL lives here
    dataSource.js               ← THE SWITCH: picks which repo to use
    autocountRepo.js            ← (Phase 3 — does not exist yet)
```

`server.js` calls `data.items.findItem()`, `data.orders.createOrder()`, etc.
It never sees a database. Those calls are `await`ed, so a source can be
synchronous (SQLite) or asynchronous (AutoCount SDK/HTTP) with no route changes.

## The four methods a source must implement

See `data/repository.contract.js` for full detail. In short:

- `findItem(code)` → item | null   (tolerant: spaces/prefix optional)
- `listItems()` → item[]
- `createOrder({ notes, lines })` → { id, so_number, status, total_qty, total_amount }
- `getOrder(soNumber)` → order with `lines` array | null

## How to switch to AutoCount (Phase 3)

1. Create `data/autocountRepo.js` exporting those same four functions, calling
   the AutoCount SDK/API instead of SQLite. Map AutoCount's part fields to the
   item shape in the contract.
2. Register it in `data/dataSource.js`:
   ```js
   const autocountRepo = require("./autocountRepo");
   const repos = { sqlite: sqliteRepo, autocount: autocountRepo };
   ```
3. Set the environment variable `DATA_SOURCE=autocount` (in Render's dashboard,
   or a local `.env`). Restart. Done — no route or frontend changes.

### Mixing sources (optional)
Items and orders are exposed separately in `dataSource.js`, so you can later
draw items from AutoCount while still logging order requests locally (useful for
an audit trail or offline queue) by pointing `items` and `orders` at different
repos.

## Credentials — important
AutoCount connection details (server, database, license, passwords) must NOT be
committed to GitHub or pasted anywhere shared. They belong in environment
variables / a local config file on your own server that stays on your network.
`autocountRepo.js` should read them from `process.env`, never hard-code them.

## Verifying after any change
Boot the server and check the endpoints still behave:
```
GET  /api/items/SZEN%20140051111   → the item
GET  /api/items/140051111          → same item (tolerant)
GET  /api/items                    → full catalogue
POST /api/orders   {notes,lines}   → SO summary
GET  /api/orders/SO-YYYY-NNNNN      → order with lines
```
