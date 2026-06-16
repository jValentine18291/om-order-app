// data/dataSource.js
// ============================================================================
// DATA SOURCE SELECTOR — the single place that decides where data comes from.
//
// Today: everything uses the SQLite repository.
// Phase 3: create data/autocountRepo.js (same four functions as the contract),
//          then set the DATA_SOURCE env var to "autocount" to switch — OR mix
//          sources (e.g. items from AutoCount, order logging still local) by
//          adjusting the picks below. No changes needed in server.js.
//
// Switch via environment variable (set in Render's dashboard or a local .env):
//   DATA_SOURCE=sqlite     (default)
//   DATA_SOURCE=autocount  (once autocountRepo.js exists)
// ============================================================================

const sqliteRepo = require("./sqliteRepo");

const SOURCE = (process.env.DATA_SOURCE || "sqlite").toLowerCase();

// Map of available repositories. Add autocount here when it's built:
//   const autocountRepo = require("./autocountRepo");
//   repos.autocount = autocountRepo;
const repos = {
  sqlite: sqliteRepo,
};

const repo = repos[SOURCE];

if (!repo) {
  // Fail loudly and early rather than serving wrong/empty data silently.
  const available = Object.keys(repos).join(", ");
  throw new Error(
    `[dataSource] Unknown DATA_SOURCE "${SOURCE}". Available: ${available}. ` +
      `Defaulting requires DATA_SOURCE unset or "sqlite".`
  );
}

console.log(`[dataSource] using "${SOURCE}" repository`);

// ----------------------------------------------------------------------------
// Items and orders are exposed separately so they can later point at DIFFERENT
// sources if needed (e.g. items from AutoCount, orders still logged locally).
// For now both come from the same selected repo.
module.exports = {
  items: {
    findItem: (...a) => repo.findItem(...a),
    listItems: (...a) => repo.listItems(...a),
  },
  orders: {
    createOrder: (...a) => repo.createOrder(...a),
    getOrder: (...a) => repo.getOrder(...a),
  },
  slips: {
    createSlip: (...a) => repo.slips.createSlip(...a),
    listSlips: (...a) => repo.slips.listSlips(...a),
    getSlip: (...a) => repo.slips.getSlip(...a),
    addPartToMachine: (...a) => repo.slips.addPartToMachine(...a),
    setPartQuantity: (...a) => repo.slips.setPartQuantity(...a),
    createSlipOrder: (...a) => repo.slips.createSlipOrder(...a),
    closeSlip: (...a) => repo.slips.closeSlip(...a),
  },
};
