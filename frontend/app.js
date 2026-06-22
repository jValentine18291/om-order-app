// app.js — OM Service (service-slip workflow)
// Home -> New / Open / Close Service. Parts scanned in Open Service are saved
// per-machine to the backend immediately. No login.

const API = ""; // same origin

// ---- State -----------------------------------------------------------------
let scanCooldown = false;
let currentMode = "upload";

// Open Service session state
const session = {
  slipNumber: null,     // e.g. "00001"
  slip: null,           // full slip object (with machines + parts)
  machineId: null,      // currently selected machine id
  technician: "",       // carries over across machines
};

// ---- Helpers ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const money = (n) => "$" + (Number(n) || 0).toFixed(2);

const ICON = {
  ok:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
};

function toast(msg, kind = "ok") {
  const t = $("toast");
  $("toast-msg").textContent = msg;
  $("toast-ic").innerHTML = kind === "err" ? ICON.err : ICON.ok;
  t.className = "toast show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

// Format a stored timestamp ("2026-06-16 08:50:25") as a plain date: "16 Jun 2026".
function formatDate(ts) {
  if (!ts) return "";
  // Treat the space-separated SQLite timestamp as a date; take the date part.
  const datePart = String(ts).split(" ")[0]; // "2026-06-16"
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}

// ---- Screen navigation -----------------------------------------------------
const SCREENS = ["home", "new", "open", "close", "view"];
function showScreen(name) {
  SCREENS.forEach((s) => $("screen-" + s).classList.toggle("active", s === name));
  // Footer only on open-service when entry is active
  $("footer-open").style.display = "none";
  // Home link visible everywhere except home
  $("home-link").style.display = name === "home" ? "none" : "inline-flex";
  // Stop any camera when leaving a scanning context
  if (name !== "open") { try { stopQrScanner(); } catch (_) {} }
  window.scrollTo(0, 0);
}

async function goHome() {
  // Save any in-progress repair comment before clearing the session.
  try { await saveCurrentComment(); } catch (_) {}
  try { stopQrScanner(); } catch (_) {}
  session.slipNumber = null; session.slip = null; session.machineId = null; session.technician = "";
  showScreen("home");
}

// ---- API helpers -----------------------------------------------------------
async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (body && body.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

async function lookupItem(code) {
  return api(`/api/items/${encodeURIComponent(code)}`);
}

// ============================================================================
// REUSABLE SLIP SEARCH (used by Open, Close, View)
// Wires a text input + results container to the search endpoint, debounced.
// onPick(slipNumber) is called when the user taps a result.
// ============================================================================
function setupSlipSearch({ inputId, resultsId, scope, onPick }) {
  const input = $(inputId);
  const results = $(resultsId);
  let debounce = null;

  async function runSearch() {
    const q = input.value.trim();
    try {
      const data = await api(`/api/slips-search?q=${encodeURIComponent(q)}&scope=${scope}`);
      renderResults(data);
    } catch (e) {
      results.innerHTML = `<div class="slip-result-empty">Search failed</div>`;
    }
  }

  function renderResults(data) {
    const list = data.results || [];
    if (list.length === 0) {
      results.innerHTML = `<div class="slip-result-empty">${input.value.trim() ? "No matching slips" : "No slips yet"}</div>`;
      return;
    }
    results.innerHTML =
      list.map((s) =>
        `<button type="button" class="slip-result" data-slip="${escapeAttr(s.slip_number)}">
           <span class="sr-num">${escapeHtml(s.slip_number)}</span>
           <span class="sr-co">${escapeHtml(s.company)}</span>
           <span class="sr-status sr-${escapeAttr(s.status)}">${escapeHtml(STATUS_LABEL[s.status] || s.status)}</span>
         </button>`
      ).join("") +
      (data.hasMore ? `<div class="slip-result-more">Keep typing to narrow results…</div>` : "");

    results.querySelectorAll(".slip-result").forEach((btn) =>
      btn.addEventListener("click", () => {
        const num = btn.dataset.slip;
        // Mark selection visually
        results.querySelectorAll(".slip-result").forEach((b) => b.classList.remove("picked"));
        btn.classList.add("picked");
        onPick(num);
      })
    );
  }

  // Debounced typing
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 250);
  });

  // Expose a reset that clears + shows recent slips
  return {
    reset() {
      input.value = "";
      results.innerHTML = `<div class="slip-result-empty">Loading…</div>`;
      runSearch();
    },
  };
}

// STATUS_LABEL is defined later (used by both search and View Slips); declare here.
const STATUS_LABEL = {
  OPEN: "Open",
  CALL_CUSTOMER: "Call customer (SO created)",
  CLOSED: "Closed",
};

