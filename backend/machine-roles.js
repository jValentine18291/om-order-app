// backend/machine-roles.js
// ============================================================================
// WHO MAY MOVE A MACHINE FROM ONE STATE TO ANOTHER.
//
// John, 28 Sep 2026: a technician may ASK (send for quoting), not decide.
// John, 1 Oct 2026: except the customer's answer. Technicians ring customers
// themselves, often skipping the formal quotation, so two answers are theirs:
//
//   "Proceed with repair"      waiting-to-quote or quoted  -> In Progress
//   "Too expensive - condemn"  anything not yet finished   -> Condemned
//
// Everything else - marking repaired, undoing, quoting - stays with Sales and
// Admin. Its own file so the rule can be tested on its own (test-tech-answer).
// ============================================================================

const DECIDE = ["sales", "admin"];
const CONDEMNABLE = ["RECEIVED", "AWAITING_QUOTE", "QUOTED", "TO_REPAIR"];

// null = anybody (asking for a quote settles nothing); otherwise the roles.
function rolesForMachineMove(from, to) {
  const f = String(from || "").toUpperCase();
  const t = String(to || "").toUpperCase();
  if (t === "AWAITING_QUOTE") return null;
  const techAnswer =
    (t === "TO_REPAIR" && (f === "AWAITING_QUOTE" || f === "QUOTED")) ||
    (t === "CONDEMNED" && CONDEMNABLE.includes(f));
  return techAnswer ? [...DECIDE, "tech"] : DECIDE;
}

module.exports = { rolesForMachineMove, DECIDE, CONDEMNABLE };
