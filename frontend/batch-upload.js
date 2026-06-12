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

// Pre-process a photo on a canvas before decoding: phone photos are huge (12MP)
// and the decoder does BETTER on a moderately sized, contrast-boosted image.
// Downscale longest edge to ~1600px, bump contrast, return a new File.
async function preprocessImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const MAX = 1600;
    let { width, height } = bitmap;
    const scale = Math.min(1, MAX / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Light contrast stretch — helps slightly blurry / low-light barcode shots.
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    const contrast = 1.25; // 1 = no change
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] * contrast + intercept;
      d[i + 1] = d[i + 1] * contrast + intercept;
      d[i + 2] = d[i + 2] * contrast + intercept;
    }
    ctx.putImageData(img, 0, 0);

    const blob = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", 0.92)
    );
    if (!blob) return file; // fall back to the original if toBlob failed
    return new File([blob], file.name, { type: "image/jpeg" });
  } catch (_) {
    return file; // any failure: just decode the original photo
  }
}

// Decode a single (already pre-processed) image file. Returns decoded text or null.
async function decodeOneImage(file) {
  const decoder = getFileDecoder();
  try {
    // scanFileV2 returns { decodedText, result }; scanFile returns a string.
    if (typeof decoder.scanFileV2 === "function") {
      const out = await decoder.scanFileV2(file, false);
      return out && out.decodedText ? out.decodedText : null;
    }
    const text = await decoder.scanFile(file, false);
    return text || null;
  } catch (_) {
    return null; // library throws when no barcode is found — treat as a miss
  }
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
    const prepped = await preprocessImage(original);
    const code = await decodeOneImage(prepped);
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