// ============================================================================
// NEW SERVICE
// ============================================================================
function addMachineRow(value = "") {
  const wrap = $("ns-machines");
  const row = document.createElement("div");
  row.className = "machine-row";
  row.innerHTML = `
    <input type="text" class="ns-machine-input" autocomplete="off" placeholder="e.g. Husqvarna 525LK Brushcutter" />
    <button type="button" class="machine-del" aria-label="Remove machine">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  row.querySelector("input").value = value;
  row.querySelector(".machine-del").addEventListener("click", () => {
    // Keep at least one row present
    if ($("ns-machines").children.length > 1) row.remove();
  });
  wrap.appendChild(row);
}

function resetNewServiceForm() {
  ["ns-company", "ns-contact-name", "ns-contact-number", "ns-whatsapp", "ns-notes"].forEach((id) => ($(id).value = ""));
  const same = $("ns-whatsapp-same"); if (same) same.checked = false;
  const wa = $("ns-whatsapp"); if (wa) wa.removeAttribute("disabled");
  const created = $("ns-created"); if (created) { created.style.display = "none"; created.innerHTML = ""; }
  $("ns-machines").innerHTML = "";
  addMachineRow();
  $("ns-status").innerHTML = "";
}

async function submitNewService() {
  const company = $("ns-company").value.trim();
  const machines = [...document.querySelectorAll(".ns-machine-input")]
    .map((i) => i.value.trim()).filter(Boolean);

  if (!company) { $("ns-status").innerHTML = statusErr("Company is required."); return; }
  if (machines.length === 0) { $("ns-status").innerHTML = statusErr("Add at least one machine."); return; }

  $("ns-submit").disabled = true;
  $("ns-status").innerHTML = statusInfo("Registering…");
  try {
    const slip = await api("/api/slips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company,
        contact_name: $("ns-contact-name").value.trim(),
        contact_number: $("ns-contact-number").value.trim(),
        whatsapp_number: $("ns-whatsapp").value.trim(),
        notes: $("ns-notes").value.trim(),
        machines,
      }),
    });
    toast(`Service slip ${slip.slip_number} created`, "ok");
    showSlipCreated(slip);
  } catch (e) {
    $("ns-status").innerHTML = statusErr(e.message);
  } finally {
    $("ns-submit").disabled = false;
  }
}

// After a slip is registered: show its number with Share (PDF) + Done actions.
function showSlipCreated(slip) {
  const panel = $("ns-created");
  if (!panel) { setTimeout(goHome, 1200); return; }
  panel.style.display = "block";
  panel.innerHTML = `
    <div class="created-card">
      <div class="created-check">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <div class="created-title">Service slip ${escapeHtml(slip.slip_number)} created</div>
      <div class="created-sub">${escapeHtml(slip.company)} · ${slip.machines.length} machine(s)</div>
      <button class="btn-primary" id="ns-share" style="width:100%;margin-top:14px;">Share slip (PDF)</button>
      <button class="btn-secondary" id="ns-done" style="width:100%;margin-top:8px;">Done</button>
    </div>`;
  // Hide the form bits while the success card is up
  $("ns-status").innerHTML = "";
  $("ns-share").addEventListener("click", () => shareSlipPdf(slip));
  $("ns-done").addEventListener("click", goHome);
  window.scrollTo(0, 0);
}

// Build the service-slip PDF (jsPDF) and return a Blob.
function buildSlipPdf(slip) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const left = 48;
  let y = 56;

  doc.setFontSize(20); doc.setFont("helvetica", "bold");
  doc.text("Outboard & Marine (Pte) Ltd", left, y);
  y += 22;
  doc.setFontSize(13); doc.setFont("helvetica", "normal");
  doc.text("Service Slip", left, y);

  // Slip number, top-right
  doc.setFontSize(16); doc.setFont("helvetica", "bold");
  doc.text(`S/S: ${slip.slip_number}`, 547, 56, { align: "right" });

  y += 26;
  doc.setDrawColor(200); doc.line(left, y, 547, y); y += 24;

  doc.setFontSize(11); doc.setFont("helvetica", "normal");
  const created = formatDate(slip.created_at) || "";
  const rows = [
    ["Date", created],
    ["Company", slip.company || ""],
    ["Contact", slip.contact_name || ""],
    ["Contact No.", slip.contact_number || ""],
  ];
  for (const [label, val] of rows) {
    doc.setFont("helvetica", "bold"); doc.text(`${label}:`, left, y);
    doc.setFont("helvetica", "normal"); doc.text(String(val), left + 90, y);
    y += 20;
  }

  y += 8;
  doc.setFont("helvetica", "bold"); doc.text("Machines received:", left, y); y += 20;
  doc.setFont("helvetica", "normal");
  (slip.machines || []).forEach((m, i) => {
    doc.text(`${i + 1}.  ${m.machine_desc}`, left + 10, y);
    y += 18;
  });

  if (slip.notes) {
    y += 8;
    doc.setFont("helvetica", "bold"); doc.text("Notes:", left, y); y += 18;
    doc.setFont("helvetica", "normal");
    const wrapped = doc.splitTextToSize(slip.notes, 499);
    doc.text(wrapped, left, y); y += wrapped.length * 16;
  }

  y += 16;
  doc.setDrawColor(200); doc.line(left, y, 547, y); y += 18;
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text("Please quote your service slip number when enquiring about your machines.", left, y);

  return doc.output("blob");
}

// Share the PDF via the device's native share sheet (WhatsApp/email/AirDrop),
// falling back to a plain download where sharing files isn't supported.
async function shareSlipPdf(slip) {
  let blob;
  try {
    blob = buildSlipPdf(slip);
  } catch (e) {
    toast("Couldn't build PDF: " + e.message, "err");
    return;
  }
  const filename = `ServiceSlip_${slip.slip_number}.pdf`;
  const file = new File([blob], filename, { type: "application/pdf" });

  // Native file share (mobile): includes WhatsApp, Mail, AirDrop, etc.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `Service Slip ${slip.slip_number}` });
      return;
    } catch (_) { /* user cancelled or share failed — fall through to download */ }
  }

  // Fallback: trigger a download (desktop, or browsers without file share).
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function statusErr(m) { return `<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> ${escapeHtml(m)}`; }
function statusInfo(m) { return `<span class="led"></span> ${escapeHtml(m)}`; }
function statusOk(m) { return `<span class="led" style="background:#38A32A;box-shadow:0 0 0 3px rgba(56,163,42,.18)"></span> ${escapeHtml(m)}`; }

// ============================================================================
// OPEN SERVICE
// ============================================================================
let openSearch = null;
async function enterOpenService() {
  showScreen("open");
  $("os-machine-field").style.display = "none";
  $("os-tech-field").style.display = "none";
  $("os-entry").style.display = "none";
  $("footer-open").style.display = "none";
  session.slipNumber = null; session.slip = null; session.machineId = null; session.technician = "";

  if (!openSearch) {
    openSearch = setupSlipSearch({
      inputId: "os-search", resultsId: "os-results", scope: "active",
      onPick: (slipNumber) => onSlipChosen(slipNumber),
    });
  }
  openSearch.reset();
}

async function onSlipChosen(slipNumber) {
  if (!slipNumber) {
    $("os-machine-field").style.display = "none";
    $("os-tech-field").style.display = "none";
    $("os-entry").style.display = "none";
    $("footer-open").style.display = "none";
    return;
  }
  try {
    const slip = await api(`/api/slips/${encodeURIComponent(slipNumber)}`);
    session.slipNumber = slipNumber;
    session.slip = slip;
    session.machineId = null;

    // Populate machine dropdown
    const msel = $("os-machine");
    msel.innerHTML = `<option value="">Select a machine…</option>` +
      slip.machines.map((m) => `<option value="${m.id}">${escapeHtml(m.machine_desc)}</option>`).join("");
    $("os-machine-field").style.display = "block";
    // Tech + entry hidden until machine chosen
    $("os-tech-field").style.display = "none";
    $("os-entry").style.display = "none";
    updateSlipFooter();
  } catch (e) {
    toast(e.message, "err");
  }
}

async function onMachineChosen(machineId) {
  // Save the comment for the machine we're leaving (if any) before switching.
  await saveCurrentComment();

  session.machineId = machineId ? Number(machineId) : null;
  if (!session.machineId) {
    $("os-tech-field").style.display = "none";
    $("os-entry").style.display = "none";
    return;
  }
  // Show technician picker (carries over if already chosen)
  $("os-tech-field").style.display = "block";
  if (session.technician) $("os-tech").value = session.technician;
  // Load this machine's existing comment into the textbox.
  loadCommentForCurrentMachine();
  maybeShowEntry();
  renderMachineParts();
}

// Load the saved comment for the currently selected machine into the textbox.
function loadCommentForCurrentMachine() {
  const box = $("os-comment");
  if (!box) return;
  const m = currentMachine();
  box.value = (m && m.repair_comment) ? m.repair_comment : "";
}

// Save the textbox comment to whichever machine is currently selected.
// Used when switching machines, creating the SO, or leaving the screen.
async function saveCurrentComment() {
  const box = $("os-comment");
  if (!box || !session.machineId) return;
  const m = currentMachine();
  const current = box.value;
  // Skip the network call if nothing changed.
  if (m && (m.repair_comment || "") === current) return;
  try {
    await api(`/api/machines/${session.machineId}/comment`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: current }),
    });
    if (m) m.repair_comment = current; // keep local copy in sync
  } catch (e) {
    toast("Couldn't save comment: " + e.message, "err");
  }
}

function onTechChosen(tech) {
  session.technician = tech || "";
  maybeShowEntry();
}

function maybeShowEntry() {
  const ready = session.slipNumber && session.machineId && session.technician;
  $("os-entry").style.display = ready ? "block" : "none";
  $("footer-open").style.display = ready ? "flex" : "none";
  if (ready) {
    setMode(currentMode || "upload");
    renderContext();
    renderMachineParts();
    updateSlipFooter();
  }
}

function renderContext() {
  const m = session.slip.machines.find((x) => x.id === session.machineId);
  const created = formatDate(session.slip.created_at);
  $("os-context").innerHTML =
    `<div><strong>${escapeHtml(session.slip.company)}</strong> · Slip ${escapeHtml(session.slipNumber)}</div>` +
    `<div class="sub">Machine: ${escapeHtml(m ? m.machine_desc : "")} · Tech: ${escapeHtml(session.technician)}</div>` +
    (created ? `<div class="sub">Created: ${escapeHtml(created)}</div>` : "");
}

// The scanned-part entry point. Replaces the old local-cart addByCode:
// looks up the item, then SAVES it to the current machine on the server.
async function addByCode(code) {
  code = (code || "").trim();
  if (!code) return;
  if (!session.machineId || !session.technician) {
    toast("Pick a machine and your name first", "err");
    return;
  }
  try {
    const item = await lookupItem(code);
    await api(`/api/machines/${session.machineId}/parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_code: item.item_code,
        description: item.description,
        uom: item.uom,
        unit_price: item.unit_price,
        quantity: 1,
        technician: session.technician,
      }),
    });
    toast(`Added ${item.description}`, "ok");
    await refreshSlip();
    renderMachineParts();
    updateSlipFooter();
  } catch (e) {
    toast(e.message, "err");
  }
}

