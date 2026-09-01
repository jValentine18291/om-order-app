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
    getSlipSignature: (...a) => dataRepo.slips.getSlipSignature(...a),
    addPartToMachine: (...a) => dataRepo.slips.addPartToMachine(...a),
    setPartQuantity: (...a) => dataRepo.slips.setPartQuantity(...a),
    setPartPrice: (...a) => dataRepo.slips.setPartPrice(...a),
    setPartDescription: (...a) => dataRepo.slips.setPartDescription(...a),
    setMachineComment: (...a) => dataRepo.slips.setMachineComment(...a),
    setMachineLabour: (...a) => dataRepo.slips.setMachineLabour(...a),
    updateSlipDetails: (...a) => dataRepo.slips.updateSlipDetails(...a),
    setMachineState: (...a) => dataRepo.slips.setMachineState(...a),
    setAllMachineStates: (...a) => dataRepo.slips.setAllMachineStates(...a),
    setMachineDisposal: (...a) => dataRepo.slips.setMachineDisposal(...a),
    techniciansForMachine: (...a) => dataRepo.slips.techniciansForMachine(...a),
    createSlipOrder: (...a) => dataRepo.slips.createSlipOrder(...a),
    getSlipOrder: (...a) => dataRepo.slips.getSlipOrder(...a),
    getSlipOrders: (...a) => dataRepo.slips.getSlipOrders(...a),
    setOrderAutocountDocNo: (...a) => dataRepo.slips.setOrderAutocountDocNo(...a),
    renameOrder: (...a) => dataRepo.slips.renameOrder(...a),
    setOrderAutocountError: (...a) => dataRepo.slips.setOrderAutocountError(...a),
    ordersAwaitingAutoCount: (...a) => dataRepo.slips.ordersAwaitingAutoCount(...a),
    setSlipDrive: (...a) => dataRepo.slips.setSlipDrive(...a),
    closeSlip: (...a) => dataRepo.slips.closeSlip(...a),
  },
  notes: {
    getPartNote: (...a) => sqliteRepo.partNotes.getPartNote(...a),
    getPartNotes: (...a) => sqliteRepo.partNotes.getPartNotes(...a),
    setPartNote: (...a) => sqliteRepo.partNotes.setPartNote(...a),
  },
  requests: {
    createPartRequest: (...a) => sqliteRepo.partRequests.createPartRequest(...a),
    createPartRequestBatch: (...a) => sqliteRepo.partRequests.createPartRequestBatch(...a),
    listPartRequests: (...a) => sqliteRepo.partRequests.listPartRequests(...a),
    markPartRequestOrdered: (...a) => sqliteRepo.partRequests.markPartRequestOrdered(...a),
    markPartRequestBatchOrdered: (...a) => sqliteRepo.partRequests.markPartRequestBatchOrdered(...a),
    updatePartRequestBatch: (...a) => sqliteRepo.partRequests.updatePartRequestBatch(...a),
    deletePartRequestBatch: (...a) => sqliteRepo.partRequests.deletePartRequestBatch(...a),
    countPendingPartRequests: (...a) => sqliteRepo.partRequests.countPendingPartRequests(...a),
  },
};
