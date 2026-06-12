// app.js — OM Order Entry
// State, scanning, lookup, cart, review, submit. No login. Mock backend.

const API = ""; // same origin (server hosts both API and static files)

// ---- State -----------------------------------------------------------------
const cart = []; // { item_code, barcode, description, brand, uom, unit_price, quantity }
// (scanner state handled in scanner section below)
let scanCooldown = false;
let currentMode = "scan";

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

// ---- Item lookup (mock master) ---------------------------------------------
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

// ---- Render cart -----------------------------------------------------------
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';

function renderCart() {
  const wrap = $("cart");
  wrap.innerHTML = "";

  if (cart.length === 0) {
    wrap.innerHTML = `
      <div class="cart-empty">
        <div class="ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="#1f6f78" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>
        </div>
        <strong>No parts yet</strong>
        <span>Scan a barcode or type a part number to get started.</span>
      </div>`;
  } else {
    for (const l of cart) {
      const el = document.createElement("div");
      el.className = "line";
      el.innerHTML = `
        <div class="head">
          <div class="info">
            <div class="desc">${escapeHtml(l.description)}</div>
            <div class="sku mono">${escapeHtml(l.item_code)}</div>
          </div>
          <div class="price-col">
            <span class="price">${money(l.unit_price)}</span>
            <button class="remove" data-remove="${escapeAttr(l.item_code)}" aria-label="Remove part">${TRASH}</button>
          </div>
        </div>
        <div class="foot">
          <div class="qty">
            <button data-dec="${escapeAttr(l.item_code)}" aria-label="Decrease">−</button>
            <input type="number" min="1" value="${l.quantity}" data-qty="${escapeAttr(l.item_code)}" inputmode="numeric" aria-label="Quantity" />
            <button data-inc="${escapeAttr(l.item_code)}" aria-label="Increase">+</button>
          </div>
          <div class="amt-wrap">
            <span class="amt-lbl">Line total</span>
            <span class="amt">${money(l.unit_price * l.quantity)}</span>
          </div>
        </div>
      `;
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

// ---- Render review ---------------------------------------------------------
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
    el.innerHTML = `
      <div>
        <div class="desc">${escapeHtml(l.description)}</div>
        <div class="sub"><span class="mono">${escapeHtml(l.item_code)}</span> · ${l.quantity} × ${money(l.unit_price)}</div>
      </div>
      <div class="amt">${money(amt)}</div>
    `;
    wrap.appendChild(el);
  }
  $("review-total").textContent = money(total);
  $("review-sub").textContent = `${cart.length} part${cart.length === 1 ? "" : "s"} · ${qty} total qty`;
}

// ---- Submit ----------------------------------------------------------------
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
  else if (currentMode === "ocr") startOcrCamera();
}

// ---- Scanner ---------------------------------------------------------------
function scanStatus(html) { $("scan-status").innerHTML = html; }

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

// ---- Mode toggle -----------------------------------------------------------
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("#mode-toggle button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );

  // Show/hide each pane. Every lookup is guarded so a missing node can never
  // halt the function partway (which would leave panes in a broken state).
  const uploadPane = $("upload-pane");
  if (uploadPane) uploadPane.style.display = mode === "upload" ? "block" : "none";

  const scanPane = $("scan-pane");
  if (scanPane) scanPane.style.display = mode === "scan" ? "flex" : "none";

  const ocrPane = $("ocr-pane");
  if (ocrPane) ocrPane.style.display = mode === "ocr" ? "flex" : "none";

  const manualPane = $("manual-pane");
  if (manualPane) manualPane.style.display = mode === "manual" ? "block" : "none";

  // Camera lifecycle: only the active camera mode runs; the others are stopped.
  if (mode === "scan") { stopOcrCamera(); startScanner(); }
  else if (mode === "ocr") { stopScanner(); startOcrCamera(); }
  else { stopScanner(); stopOcrCamera(); } // upload + manual: both cameras off

  if (mode === "manual") $("code-input").focus();
}

// ---- Escaping helpers ------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

// ---- Event wiring ----------------------------------------------------------
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
$("torch-btn").addEventListener("click", toggleTorch);
// Tap anywhere on the camera preview to force a refocus on the label.
(function () {
  const v = $("reader-video");
  if (v) v.addEventListener("click", tapToFocus);
})();
$("ocr-capture").addEventListener("click", captureAndRead);
$("ocr-restart").addEventListener("click", startOcrCamera);

// Cart interactions (event delegation; closest() handles taps on inner SVG)
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
  stopOcrCamera();
  renderReview();
  showScreen("review");
});
$("back-to-entry").addEventListener("click", () => {
  showScreen("entry");
  if (currentMode === "scan") startScanner();
  else if (currentMode === "ocr") startOcrCamera();
});
$("submit-btn").addEventListener("click", submitOrder);
$("new-order-btn").addEventListener("click", resetOrder);
document.getElementById("batch-input").addEventListener("change", (e) => {
  handleBatchFiles(e.target.files);
  e.target.value = "";
});
// ---- Boot ------------------------------------------------------------------
renderCart();
setMode("upload");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
