// app.js — OM Order Entry
// State, scanning, lookup, cart, review, submit. No login. Mock backend.

const API = "";

const cart = [];
let scanner = null;
let scanCooldown = false;
let currentMode = "scan";

const $ = (id) => document.getElementById(id);
const money = (n) => "$" + (Number(n) || 0).toFixed(2);

const ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
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

function setSteps(active) {
  const order = ["entry", "review", "confirm"];
  const ai = order.indexOf(active);
  document.querySelectorAll("#steps .step").forEach((el) => {
    const i = order.indexOf(el.dataset.step);
    el.classList.toggle("active", i === ai);
    el.classList.toggle("done", i < ai);
  });
  document.querySelectorAll("#steps .bar").forEach((el, idx) => {
    el.classList.toggle("done", idx < ai);
  });
}

function showScreen(name) {
  ["entry", "review", "confirm"].forEach((s) => {
    $("screen-" + s).classList.toggle("active", s === name);
  });
  $("footer-entry").style.display = name === "entry" ? "flex" : "none";
  $("footer-review").style.display = name === "review" ? "flex" : "none";
  setSteps(name);
  window.scrollTo(0, 0);
}

async function lookupItem(code) {
  const res = await fetch(`${API}/api/items/${encodeURIComponent(code)}`);
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw new Error(error || "Lookup failed");
  }
  return res.json();
}

