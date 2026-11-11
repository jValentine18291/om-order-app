// MOVE AUTOCOUNT'S KEY COUNTER PAST THE KEYS THE APP HAS ALREADY USED.
//
//   cd /d C:\om-order-app
//   node tools\lift-key-counter.js            (looks, changes nothing)
//   node tools\lift-key-counter.js --apply    (moves the counter)
//
// RUN THIS ON THE SERVER. John approved this one-off on 11 Nov 2026.
//
// Until 11 Nov the app gave the Sales Orders it wrote "highest key + 1" and
// never moved AutoCount's own key counter (Registry 32768). So the counter sat
// behind keys already in use, AutoCount handed those numbers out again, and
// editing SO-2611-041 failed with "Primary Key Error". The app now takes its
// keys from the counter (autocountSalesOrder.js, reserveKeys); this clears the
// numbers it took before that.
//
// It changes ONE value: Registry 32768, to one past the highest key in use. No
// document is touched. The row is locked while it is read and set, so AutoCount
// cannot take a key in between.
const path = require("path");

try { require(path.resolve(__dirname, "..", "backend", "serviceEnv.js")).load(); }
catch (e) { console.log("  (could not read the service settings: " + e.message + ")"); }

const apply = process.argv.includes("--apply");
const { query, inTransaction } = require(path.resolve(__dirname, "..", "backend", "data", "autocountConnection.js"));
const { KEY_TABLES, KEY_REG_ID } = require(path.resolve(__dirname, "..", "backend", "data", "autocountSalesOrder.js"));
const say = (s = "") => console.log("  " + s);

function asNumber(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d+$/.test(s)) throw new Error(`the counter reads "${s}", not a number - not touching it.`);
  return Number(s);
}

(async () => {
  console.log("");
  if ((process.env.ITEMS_SOURCE || "").toLowerCase() !== "autocount") {
    say("Run this on the server - AutoCount is not switched on here."); console.log(""); process.exit(1);
  }

  const reg = await query(`SELECT RegValue FROM Registry WHERE RegID = ${KEY_REG_ID}`);
  if (!reg.length) throw new Error(`AutoCount has no Registry ${KEY_REG_ID}.`);
  const counter = asNumber(reg[0].RegValue);
  const tops = await query(KEY_TABLES.map(([t, c]) => `SELECT '${t}' AS T, MAX([${c}]) AS K FROM [${t}]`).join(" UNION ALL "));
  const top = tops.reduce((m, r) => (r.K !== null && Number(r.K) > m ? Number(r.K) : m), 0);
  const above = await query(KEY_TABLES.map(([t, c]) => `SELECT '${t}' AS T, COUNT(*) AS N FROM [${t}] WHERE [${c}] > ${counter}`).join(" UNION ALL "));
  const inUse = above.filter((r) => Number(r.N) > 0);

  say(`AutoCount's key counter (Registry ${KEY_REG_ID}):  ${counter}`);
  say(`Highest key in use:                         ${top}`);
  say(`Keys in use ABOVE the counter:              ${inUse.length ? inUse.map((r) => `${r.T} ${r.N}`).join(", ") : "none"}`);
  say("");

  if (top < counter) {
    say("Nothing to do: the counter is already past every key in use.");
    console.log(""); return;
  }
  if (!apply) {
    say(`AutoCount would hand out numbers already taken. --apply moves the counter to ${top + 1}.`);
    say("Nothing has been changed.");
    console.log(""); return;
  }

  const result = await inTransaction(async (run) => {
    const cur = await run(`SELECT RegValue FROM Registry WITH (UPDLOCK, HOLDLOCK) WHERE RegID = ${KEY_REG_ID}`);
    const now = asNumber(cur.recordset[0] && cur.recordset[0].RegValue);
    const t = (await run(KEY_TABLES.map(([tb, c]) => `SELECT MAX([${c}]) AS K FROM [${tb}]`).join(" UNION ALL "))).recordset
      .reduce((m, r) => (r.K !== null && Number(r.K) > m ? Number(r.K) : m), 0);
    if (t < now) return { from: now, to: now, moved: false };
    const done = await run(`UPDATE Registry SET RegValue = @v WHERE RegID = ${KEY_REG_ID}`, { v: String(t + 1) });
    if (done.rowsAffected !== 1) throw new Error("the counter row was not updated.");
    return { from: now, to: t + 1, moved: true };
  });
  say(result.moved
    ? `DONE: the counter moved from ${result.from} to ${result.to}.`
    : `Nothing to do: AutoCount had already moved the counter to ${result.from}.`);
  say("Now close AutoCount completely on the PC editing SO-2611-041, open it again, and retry the edit.");
  console.log("");
})().catch((e) => { console.error("\n  NOT CHANGED: " + e.message + "\n"); process.exit(1); });
