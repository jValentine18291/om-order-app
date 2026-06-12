// ============================================================================
// BATCH PHOTO UPLOAD  — decode multiple barcode photos at once, in the browser.
// Adds a third entry mode ("upload") which is the default on boot.
// Decodes each image with html5-qrcode's scanFileV2 (or scanFile fallback),
// adds every successful hit to the cart, and shows a popup with thumbnails of
// any photos that couldn't be read so the technician knows which to retake.
// Depends on existing app.js helpers: addByCode, escapeHtml, scanStatus(optional)
// ============================================================================

// One reusable Html5Qrcode instance for file decoding (separate from live scan).
let fileDecoder = null;
function getFileDecoder() {
  if (!fileDecoder) {
    // Lock to Code 128 — same as the live scanner — so it won't mis-read
    // and is faster (one format per image).
    const formats = [Html5QrcodeSupportedFormats.CODE_128];
    fileDecoder = new Html5Qrcode("file-decoder-region", {
      verbose: false,
      formatsToSupport: formats,
    });
  }
  return fileDecoder;
}

// Decode a single (already pre-processed) image file. Returns decoded text or null.
// Strategy: try the device's NATIVE BarcodeDetector first (same fast, accurate
// engine the live scanner uses — great on Android/Chrome). Where it's missing
// (notably iPhone Safari), fall back to html5-qrcode, trying several processed
// versions of the image (bigger scale, grayscale+contrast, small rotations) so
// glare and slight skew on real labels don't cause a miss.

let _nativeDetector = null;
async function getNativeDetector() {
  if (_nativeDetector) return _nativeDetector;
  // Not cached as "permanently unavailable": the polyfill loads its WASM engine
  // asynchronously, so an early call might miss it while a later one succeeds.
  try {
    if ("BarcodeDetector" in window) {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported && supported.includes("code_128")) {
        _nativeDetector = new window.BarcodeDetector({ formats: ["code_128"] });
      }
    }
  } catch (_) { _nativeDetector = null; }
  return _nativeDetector;
}

// Build an <img> element from a File (needed for BarcodeDetector + canvas work).
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ img, url }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img load failed")); };
    img.src = url;
  });
}

// Render an image to a canvas at a target longest-edge size, optional rotation
// (degrees) and optional grayscale+contrast. Returns the canvas.
function renderToCanvas(img, maxEdge, rotateDeg, grayContrast) {
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  const rad = (rotateDeg || 0) * Math.PI / 180;
  const canvas = document.createElement("canvas");
  // For 90/270 rotations swap dimensions; for small angles a square-ish bound is fine.
  if (rotateDeg === 90 || rotateDeg === 270) { canvas.width = h; canvas.height = w; }
  else { canvas.width = w; canvas.height = h; }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (rad) ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();

  if (grayContrast) {
    try {
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = id.data;
      const contrast = 1.6, intercept = 128 * (1 - contrast);
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = Math.max(0, Math.min(255, g * contrast + intercept));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(id, 0, 0);
    } catch (_) {}
  }
  return canvas;
}

