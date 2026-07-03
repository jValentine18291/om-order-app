// data/dataSource.js
// ============================================================================
// DATA SOURCE SELECTOR — the single place that decides where data comes from.
//
// Two independent switches via environment variables:
//
//   ITEMS_SOURCE   = "sqlite" (default) | "autocount"   <- item lookups
//   DATA_SOURCE    = "sqlite" (default)                 <- orders + service slips
//
// Why separate? Items can safely be READ from AutoCount, while service slips
// and order writes stay on SQLite (writing into AutoCount needs the official
// AutoCount API/SDK). The typical production config on the office server is:
//   ITEMS_SOURCE=autocount   (read real items/prices)
//   DATA_SOURCE=sqlite       (slips + orders stay local)
//
// AutoCount also needs its AUTOCOUNT_DB_* connection vars — see
// data/autocountConnection.js.
// ============================================================================

const sqliteRepo = require("./sqliteRepo");

// AutoCount repo is loaded lazily, only if selected — so a missing mssql driver
// or config never breaks the default SQLite path.
function loadRepo(name) {
  if (name === "sqlite") return sqliteRepo;
  if (name === "autocount") return require("./autocountRepo");
  throw new Error(`[dataSource] Unknown source "${name}". Use "sqlite" or "autocount".`);
}

const ITEMS_SOURCE = (process.env.ITEMS_SOURCE || "sqlite").toLowerCase();
const DATA_SOURCE = (process.env.DATA_SOURCE || "sqlite").toLowerCase();

const itemsRepo = loadRepo(ITEMS_SOURCE);
const dataRepo = loadRepo(DATA_SOURCE);

console.log(`[dataSource] items from "${ITEMS_SOURCE}", orders+slips from "${DATA_SOURCE}"`);

// ----------------------------------------------------------------------------
// Items come from itemsRepo; orders and service slips from dataRepo. This lets
// items be read from AutoCount while all writes stay safely on SQLite.
module.exports = {
  items: {
    findItem: (...a) => itemsRepo.findItem(...a),
    listItems: (...a) => itemsRepo.listItems(...a),
  },
  orders: {
    createOrder: (...a) => dataRepo.createOrder(...a),
    getOrder: (...a) => dataRepo.getOrder(...a),
  },
  slips: {
    createSlip: (...a) => dataRepo.slips.createSlip(...a),
    listSlips: (...a) => dataRepo.slips.listSlips(...a),
    searchSlips: (...a) => dataRepo.slips.searchSlips(...a),
    getSlip: (...a) => dataRepo.slips.getSlip(...a),
    addPartToMachine: (...a) => dataRepo.slips.addPartToMachine(...a),
    setPartQuantity: (...a) => dataRepo.slips.setPartQuantity(...a),
    setPartPrice: (...a) => dataRepo.slips.setPartPrice(...a),
    setMachineComment: (...a) => dataRepo.slips.setMachineComment(...a),
    createSlipOrder: (...a) => dataRepo.slips.createSlipOrder(...a),
    closeSlip: (...a) => dataRepo.slips.closeSlip(...a),
  },
};
