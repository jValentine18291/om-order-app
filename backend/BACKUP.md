# Backing up the service slip database

`om_orders.db` holds every service slip, machine, part line, signature and
order the app has ever recorded. It is **not** in GitHub and **not** copied by
`git pull`. If the server disk fails and there is no backup, that history is
gone.

## The trap: you cannot back this up by copying the file

The database runs in **WAL mode**. Recent writes live in `om_orders.db-wal`,
not in `om_orders.db` itself. Copying just the `.db` file gives you something
that looks like a backup and is not.

This was measured on a live database holding 5 slips:

    om_orders.db       4,096 bytes    <- almost empty
    om_orders.db-wal 247,232 bytes    <- the actual data

    copying om_orders.db by hand : unreadable - "no such table: service_slips"
    backup-db.js                 : 5 slips

So: **do not back this up by copying files**, and do not trust any existing
copy made that way. Use the script below, which uses SQLite's own
`VACUUM INTO` to write one consistent, self-contained file while the app keeps
running. It opens the live database **read-only**, so a backup can never alter
live data, and the service does not need to be stopped.

## Running a backup by hand

Double-click:

    backend\backup-db.bat

It prints what it did and waits so you can read it. Backups go to
`backend\backups` unless you change `BACKUP_DIR` at the top of that file.

**Change it if you can.** A backup on the same disk protects against a mistake
or a bug, but not against that disk failing. A network share or a second drive
is much better.

## Running it every day (Task Scheduler)

1. Start menu → **Task Scheduler** → **Create Basic Task**
2. Name: `OM Service database backup`
3. Trigger: **Daily**, pick a quiet time such as 22:00
4. Action: **Start a program**
   - Program/script: `P:\1-SCAN\om-order-app\backend\backup-db.bat`
   - Add arguments: `auto`
   - Start in: `P:\1-SCAN\om-order-app\backend`
5. Finish, then open the task's properties and tick
   **Run whether user is logged on or not**

The `auto` argument stops it waiting for a keypress. The task reports failure
to Task Scheduler properly, so a red result in the task history means a backup
really did not happen.

## If the scheduled task reports Last Result 1

Almost always Node. A scheduled task runs with nobody logged on and no user
profile, so `node` is frequently missing from its PATH even though it works
perfectly when you run the file yourself. The batch file looks on PATH and in
the usual install folders, and says so in plain words if it still cannot find
it. Set `OM_NODE` to the full path of `node.exe` if it lives somewhere unusual,
or add Node to the SYSTEM PATH rather than only your own user PATH.

Whatever the cause, **`backend\backup-last-run.txt`** holds everything the last
run printed. An exit code on its own tells you nothing; that file tells you what
actually happened.

## Checking it is working

Three places, all quick:

- `backend\backup-last-run.txt` — everything the last run printed
- `backend\backup.log` — one line per run, `ok` or `FAILED`
- `backend\backups\` — dated files, roughly the size of the database

Each backup is re-opened and checked by SQLite before it counts as good, and
the run prints how many slips it contains. **If that number ever drops sharply,
stop and investigate before the older backups age out.**

Old backups are deleted after 30 days (`OM_BACKUP_KEEP_DAYS`), except that the
7 most recent are always kept however old they are — so a quiet month cannot
empty the folder. Only files the script itself created are ever deleted;
anything else you put in that folder is left alone.

## The price audit log travels with it

Each run also copies `price-updates.log`, the only record of prices the app has
written into AutoCount (AutoCount itself keeps no trace of them). It is
excluded from GitHub, so these backups are its only copy.

## Restoring

Tested end to end: the app opened a restored file, found every slip, and
carried on accepting new ones.

1. Stop the service:

       C:\nssm\nssm.exe stop OMService

2. In `backend`, delete or rename **all three**:

       om_orders.db
       om_orders.db-wal
       om_orders.db-shm

   Leaving a stale `-wal` behind next to a restored database is the one way to
   make a good backup fail.

3. Copy the backup you want in, and rename it to `om_orders.db`.

4. Start the service:

       C:\nssm\nssm.exe start OMService

5. Open the app and check View Slips shows the history you expect.

Anything recorded after that backup was taken is not in it. Backups are daily,
so the most you can lose is a day.
