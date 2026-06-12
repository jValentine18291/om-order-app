// ---- Mode toggle -----------------------------------------------------------
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("#mode-toggle button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );

  // Show/hide each pane (guard every lookup so one missing node can't halt the rest)
  const uploadPane = $("upload-pane");
  if (uploadPane) uploadPane.style.display = mode === "upload" ? "block" : "none";

  const scannerPane = $("scanner-pane");
  if (scannerPane) scannerPane.style.display = mode === "scan" ? "flex" : "none";

  const ocrPane = $("ocr-pane");
  if (ocrPane) ocrPane.style.display = mode === "ocr" ? "block" : "none";

  const manualPane = $("manual-pane");
  if (manualPane) manualPane.style.display = mode === "manual" ? "block" : "none";

  // Camera lifecycle: only the active camera mode runs.
  if (mode === "scan") { stopOcrCamera(); startScanner(); }
  else if (mode === "ocr") { stopScanner(); startOcrCamera(); }
  else { stopScanner(); stopOcrCamera(); } // upload + manual: both cameras off

  if (mode === "manual") $("code-input").focus();
}