async function refreshSlip() {
  if (!session.slipNumber) return;
  // Preserve whatever the technician has typed in the comment box for the
  // current machine, so a part-scan refresh doesn't wipe an unsaved comment.
  const box = $("os-comment");
  const unsaved = (box && session.machineId) ? box.value : null;

  session.slip = await api(`/api/slips/${encodeURIComponent(session.slipNumber)}`);

  if (unsaved !== null) {
    const m = currentMachine();
    if (m) m.repair_comment = unsaved; // keep local copy aligned with the box
  }
}

const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';

function currentMachine() {
  if (!session.slip) return null;
  return session.slip.machines.find((m) => m.id === session.machineId) || null;
}

function renderMachineParts() {
  const wrap = $("machine-parts");
  const machine = currentMachine();
  const parts = machine ? (machine.parts || []) : [];
  wrap.innerHTML = "";

  if (parts.length === 0) {
    wrap.innerHTML = `
      <div class="cart-empty">
        <div class="ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="#1f6f78" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>
        </div>
        <strong>No parts yet</strong>
        <span>Scan or type a part to add it to this machine.</span>
      </div>`;
    return;
  }

  for (const p of parts) {
    const el = document.createElement("div");
    el.className = "line";
    el.innerHTML = `
      <div class="head">
        <div class="info">
          <div class="desc">${escapeHtml(p.description)}</div>
          <div class="sku mono">${escapeHtml(p.item_code)} · ${escapeHtml(p.technician || "")}</div>
        </div>
        <div class="price-col">
          <span class="price">${money(p.unit_price)}</span>
          <button class="remove" data-del="${p.id}" aria-label="Remove part">${TRASH}</button>
        </div>
      </div>
      <div class="foot">
        <div class="qty">
          <button data-dec="${p.id}" aria-label="Decrease">−</button>
          <input type="number" min="1" value="${p.quantity}" data-qty="${p.id}" inputmode="numeric" aria-label="Quantity" />
          <button data-inc="${p.id}" aria-label="Increase">+</button>
        </div>
        <div class="amt-wrap">
          <span class="amt-lbl">Line total</span>
          <span class="amt">${money(p.unit_price * p.quantity)}</span>
        </div>
      </div>`;
    wrap.appendChild(el);
  }
}