async function decodeOneImage(file) {
  // ---- Attempt 1: native BarcodeDetector (fast + accurate where available) ----
  const native = await getNativeDetector();
  if (native) {
    try {
      const { img, url } = await fileToImage(file);
      try {
        // Try the full image, then a larger-rendered canvas if needed.
        for (const maxEdge of [2000, 3000]) {
          const canvas = renderToCanvas(img, maxEdge, 0, false);
          const codes = await native.detect(canvas);
          if (codes && codes.length && codes[0].rawValue) {
            return codes[0].rawValue;
          }
        }
      } finally { URL.revokeObjectURL(url); }
    } catch (_) {}
  }

  // ---- Attempt 2: html5-qrcode fallback, multiple processed variants ----------
  // iPhone Safari lands here. Try a sequence of renders that defeat glare/skew.
  const decoder = getFileDecoder();
  let imgObj = null;
  try { imgObj = await fileToImage(file); } catch (_) { imgObj = null; }

  if (imgObj) {
    const { img, url } = imgObj;
    try {
      const variants = [
        { maxEdge: 1600, rot: 0,  gc: false },
        { maxEdge: 2400, rot: 0,  gc: false },
        { maxEdge: 2400, rot: 0,  gc: true  },
        { maxEdge: 2400, rot: 5,  gc: true  },
        { maxEdge: 2400, rot: -5, gc: true  },
        { maxEdge: 2400, rot: 90, gc: false },
      ];
      for (const v of variants) {
        const canvas = renderToCanvas(img, v.maxEdge, v.rot, v.gc);
        const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));
        if (!blob) continue;
        const f = new File([blob], file.name, { type: "image/jpeg" });
        try {
          if (typeof decoder.scanFileV2 === "function") {
            const out = await decoder.scanFileV2(f, false);
            if (out && out.decodedText) return out.decodedText;
          } else {
            const text = await decoder.scanFile(f, false);
            if (text) return text;
          }
        } catch (_) { /* this variant missed; try the next */ }
      }
    } finally { URL.revokeObjectURL(url); }
  }

  return null; // every attempt missed
}

// Build a small object-URL thumbnail for a failed photo.
function makeThumb(file) {
  return URL.createObjectURL(file);
}

// Main handler: process every selected photo.
async function handleBatchFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const status = document.getElementById("upload-status");
  const failed = [];
  let added = 0;

  for (let i = 0; i < files.length; i++) {
    const original = files[i];
    if (status) {
      status.innerHTML =
        '<span class="led"></span> Reading photo ' +
        (i + 1) + " of " + files.length + "…";
    }
    const code = await decodeOneImage(original);
    if (code) {
      // Reuse the exact same add-to-cart path the scanner/manual entry use.
      // addByCode handles the /api/items lookup, qty bump, toast, etc.
      // It's async in the app; await so the count stays accurate.
      try {
        await addByCode(code);
      } catch (_) {}
      added++;
    } else {
      failed.push(original);
    }
  }

  if (status) {
    status.innerHTML =
      '<span class="led"></span> ' +
      added + " of " + files.length + " photo(s) read successfully.";
  }

  if (failed.length > 0) {
    showFailedPopup(failed, files.length);
  }
}

// Popup listing the unreadable photos as thumbnails so they can retake them.
function showFailedPopup(failedFiles, total) {
  // Clean up any previous popup + its object URLs first.
  closeFailedPopup();

  const overlay = document.createElement("div");
  overlay.className = "upload-modal-overlay";
  overlay.id = "upload-modal-overlay";

  const thumbs = failedFiles
    .map((f) => {
      const url = makeThumb(f);
      return (
        '<figure class="fail-thumb">' +
        '<img src="' + url + '" alt="' + escapeHtml(f.name) + '" />' +
        '<figcaption>' + escapeHtml(f.name) + "</figcaption>" +
        "</figure>"
      );
    })
    .join("");

  overlay.innerHTML =
    '<div class="upload-modal" role="dialog" aria-modal="true">' +
    '<div class="upload-modal-head">' +
    "<h3>Couldn't read " + failedFiles.length + " of " + total + " photo(s)</h3>" +
    '<p>Retake the photos below — fill the frame with the barcode and hold the phone parallel to the label.</p>' +
    "</div>" +
    '<div class="fail-grid">' + thumbs + "</div>" +
    '<div class="upload-modal-foot">' +
    '<button class="btn-primary" id="upload-modal-close">Got it</button>' +
    "</div>" +
    "</div>";

  document.body.appendChild(overlay);
  document
    .getElementById("upload-modal-close")
    .addEventListener("click", closeFailedPopup);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFailedPopup();
  });
}

function closeFailedPopup() {
  const existing = document.getElementById("upload-modal-overlay");
  if (!existing) return;
  // Revoke object URLs to avoid memory leaks.
  existing.querySelectorAll("img").forEach((img) => {
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  });
  existing.remove();
}
