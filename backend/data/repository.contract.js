// data/repository.contract.js
// ============================================================================
// DATA REPOSITORY CONTRACT  (documentation — not executed)
// ----------------------------------------------------------------------------
// Every data source (SQLite today, AutoCount later) implements this same shape.
// server.js talks ONLY to this interface, never to a database directly. To swap
// in AutoCount, write a new module that exports these four functions and point
// dataSource.js at it — no route or frontend changes needed.
//
// All functions are synchronous-or-async tolerant: server.js `await`s them, so
// an implementation may return a value OR a Promise. (SQLite is synchronous;
// AutoCount's SDK/HTTP calls will be async. Awaiting both works.)
//
// ----------------------------------------------------------------------------
// ITEM SHAPE  (what findItem / listItems return for each item)
//   {
//     item_code:   string   // canonical SKU, e.g. "SZEN 140051111"
//     barcode:     string   // may equal item_code's numeric part
//     description: string
//     brand:       string
//     uom:         string    // unit of measure, e.g. "PCS"
//     unit_price:  number
//   }
//
// ----------------------------------------------------------------------------
// METHODS
//
// findItem(code: string) -> item | null
//   Tolerant lookup. "SZEN 140051111", "SZEN140051111", and "140051111" should
//   all resolve to the same item. Returns null when nothing matches.
//
// listItems() -> item[]
//   Full catalogue, ordered by description.
//
// createOrder({ notes: string, lines: OrderLineInput[] }) -> OrderResult
//   OrderLineInput: { item_code, description?, uom?, unit_price?, quantity }
//   OrderResult:    { id, so_number, status, total_qty, total_amount }
//   Persists the order and returns a summary. Generates the SO number.
//
// getOrder(soNumber: string) -> Order | null
//   Order: the stored order row plus a `lines` array. Null if not found.
//
// ----------------------------------------------------------------------------
// ERROR CONVENTION
//   - findItem / getOrder return null for "not found" (route maps to 404).
//   - createOrder THROWS on invalid input; the thrown Error's `.status` (if set)
//     and `.message` are used by the route. Validation errors set status 400.
// ============================================================================

module.exports = {}; // intentionally empty — this file is documentation only
