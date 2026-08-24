// data/autocountConnection.js
// ============================================================================
// AutoCount SQL Server connection (READ-ONLY usage intended).
//
// All connection settings come from environment variables — NEVER hard-code
// credentials, and never commit them to GitHub. Set these on the machine that
// runs the app:
//
//   AUTOCOUNT_DB_SERVER     e.g. OMAPPSVR1\A2006  (or 192.168.1.7\A2006)
//   AUTOCOUNT_DB_PORT       e.g. 1433             (optional; default 1433)
//   AUTOCOUNT_DB_NAME       e.g. AED_OUTBOARD
//   AUTOCOUNT_DB_USER       the SQL Server login
//   AUTOCOUNT_DB_PASSWORD   that login's password
//   AUTOCOUNT_DB_ENCRYPT    "true" or "false" (default false for local network)
//
// This module exposes a single pooled connection getter. The pool is created
// once and reused. If config is missing, it throws a clear error so the caller
// can fall back / report cleanly.
// ============================================================================

const sql = require("mssql");

let poolPromise = null;

function buildConfig() {
  const server = process.env.AUTOCOUNT_DB_SERVER;
  const database = process.env.AUTOCOUNT_DB_NAME;
  const user = process.env.AUTOCOUNT_DB_USER;
  const password = process.env.AUTOCOUNT_DB_PASSWORD;

  const missing = [];
  if (!server) missing.push("AUTOCOUNT_DB_SERVER");
  if (!database) missing.push("AUTOCOUNT_DB_NAME");
  if (!user) missing.push("AUTOCOUNT_DB_USER");
  if (!password) missing.push("AUTOCOUNT_DB_PASSWORD");
  if (missing.length) {
    throw new Error(
      `[autocount] Missing required env vars: ${missing.join(", ")}. ` +
        `Set them on the server (never commit them).`
    );
  }

  // Support the "HOST\INSTANCE" form by splitting into server + instanceName.
  let host = server;
  let instanceName;
  if (server.includes("\\")) {
    const [h, inst] = server.split("\\");
    host = h;
    instanceName = inst;
  }

  const config = {
    server: host,
    database,
    user,
    password,
    options: {
      // Encryption usually false on a trusted local network; set true if your
      // SQL Server requires it. trustServerCertificate avoids cert validation
      // issues with self-signed certs common on internal servers.
      encrypt: String(process.env.AUTOCOUNT_DB_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };
  // When a named instance is used, SQL Browser resolves the port — do not
  // force a port in that case unless explicitly provided.
  if (instanceName) {
    config.options.instanceName = instanceName;
    if (process.env.AUTOCOUNT_DB_PORT) config.port = Number(process.env.AUTOCOUNT_DB_PORT);
  } else {
    config.port = process.env.AUTOCOUNT_DB_PORT ? Number(process.env.AUTOCOUNT_DB_PORT) : 1433;
  }
  return config;
}

// Get (or lazily create) the shared connection pool.
function getPool() {
  if (!poolPromise) {
    const config = buildConfig();
    poolPromise = sql.connect(config).catch((err) => {
      // Reset so a later call can retry after fixing config/network.
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// Run a read-only query with optional parameters. Helper used by the repo.
async function query(sqlText, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value);
  }
  const result = await request.query(sqlText);
  return result.recordset;
}

// Same as query(), but returns how many rows the statement actually changed.
// Writes need this: an UPDATE guarded by "...AND Price IS NULL" reports zero
// rows when someone set the price a moment earlier, and that has to be told
// apart from a successful write rather than reported as one.
async function execute(sqlText, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value);
  }
  const result = await request.query(sqlText);
  const affected = Array.isArray(result.rowsAffected)
    ? result.rowsAffected.reduce((a, b) => a + b, 0)
    : 0;
  return { rowsAffected: affected, recordset: result.recordset };
}

module.exports = { getPool, query, sql, execute };