async function addByCode(code) {
  code = (code || "").trim();
  if (!code) return;
  try {
    const item = await lookupItem(code);
    addToCart(item);
    toast(`Added ${item.description}`, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

function addToCart(item) {
  const existing = cart.find((l) => l.item_code === item.item_code);
  if (existing) existing.quantity += 1;
  else cart.push({ ...item, quantity: 1 });
  renderCart();
}

function removeLine(code) {
  const i = cart.findIndex((l) => l.item_code === code);
  if (i >= 0) cart.splice(i, 1);
  renderCart();
}

function setQty(code, qty) {
  const line = cart.find((l) => l.item_code === code);
  if (!line) return;
  line.quantity = Math.max(1, parseInt(qty, 10) || 1);
  renderCart();
}

const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';

function renderCart() {
  const wrap = $("cart");
  wrap.innerHTML = "";
  if (cart.length === 0) {
    wrap.innerHTML = `<div class="cart-empty"><div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="#1f6f78" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg></div><strong>No parts yet</strong><span>Scan a barcode or type a part number to get started.</span></div>`;
  } else {
    for (const l of cart) {
      const el = document.createElement("div");
      el.className = "line";
      el.innerHTML = `<div class="head"><div class="info"><div class="desc">${escapeHtml(l.description)}</div><div class="sku mono">${escapeHtml(l.item_code)}</div></div><div class="price-col"><span class="price">${money(l.unit_price)}</span><button class="remove" data-remove="${escapeAttr(l.item_code)}" aria-label="Remove part">${TRASH}</button></div></div><div class="foot"><div class="qty"><button data-dec="${escapeAttr(l.item_code)}" aria-label="Decrease">−</button><input type="number" min="1" value="${l.quantity}" data-qty="${escapeAttr(l.item_code)}" inputmode="numeric" aria-label="Quantity" /><button data-inc="${escapeAttr(l.item_code)}" aria-label="Increase">+</button></div><div class="amt-wrap"><span class="amt-lbl">Line total</span><span class="amt">${money(l.unit_price * l.quantity)}</span></div></div>`;
      wrap.appendChild(el);
    }
  }
  updateSummary();
}

function updateSummary() {
  const lines = cart.length;
  const qty = cart.reduce((s, l) => s + l.quantity, 0);
  const total = cart.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  $("line-count").textContent = lines;
  $("qty-count").textContent = qty;
  $("entry-total").textContent = money(total);
  $("to-review-btn").disabled = lines === 0;
}

function renderReview() {
  const wrap = $("review-lines");
  wrap.innerHTML = "";
  let total = 0;
  let qty = 0;
  for (const l of cart) {
    const amt = l.unit_price * l.quantity;
    total += amt;
    qty += l.quantity;
    const el = document.createElement("div");
    el.className = "review-line";
    el.innerHTML = `<div><div class="desc">${escapeHtml(l.description)}</div><div class="sub"><span class="mono">${escapeHtml(l.item_code)}</span> · ${l.quantity} × ${money(l.unit_price)}</div></div><div class="amt">${money(amt)}</div>`;
    wrap.appendChild(el);
  }
  $("review-total").textContent = money(total);
  $("review-sub").textContent = `${cart.length} part${cart.length === 1 ? "" : "s"} · ${qty} total qty`;
}

async function submitOrder() {
  $("submit-btn").disabled = true;
  try {
    const payload = {
      notes: $("notes-input").value.trim(),
      lines: cart.map((l) => ({
        item_code: l.item_code,
        description: l.description,
        uom: l.uom,
        unit_price: l.unit_price,
        quantity: l.quantity,
      })),
    };
    const res = await fetch(`${API}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error || "Submit failed");
    }
    const data = await res.json();
    $("confirm-so").textContent = data.so_number;
    $("confirm-items").textContent = cart.length;
    $("confirm-qty").textContent = data.total_qty;
    $("confirm-amount").textContent = money(data.total_amount);
    showScreen("confirm");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    $("submit-btn").disabled = false;
  }
}

function resetOrder() {
  cart.length = 0;
  $("notes-input").value = "";
  $("code-input").value = "";
  renderCart();
  showScreen("entry");
  if (currentMode === "scan") startScanner();
}

function scanStatus(html) { $("scan-status").innerHTML = html; }

async function startScanner() {
  if (!window.Html5Qrcode) {
    scanStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Scanner unavailable — use Type code');
    return;
  }
  await stopScanner();
  const formats = [Html5QrcodeSupportedFormats.CODE_128];
  scanner = new Html5Qrcode("reader", { verbose: false, formatsToSupport: formats });
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 300, height: 110 } },
      onScan,
      () => {}
      );
    scanStatus('<span class="led"></span> Point the camera at a barcode');
  } catch (e) {
    scanStatus('<span class="led" style="background:var(--amber);box-shadow:0 0 0 3px var(--amber-tint)"></span> Camera blocked — switch to Type code');
  }
}

async function stopScanner() {
  if (scanner) {
    try { await scanner.stop(); } catch (_) {}
    try { await scanner.clear(); } catch (_) {}
    scanner = null;
  }
}

function onScan(decodedText) {
  if (scanCooldown) return;
  scanCooldown = true;
  scanStatus(`<span class="led"></span> Scanned ${escapeHtml(decodedText)}`);
  addByCode(decodedText);
  setTimeout(() => (scanCooldown = false), 1500);
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("#mode-toggle button").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === mode)
                                                           );
  $("scan-pane").style.display = mode === "scan" ? "flex" : "none";
  $("manual-pane").style.display = mode === "manual" ? "block" : "none";
  if (mode === "scan") startScanner();
  else { stopScanner(); $("code-input").focus(); }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

document.querySelectorAll("#mode-toggle button").forEach((b) =>
  b.addEventListener("click", () => setMode(b.dataset.mode))
                                                         );

$("lookup-btn").addEventListener("click", () => {
  addByCode($("code-input").value);
  $("code-input").value = "";
  $("code-input").focus();
});
$("code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addByCode($("code-input").value);
    $("code-input").value = "";
  }
});
$("scan-restart").addEventListener("click", startScanner);

$("cart").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  const inc = e.target.closest("[data-inc]");
  const dec = e.target.closest("[data-dec]");
  if (rm) removeLine(rm.dataset.remove);
  else if (inc) {
    const l = cart.find((x) => x.item_code === inc.dataset.inc);
    if (l) setQty(l.item_code, l.quantity + 1);
  } else if (dec) {
    const l = cart.find((x) => x.item_code === dec.dataset.dec);
    if (l) setQty(l.item_code, l.quantity - 1);
  }
});
$("cart").addEventListener("change", (e) => {
  if (e.target.dataset.qty) setQty(e.target.dataset.qty, e.target.value);
});

$("to-review-btn").addEventListener("click", () => {
  if (cart.length === 0) return;
  stopScanner();
  renderReview();
  showScreen("review");
});
$("back-to-entry").addEventListener("click", () => {
  showScreen("entry");
  if (currentMode === "scan") startScanner();
});
$("submit-btn").addEventListener("click", submitOrder);
$("new-order-btn").addEventListener("click", resetOrder);

renderCart();
setMode("scan");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