async function setPartQty(partId, qty) {
  try {
    await api(`/api/parts/${partId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: qty }),
    });
    await refreshSlip();
    renderMachineParts();
    updateSlipFooter();
  } catch (e) {
    toast(e.message, "err");
  }
}

function updateSlipFooter() {
  if (!session.slip) return;

  // Slip number
  $("os-slip-badge").textContent = session.slipNumber || "—";

  // Current machine model + its total cost
  const machine = currentMachine();
  const machineName = machine ? machine.machine_desc : "—";
  let machineTotal = 0;
  let machineParts = 0;
  if (machine) {
    for (const p of (machine.parts || [])) {
      machineTotal += p.unit_price * p.quantity;
      machineParts++;
    }
  }
  $("os-machine-name").textContent = machineName;
  $("os-machine-total").textContent = money(machineTotal);

  // The Create Sales Order button covers the whole slip, so enable it whenever
  // any machine on the slip has parts (not just the current one).
  let slipParts = 0;
  for (const m of session.slip.machines) for (const p of (m.parts || [])) slipParts++;
  $("os-create-so").disabled = slipParts === 0;
}

async function createSalesOrder() {
  if (!session.slipNumber) return;
  $("os-create-so").disabled = true;
  // Persist the current machine's comment first (per the agreed save-on-SO behaviour).
  await saveCurrentComment();
  try {
    const result = await api(`/api/slips/${encodeURIComponent(session.slipNumber)}/order`, { method: "POST" });
    toast(`Sales Order ${result.so_number} created (${result.ss_line})`, "ok");
    setTimeout(goHome, 1600);
  } catch (e) {
    toast(e.message, "err");
    $("os-create-so").disabled = false;
  }
}

// ============================================================================
// CLOSE SERVICE
// ============================================================================
let closeSearch = null;
let csPickedSlip = null; // currently selected slip number in Close Service
async function enterCloseService() {
  showScreen("close");
  $("cs-context").style.display = "none";
  $("cs-ref").value = "";
  $("cs-status").innerHTML = "";
  csPickedSlip = null;

  if (!closeSearch) {
    closeSearch = setupSlipSearch({
      inputId: "cs-search", resultsId: "cs-results", scope: "active",
      onPick: (slipNumber) => onCloseSlipChosen(slipNumber),
    });
  }
  closeSearch.reset();
}

async function onCloseSlipChosen(slipNumber) {
  csPickedSlip = slipNumber || null;
  if (!slipNumber) { $("cs-context").style.display = "none"; return; }
  try {
    const slip = await api(`/api/slips/${encodeURIComponent(slipNumber)}`);
    $("cs-context").style.display = "block";
    $("cs-context").innerHTML =
      `<div><strong>${escapeHtml(slip.company)}</strong> · Slip ${escapeHtml(slip.slip_number)}</div>` +
      `<div class="sub">Status: ${escapeHtml(slip.status)} · ${slip.machines.length} machine(s)</div>` +
      (formatDate(slip.created_at) ? `<div class="sub">Created: ${escapeHtml(formatDate(slip.created_at))}</div>` : "");
  } catch (e) {
    toast(e.message, "err");
  }
}

async function submitClose() {
  const slipNumber = csPickedSlip;
  const ref = $("cs-ref").value.trim();
  if (!slipNumber) { $("cs-status").innerHTML = statusErr("Pick a slip to close."); return; }
  if (!ref) { $("cs-status").innerHTML = statusErr("Enter the DO/CS/INV number."); return; }

  $("cs-submit").disabled = true;
  $("cs-status").innerHTML = statusInfo("Closing…");
  try {
    await api(`/api/slips/${encodeURIComponent(slipNumber)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closing_ref: ref }),
    });
    toast(`Slip ${slipNumber} closed`, "ok");
    $("cs-status").innerHTML = statusOk(`Closed ${slipNumber}. Returning home…`);
    setTimeout(goHome, 1400);
  } catch (e) {
    $("cs-status").innerHTML = statusErr(e.message);
  } finally {
    $("cs-submit").disabled = false;
  }
}

// ============================================================================
// VIEW SLIPS (read-only)
// ============================================================================
let viewSearch = null;
async function enterViewSlips() {
  showScreen("view");
  $("vs-detail").innerHTML = "";
  if (!viewSearch) {
    viewSearch = setupSlipSearch({
      inputId: "vs-search", resultsId: "vs-results", scope: "all",
      onPick: (slipNumber) => onViewSlipChosen(slipNumber),
    });
  }
  viewSearch.reset();
}

async function onViewSlipChosen(slipNumber) {
  const wrap = $("vs-detail");
  if (!slipNumber) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<div class="slip-context"><span class="led"></span> Loading…</div>`;
  try {
    const slip = await api(`/api/slips/${encodeURIComponent(slipNumber)}`);
    wrap.innerHTML = renderSlipDetail(slip);
  } catch (e) {
    wrap.innerHTML = "";
    toast(e.message, "err");
  }
}

function renderSlipDetail(slip) {
  // Header block: customer + meta
  let slipQty = 0, slipAmount = 0, slipParts = 0;
  for (const m of slip.machines) {
    for (const p of (m.parts || [])) { slipQty += p.quantity; slipAmount += p.unit_price * p.quantity; slipParts++; }
  }

  const meta = [];
  if (slip.contact_name) meta.push(`Contact: ${escapeHtml(slip.contact_name)}`);
  if (slip.contact_number) meta.push(escapeHtml(slip.contact_number));

  let html = `
    <div class="vs-card">
      <div class="vs-head">
        <div>
          <div class="vs-company">${escapeHtml(slip.company)}</div>
          <div class="vs-sub">Slip ${escapeHtml(slip.slip_number)} · Created ${escapeHtml(formatDate(slip.created_at))}</div>
        </div>
        <span class="vs-status vs-${escapeAttr(slip.status)}">${escapeHtml(STATUS_LABEL[slip.status] || slip.status)}</span>
      </div>
      ${meta.length ? `<div class="vs-sub">${meta.join(" · ")}</div>` : ""}
      ${slip.notes ? `<div class="vs-notes">${escapeHtml(slip.notes)}</div>` : ""}
      ${slip.status === "CLOSED" && slip.closing_ref ? `<div class="vs-sub">Closed with: <strong>${escapeHtml(slip.closing_ref)}</strong>${slip.closed_at ? " on " + escapeHtml(formatDate(slip.closed_at)) : ""}</div>` : ""}
    </div>`;

  // Each machine + its parts
  for (const m of slip.machines) {
    const parts = m.parts || [];
    let mQty = 0, mAmount = 0;
    for (const p of parts) { mQty += p.quantity; mAmount += p.unit_price * p.quantity; }

    html += `
      <div class="vs-machine">
        <div class="vs-machine-name">${escapeHtml(m.machine_desc)}</div>`;

    if (m.repair_comment) {
      html += `<div class="vs-comment">${escapeHtml(m.repair_comment)}</div>`;
    }

    if (parts.length === 0) {
      html += `<div class="vs-sub" style="padding:6px 0;">No parts recorded.</div>`;
    } else {
      for (const p of parts) {
        html += `
          <div class="vs-part">
            <div class="vs-part-info">
              <div class="vs-part-desc">${escapeHtml(p.description)}</div>
              <div class="vs-part-sku mono">${escapeHtml(p.item_code)}${p.technician ? " · " + escapeHtml(p.technician) : ""}</div>
            </div>
            <div class="vs-part-amt">
              <div>${escapeHtml(String(p.quantity))} × ${money(p.unit_price)}</div>
              <div class="vs-part-line">${money(p.unit_price * p.quantity)}</div>
            </div>
          </div>`;
      }
      html += `<div class="vs-machine-total">Machine total: <strong>${money(mAmount)}</strong> (${mQty} qty)</div>`;
    }
    html += `</div>`;
  }

  // Slip total
  html += `
    <div class="vs-grand">
      <span>${slipParts} part${slipParts === 1 ? "" : "s"} · ${slipQty} qty across ${slip.machines.length} machine${slip.machines.length === 1 ? "" : "s"}</span>
      <strong>${money(slipAmount)}</strong>
    </div>`;

  return html;
}

// ---- Scanner ---------------------------------------------------------------
function scanStatus(html) { const el = $("scan-status"); if (el) el.innerHTML = html; }

// Scanner engine: prefer the device's native BarcodeDetector (fast, accurate on
// Code 128 — great on Android), fall back to ZXing (covers iPhone Safari).
let videoStream = null;
let detectLoop = null;
let zxingReader = null;
let torchOn = false;
// Double-read confirm: hold the last candidate; only accept on a second matching read.
let pendingCode = null;

const STATUS_READY = '<span class="led"></span> Point at a barcode — tap the view to focus';
const STATUS_BLOCKED = '<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Camera blocked — switch to Type code';

async function startScanner() {
  await stopScanner();
  const video = $("reader-video");
  if (!video) { scanStatus(STATUS_BLOCKED); return; }

  try {
    // Ask for a high-resolution rear camera with continuous autofocus tuned for
    // close-up labels — sharper frames lock far faster, especially up close.
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        focusMode: { ideal: "continuous" },
        // Nudge focus toward a near distance (macro) so a close label snaps sharp
        // quickly instead of hunting across the whole range. Ignored if unsupported.
        focusDistance: { ideal: 0.12 },
        advanced: [{ focusMode: "continuous" }, { focusDistance: 0.12 }],
      },
      audio: false,
    });
    video.srcObject = videoStream;
    video.setAttribute("playsinline", "true");
    await video.play();
    scanStatus(STATUS_READY);
    updateTorchButton();
    applyFocusTuning();
  } catch (e) {
    // Retry with a basic request if the constrained one was rejected.
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, audio: false,
      });
      video.srcObject = videoStream;
      video.setAttribute("playsinline", "true");
      await video.play();
      scanStatus(STATUS_READY);
      updateTorchButton();
      applyFocusTuning();
    } catch (e2) {
      scanStatus(STATUS_BLOCKED);
      return;
    }
  }

  // Path 1: native BarcodeDetector (Chrome/Android, some others)
  if ("BarcodeDetector" in window) {
    try {
      const detector = new window.BarcodeDetector({
        formats: ["code_128", "code_39", "qr_code", "ean_13"],
      });
      const tick = async () => {
        if (!videoStream) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) onScanCandidate(codes[0].rawValue);
        } catch (_) {}
        detectLoop = requestAnimationFrame(tick);
      };
      detectLoop = requestAnimationFrame(tick);
      return;
    } catch (_) {
      // fall through to ZXing
    }
  }

  // Path 2: ZXing fallback (iPhone Safari, browsers without BarcodeDetector)
  if (window.ZXingBrowser) {
    try {
      zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
      zxingReader.decodeFromVideoElement(video, (result) => {
        if (result) onScanCandidate(result.getText());
      });
      return;
    } catch (_) {}
  }

  // Camera works but no decoder engine is available — guide to manual entry.
  scanStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Scanner not supported here — use Type code');
}

// Torch / flashlight — helps in dim storeroom lighting. Supported on most
// Android Chrome; quietly hidden where the device/browser can't do it.
function torchTrack() {
  if (!videoStream) return null;
  const track = videoStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return null;
  const caps = track.getCapabilities();
  return caps && caps.torch ? track : null;
}
function updateTorchButton() {
  const btn = $("torch-btn");
  if (!btn) return;
  btn.style.display = torchTrack() ? "flex" : "none";
  btn.classList.toggle("on", torchOn);
}
async function toggleTorch() {
  const track = torchTrack();
  if (!track) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (_) {}
  updateTorchButton();
}

// Focus tuning: after the stream starts, apply continuous + near focus if the
// device exposes those capabilities (constraints in getUserMedia are best-effort,
// so we re-apply here where capabilities are actually known).
function applyFocusTuning() {
  if (!videoStream) return;
  const track = videoStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  let caps = {};
  try { caps = track.getCapabilities() || {}; } catch (_) { return; }
  const advanced = [];
  if (caps.focusMode && caps.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
  }
  if (caps.focusDistance) {
    // Aim near the close end of the supported range for label-distance focus.
    const near = caps.focusDistance.min +
      (caps.focusDistance.max - caps.focusDistance.min) * 0.15;
    advanced.push({ focusDistance: near });
  }
  if (advanced.length) {
    track.applyConstraints({ advanced }).catch(() => {});
  }
}

// Tap-to-focus: tapping the preview forces a quick single-shot refocus on the
// label, then returns to continuous — useful when auto-focus is hunting.
async function tapToFocus() {
  if (!videoStream) return;
  const track = videoStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  let caps = {};
  try { caps = track.getCapabilities() || {}; } catch (_) { return; }
  if (!caps.focusMode) return;
  try {
    if (caps.focusMode.includes("single-shot")) {
      await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
      // Briefly hold single-shot, then restore continuous for ongoing scanning.
      setTimeout(() => {
        if (caps.focusMode.includes("continuous")) {
          track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
        }
      }, 1200);
    } else if (caps.focusMode.includes("manual") && caps.focusDistance) {
      const near = caps.focusDistance.min +
        (caps.focusDistance.max - caps.focusDistance.min) * 0.12;
      await track.applyConstraints({ advanced: [{ focusMode: "manual", focusDistance: near }] });
    }
    // Quick visual pulse so the user knows the tap registered.
    const frame = $("reader-video");
    if (frame) { frame.classList.add("focus-pulse"); setTimeout(() => frame.classList.remove("focus-pulse"), 350); }
  } catch (_) {}
}

async function stopScanner() {
  if (detectLoop) { cancelAnimationFrame(detectLoop); detectLoop = null; }
  if (zxingReader) { try { zxingReader.reset(); } catch (_) {} zxingReader = null; }
  if (videoStream) {
    // Turn torch off before releasing, so it doesn't stay lit.
    try {
      const t = videoStream.getVideoTracks()[0];
      if (torchOn && t) t.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    } catch (_) {}
    try { videoStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    videoStream = null;
  }
  torchOn = false;
  pendingCode = null;
  const video = $("reader-video");
  if (video) { try { video.srcObject = null; } catch (_) {} }
}

// Double-read confirm: a code must be seen twice in a row before we accept it.
// This kills one-frame misreads (e.g. a wrong number from a blurry frame).
function onScanCandidate(text) {
  if (!text) return;
  if (scanCooldown) return;
  if (text === pendingCode) {
    pendingCode = null;
    onScan(text);
  } else {
    pendingCode = text;
  }
}

function onScan(decodedText) {
  if (scanCooldown) return;
  if (!decodedText) return;
  scanCooldown = true;
  pendingCode = null;
  scanStatus(`<span class="led"></span> Scanned ${escapeHtml(decodedText)}`);
  addByCode(decodedText);
  setTimeout(() => (scanCooldown = false), 1500);
}

// ---- QR live scanner (QR codes only) ---------------------------------------
// Reuses the same proven approach as the barcode scanner (native BarcodeDetector,
// ZXing fallback) but locked to qr_code, into its own #qr-video element.
let qrStream = null;
let qrDetectLoop = null;
let qrZxingReader = null;
let qrCooldown = false;
let qrPending = null;

function qrStatus(html) { const el = $("qr-status"); if (el) el.innerHTML = html; }

async function startQrScanner() {
  await stopQrScanner();
  const video = $("qr-video");
  if (!video) return;

  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    video.srcObject = qrStream;
    video.setAttribute("playsinline", "true");
    await video.play();
    qrStatus('<span class="led"></span> Point at a QR code');
  } catch (e) {
    qrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Camera blocked — switch to Type code');
    return;
  }

  // Path 1: native / polyfilled BarcodeDetector, QR only
  if ("BarcodeDetector" in window) {
    try {
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!qrStream) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) onQrCandidate(codes[0].rawValue);
        } catch (_) {}
        qrDetectLoop = requestAnimationFrame(tick);
      };
      qrDetectLoop = requestAnimationFrame(tick);
      return;
    } catch (_) {}
  }

  // Path 2: ZXing fallback
  if (window.ZXingBrowser) {
    try {
      qrZxingReader = new ZXingBrowser.BrowserQRCodeReader
        ? new ZXingBrowser.BrowserQRCodeReader()
        : new ZXingBrowser.BrowserMultiFormatReader();
      qrZxingReader.decodeFromVideoElement(video, (result) => {
        if (result) onQrCandidate(result.getText());
      });
      return;
    } catch (_) {}
  }

  qrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Scanner not supported here — use Type code');
}

async function stopQrScanner() {
  if (qrDetectLoop) { cancelAnimationFrame(qrDetectLoop); qrDetectLoop = null; }
  if (qrZxingReader) { try { qrZxingReader.reset(); } catch (_) {} qrZxingReader = null; }
  if (qrStream) {
    try { qrStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    qrStream = null;
  }
  qrPending = null;
  const video = $("qr-video");
  if (video) { try { video.srcObject = null; } catch (_) {} }
}

// Double-read confirm (kills one-frame misreads), same pattern as the barcode path.
function onQrCandidate(text) {
  if (!text || qrCooldown) return;
  if (text === qrPending) { qrPending = null; onQrScan(text); }
  else qrPending = text;
}
function onQrScan(text) {
  if (qrCooldown || !text) return;
  qrCooldown = true;
  qrPending = null;
  qrStatus(`<span class="led"></span> Scanned ${escapeHtml(text)}`);
  addByCode(text);
  setTimeout(() => (qrCooldown = false), 1500);
}

// ---- OCR mode (read the printed SKU text on damaged labels) -----------------
// Reuses a camera stream into #ocr-video; on capture, Tesseract reads the frame,
// then we pull out the first BRAND+number token (e.g. "SZEN 140051111").
let ocrStream = null;
let ocrBusy = false;

function ocrStatus(html) { $("ocr-status").innerHTML = html; }

async function startOcrCamera() {
  await stopOcrCamera();
  const video = $("ocr-video");
  if (!video) return;
  try {
    ocrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = ocrStream;
    video.setAttribute("playsinline", "true");
    await video.play();
    ocrStatus('<span class="led"></span> Frame the printed code, then tap Read');
  } catch (e) {
    ocrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Camera blocked — switch to Type code');
  }
}

async function stopOcrCamera() {
  if (ocrStream) {
    try { ocrStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    ocrStream = null;
  }
  const video = $("ocr-video");
  if (video) { try { video.srcObject = null; } catch (_) {} }
}

// Pull a SKU-shaped token out of raw OCR text: a brand prefix (letters) followed
// by a long number (e.g. "SZEN 140051111"). OM SKUs have a 5+ digit run, so this
// ignores short rack/bin codes like "BK3410" or "R3D6" that share the label.
// OCR sometimes confuses letters/digits inside the number — we fix the common ones.
function fixDigits(s) {
  return s
    .replace(/O/g, "0").replace(/Q/g, "0").replace(/D/g, "0")
    .replace(/I/g, "1").replace(/L/g, "1")
    .replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2").replace(/G/g, "6");
}
function extractSku(text) {
  if (!text) return null;
  const cleaned = text.toUpperCase().replace(/[^A-Z0-9 \n]/g, " ");
  // Allow the "number" part to contain OCR-confused letters; we repair them after.
  const matches = [...cleaned.matchAll(/([A-Z]{2,6})\s*([0-9OQDILSBZG]{5,12})/g)];
  if (!matches.length) return null;
  // Prefer the candidate with the longest run — that's the real part number.
  matches.sort((a, b) => b[2].length - a[2].length);
  const brand = matches[0][1];
  const number = fixDigits(matches[0][2]);
  return brand + " " + number;
}

async function captureAndRead() {
  if (ocrBusy) return;
  const video = $("ocr-video");
  if (!video || !ocrStream) { ocrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Camera not ready'); return; }
  if (!window.Tesseract) { ocrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Text reader still loading — try again'); return; }

  ocrBusy = true;
  ocrStatus('<span class="led"></span> Reading…');

  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;

  // Crop to a central horizontal band — the user aims the SKU line into the guide.
  // This drops the surrounding label noise (barcode, rack codes) so OCR focuses
  // only on the printed part number. Band = full width, middle ~28% of height.
  const bandH = Math.round(vh * 0.28);
  const bandY = Math.round((vh - bandH) / 2);

  // Upscale 2x — Tesseract is far more accurate on larger characters.
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = vw * scale;
  canvas.height = bandH * scale;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, bandY, vw, bandH, 0, 0, canvas.width, canvas.height);

  // Grayscale + contrast boost so crisp black text pops from the label background.
  try {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Soft threshold: push toward black/white without going fully binary.
      const v = g < 110 ? Math.max(0, g - 40) : Math.min(255, g + 40);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  } catch (_) { /* if getImageData is blocked, proceed with the colour crop */ }

  try {
    const { data } = await Tesseract.recognize(canvas, "eng", {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
      // PSM 6 = treat the image as a single uniform block of text (one line band).
      tessedit_pageseg_mode: "6",
    });
    const raw = (data && data.text ? data.text : "").trim();
    const sku = extractSku(raw);
    if (sku) {
      ocrStatus(`<span class="led"></span> Read ${escapeHtml(sku)}`);
      addByCode(sku);
    } else {
      ocrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> No code found — line the text up in the guide and try again');
    }
  } catch (e) {
    ocrStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Could not read — try again');
  } finally {
    ocrBusy = false;
  }
}

// ---- Mode toggle (part-entry methods within Open Service) -------------------
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("#mode-toggle button").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === mode)
  );

  const uploadPane = $("upload-pane");
  if (uploadPane) uploadPane.style.display = mode === "upload" ? "block" : "none";
  const qrPane = $("qr-pane");
  if (qrPane) qrPane.style.display = mode === "qr" ? "flex" : "none";
  const manualPane = $("manual-pane");
  if (manualPane) manualPane.style.display = mode === "manual" ? "block" : "none";

  if (mode === "qr") startQrScanner();
  else stopQrScanner();
  if (mode === "manual") { const ci = $("code-input"); if (ci) ci.focus(); }
}

// ---- Event wiring ----------------------------------------------------------
// Home navigation
document.querySelectorAll(".home-btn").forEach((b) =>
  b.addEventListener("click", () => {
    const go = b.dataset.go;
    if (go === "new") { resetNewServiceForm(); showScreen("new"); }
    else if (go === "open") { enterOpenService(); }
    else if (go === "close") { enterCloseService(); }
    else if (go === "view") { enterViewSlips(); }
  })
);
$("home-link").addEventListener("click", goHome);

// New Service
$("ns-add-machine").addEventListener("click", () => addMachineRow());
$("ns-submit").addEventListener("click", submitNewService);
// "Same as contact number" convenience for the WhatsApp field
$("ns-whatsapp-same").addEventListener("change", (e) => {
  const wa = $("ns-whatsapp");
  if (e.target.checked) {
    wa.value = $("ns-contact-number").value.trim();
    wa.setAttribute("disabled", "true");
  } else {
    wa.removeAttribute("disabled");
  }
});

// Open Service: slip selection via search component; machine/tech selects + SO button
$("os-machine").addEventListener("change", (e) => onMachineChosen(e.target.value));
$("os-tech").addEventListener("change", (e) => onTechChosen(e.target.value));
$("os-create-so").addEventListener("click", createSalesOrder);

// Mode toggle buttons
document.querySelectorAll("#mode-toggle button").forEach((b) =>
  b.addEventListener("click", () => setMode(b.dataset.mode))
);

// Manual entry
$("lookup-btn").addEventListener("click", () => {
  addByCode($("code-input").value);
  $("code-input").value = "";
  $("code-input").focus();
});
$("code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { addByCode($("code-input").value); $("code-input").value = ""; }
});

// QR restart
const _qrRst = $("qr-restart"); if (_qrRst) _qrRst.addEventListener("click", startQrScanner);

// Machine-parts list interactions (event delegation)
$("machine-parts").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  const inc = e.target.closest("[data-inc]");
  const dec = e.target.closest("[data-dec]");
  if (del) setPartQty(Number(del.dataset.del), 0);
  else if (inc) {
    const id = Number(inc.dataset.inc);
    const m = currentMachine();
    const p = m && m.parts.find((x) => x.id === id);
    if (p) setPartQty(id, p.quantity + 1);
  } else if (dec) {
    const id = Number(dec.dataset.dec);
    const m = currentMachine();
    const p = m && m.parts.find((x) => x.id === id);
    if (p) setPartQty(id, Math.max(0, p.quantity - 1));
  }
});
$("machine-parts").addEventListener("change", (e) => {
  if (e.target.dataset.qty) {
    const q = Math.max(0, parseInt(e.target.value, 10) || 0);
    setPartQty(Number(e.target.dataset.qty), q);
  }
});

// Close Service: slip selection via search component
$("cs-submit").addEventListener("click", submitClose);

// View Slips: slip selection via search component

// Batch upload (defined in batch-upload.js -> handleBatchFiles)
$("batch-input").addEventListener("change", (e) => {
  handleBatchFiles(e.target.files);
  e.target.value = "";
});

// ---- Boot ------------------------------------------------------------------
showScreen("home");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
