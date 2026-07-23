(function() {
  'use strict';
  const P = window.Persephone;

  const { state, log, MSG, SITE, delay } = P;

  // Late-bound (defined in modules that load after this one):
  const findChatInputWithRetry = (...args) => P.findChatInputWithRetry(...args);
  const getComposerRoot = (...args) => P.getComposerRoot(...args);
  const getAttachmentSignalCount = (...args) => P.getAttachmentSignalCount(...args);
  const placeCaretAtEnd = (...args) => P.placeCaretAtEnd(...args);
  const dispatchImagePaste = (...args) => P.dispatchImagePaste(...args);
  const dispatchImageDrop = (...args) => P.dispatchImageDrop(...args);
  const showToast = (...args) => P.showToast(...args);

  // ============================================
  // SCREENSHOT CAPTURE
  // ============================================

  /**
   * Convert a Blob to a data URL string for message passing.
   */
  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Re-encode any image blob to PNG (Chrome's clipboard only accepts image/png).
   */
  async function toPngBlob(blob) {
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  /**
   * Convert a data URL string back to a Blob.
   */
  function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
  }

  // ============================================
  // PURE HELPERS (unit-testable, no DOM/stream deps)
  // ============================================

  /** Clamp a JPEG quality value into the valid 0.1–1.0 range. */
  function clampQuality(q) {
    const n = Number(q);
    if (!Number.isFinite(n)) return 0.85;
    return Math.min(1, Math.max(0.1, n));
  }

  /**
   * Map a normalized crop region {x,y,w,h} (fractions 0–1) onto a source of the
   * given pixel dimensions. Returns an integer source rect clamped to bounds.
   * A null region means "whole frame".
   */
  function computeCropRect(region, width, height) {
    if (!region) return { sx: 0, sy: 0, sw: width, sh: height };
    let sx = Math.round(region.x * width);
    let sy = Math.round(region.y * height);
    let sw = Math.round(region.w * width);
    let sh = Math.round(region.h * height);
    sx = Math.max(0, Math.min(sx, width - 1));
    sy = Math.max(0, Math.min(sy, height - 1));
    sw = Math.max(1, Math.min(sw, width - sx));
    sh = Math.max(1, Math.min(sh, height - sy));
    return { sx, sy, sw, sh };
  }

  /**
   * Convert a drag rectangle (preview-pixel coords) into a normalized region.
   * Returns null when the drag is too small to be a deliberate selection.
   */
  function normalizedRectFromDrag(dragRect, previewW, previewH) {
    if (!previewW || !previewH) return null;
    const x = Math.min(dragRect.x0, dragRect.x1);
    const y = Math.min(dragRect.y0, dragRect.y1);
    const w = Math.abs(dragRect.x1 - dragRect.x0);
    const h = Math.abs(dragRect.y1 - dragRect.y0);
    if (w < 8 || h < 8) return null;
    return { x: x / previewW, y: y / previewH, w: w / previewW, h: h / previewH };
  }

  // ============================================
  // FRAME GRAB + ENCODE
  // ============================================

  /**
   * Grab a single raw frame from the active stream.
   * Returns { source, width, height, isBitmap } or null.
   * Prefers ImageCapture (native resolution), falls back to the video element.
   */
  async function grabFrameSource() {
    if (!state.screenshotStream) return null;

    const track = state.screenshotStream.getVideoTracks()[0];
    if (!track) return null;

    try {
      const imageCapture = new ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      return { source: bitmap, width: bitmap.width, height: bitmap.height, isBitmap: true };
    } catch (e) {
      log.screenshot.warn('📸 ImageCapture failed, using video fallback:', e.message);
    }

    if (!state.screenshotVideo) return null;
    return {
      source: state.screenshotVideo,
      width: state.screenshotVideo.videoWidth,
      height: state.screenshotVideo.videoHeight,
      isBitmap: false,
    };
  }

  /**
   * Crop the frame to `region` and encode as JPEG at `quality`.
   */
  function encodeFrameToBlob(frame, region, quality) {
    const { sx, sy, sw, sh } = computeCropRect(region, frame.width, frame.height);
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha channel — paint white first so any transparent pixels
    // don't render as black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(frame.source, sx, sy, sw, sh, 0, 0, sw, sh);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }

  /**
   * Capture a frame from the active stream, cropped to the saved region and
   * encoded as JPEG at the current quality setting. Returns a Blob.
   */
  async function captureFrame() {
    const frame = await grabFrameSource();
    if (!frame) return null;

    const region = state.screenshotCropRegion;
    const quality = clampQuality(state.screenshotJpegQuality);
    log.screenshot(`📸 Capture ${frame.width}×${frame.height}${region ? ' (cropped)' : ''} @ q${quality}`);

    const blob = await encodeFrameToBlob(frame, region, quality);
    if (frame.isBitmap && frame.source.close) frame.source.close();
    return blob;
  }

  /**
   * Show a full-page overlay with a snapshot of the shared window and let the
   * user drag a rectangle to define the crop region.
   * Resolves with:
   *   - {x,y,w,h} normalized region  → set as the new region
   *   - null                         → explicit full-frame (Enter)
   *   - undefined                    → cancelled / no change (Esc or tiny drag)
   */
  async function defineCropRegion() {
    const frame = await grabFrameSource();
    if (!frame) {
      showToast('Could not read the shared window');
      return undefined;
    }

    // Render the grabbed frame to a preview image (compressed — preview only).
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = frame.width;
    previewCanvas.height = frame.height;
    previewCanvas.getContext('2d').drawImage(frame.source, 0, 0);
    if (frame.isBitmap && frame.source.close) frame.source.close();
    const previewUrl = previewCanvas.toDataURL('image/jpeg', 0.7);

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'persephone-crop-overlay';
      overlay.innerHTML = `
        <div class="persephone-crop-hint">Drag to select the region to capture · Enter = full window · Esc = cancel</div>
        <div class="persephone-crop-stage">
          <img class="persephone-crop-img" draggable="false">
          <div class="persephone-crop-sel" hidden></div>
        </div>`;
      overlay.querySelector('.persephone-crop-img').src = previewUrl;
      document.body.appendChild(overlay);

      const img = overlay.querySelector('.persephone-crop-img');
      const selBox = overlay.querySelector('.persephone-crop-sel');
      let dragging = false;
      let start = null;

      const imgRect = () => img.getBoundingClientRect();

      function updateBox(x, y, w, h) {
        selBox.style.left = x + 'px';
        selBox.style.top = y + 'px';
        selBox.style.width = w + 'px';
        selBox.style.height = h + 'px';
      }

      function cleanup(region) {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        overlay.remove();
        resolve(region);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(undefined); }
        if (e.key === 'Enter') { e.preventDefault(); cleanup(null); }
      }

      function onMove(e) {
        if (!dragging) return;
        const r = imgRect();
        const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
        const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
        updateBox(Math.min(start.x, cx), Math.min(start.y, cy), Math.abs(cx - start.x), Math.abs(cy - start.y));
      }

      function onUp(e) {
        if (!dragging) return;
        dragging = false;
        const r = imgRect();
        const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
        const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
        const region = normalizedRectFromDrag({ x0: start.x, y0: start.y, x1: cx, y1: cy }, r.width, r.height);
        // Too-small drag (region === null) is treated as a misclick → no change.
        cleanup(region === null ? undefined : region);
      }

      img.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r = imgRect();
        dragging = true;
        start = { x: e.clientX - r.left, y: e.clientY - r.top };
        selBox.hidden = false;
        updateBox(start.x, start.y, 0, 0);
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });

      document.addEventListener('keydown', onKey, true);
    });
  }

  /**
   * Paste a screenshot blob into the chat input via synthetic paste event.
   * Also writes to clipboard as fallback (user can Cmd+V).
   */
  async function pasteScreenshotIntoChat(blob, options = {}) {
    const focusInput = options.focusInput !== false;
    const writeClipboard = options.writeClipboard !== false;
    const allowHiddenInput = options.allowHiddenInput === true;
    const inputRetryAttempts = options.inputRetryAttempts || 5;
    const inputRetryDelayMs = options.inputRetryDelayMs || 120;

    // 1. Write to clipboard only from the initiating tab.
    if (writeClipboard) {
      try {
        // Chrome's async clipboard only accepts image/png, so write a PNG copy
        // for the Cmd+V fallback even when the capture itself is JPEG.
        const pngBlob = await toPngBlob(blob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      } catch (e) {
        log.screenshot.warn('📸 Clipboard write failed:', e.message);
      }
    }

    const input = await findChatInputWithRetry(inputRetryAttempts, inputRetryDelayMs, { allowHidden: allowHiddenInput });
    if (!input) {
      log.screenshot.warn('📸 Screenshot paste failed: chat input not found');
      return false;
    }
    const composerRoot = getComposerRoot(input);
    const beforeSignals = getAttachmentSignalCount(composerRoot);

    // Never force window focus; that can activate another tab.
    if (focusInput && document.visibilityState === 'visible' && document.hasFocus()) {
      input.focus();
      placeCaretAtEnd(input);
    }

    // 2. Attempt synthetic paste event
    try {
      dispatchImagePaste(input, blob);
      await delay(120);
      const afterPasteSignals = getAttachmentSignalCount(composerRoot);
      if (afterPasteSignals > beforeSignals) return true;

      // Claude in inactive tabs often ignores synthetic paste; try drop fallback.
      if (SITE === 'claude') {
        dispatchImageDrop(input, blob);
        await delay(160);
        const afterDropSignals = getAttachmentSignalCount(composerRoot);
        if (afterDropSignals > beforeSignals) return true;
      }

      // If we couldn't prove insertion, report failure so background can retry.
      return false;
    } catch (e) {
      log.screenshot.error('📸 Synthetic paste failed:', e.message);
      return false;
    }
  }

  /**
   * Stop the active screenshot stream and clean up.
   */
  function stopScreenshotStream() {
    if (state.screenshotStream) {
      state.screenshotStream.getTracks().forEach(t => t.stop());
      state.screenshotStream = null;
    }
    if (state.screenshotVideo) {
      state.screenshotVideo.remove();
      state.screenshotVideo = null;
    }
    // Region is tied to the shared window — clear it when the stream ends.
    state.screenshotCropRegion = null;
    const btn = document.querySelector('.persephone-camera-btn');
    if (btn) btn.classList.remove('stream-active');
    log.screenshot('📸 Stream stopped');
  }

  /**
   * Handle camera button click.
   * First click: pick a window (getDisplayMedia), then draw the crop region.
   * Subsequent clicks: capture instantly (cropped to the saved region).
   * Shift+click: re-open the region picker.
   * Alt+click: stop the active stream.
   */
  async function handleScreenshotClick(e) {
    const btn = document.querySelector('.persephone-camera-btn');

    // Alt+click to stop stream
    if (e.altKey && state.screenshotStream) {
      stopScreenshotStream();
      showToast('Screenshot stream stopped');
      return;
    }

    // If no active stream, start one
    if (!state.screenshotStream) {
      try {
        state.screenshotStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            frameRate: { ideal: 1 }
          }
        });
      } catch (err) {
        log.screenshot.warn('📸 getDisplayMedia cancelled or failed:', err.message);
        return;
      }

      // Create hidden video element
      state.screenshotVideo = document.createElement('video');
      state.screenshotVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;';
      state.screenshotVideo.srcObject = state.screenshotStream;
      state.screenshotVideo.muted = true;
      document.body.appendChild(state.screenshotVideo);

      // Wait for video to be ready
      await new Promise((resolve) => {
        state.screenshotVideo.onloadedmetadata = () => {
          state.screenshotVideo.play().then(resolve).catch(resolve);
        };
      });

      // Listen for user stopping the share from the Chrome bar
      state.screenshotStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenshotStream();
      });

      if (btn) btn.classList.add('stream-active');
      const trackSettings = state.screenshotStream.getVideoTracks()[0].getSettings();
      log.screenshot(`📸 Stream started — ${trackSettings.width}×${trackSettings.height} @ ${trackSettings.frameRate}fps`);

      // Let the user pick the region to capture from this window.
      showToast('Window selected — drag to pick a region');
      const region = await defineCropRegion();
      if (region !== undefined) state.screenshotCropRegion = region;
      showToast(state.screenshotCropRegion ? 'Region set — click to capture' : 'Full window — click to capture');
      return;
    }

    // Shift+click re-opens the region picker without capturing.
    if (e.shiftKey) {
      const region = await defineCropRegion();
      if (region !== undefined) state.screenshotCropRegion = region;
      showToast(state.screenshotCropRegion ? 'Region updated' : 'Full window — region cleared');
      return;
    }

    // Capture frame
    const blob = await captureFrame();
    if (!blob) {
      showToast('Screenshot capture failed');
      return;
    }

    // Brief pulse animation
    if (btn) {
      btn.classList.add('capturing');
      setTimeout(() => btn.classList.remove('capturing'), 300);
    }

    // Paste into chat
    await pasteScreenshotIntoChat(blob, {
      focusInput: true,
      writeClipboard: true
    });

    // Broadcast to other tabs (paste only, no submit)
    blobToDataUrl(blob).then(dataUrl => {
      try {
        chrome.runtime.sendMessage({ type: MSG.BROADCAST_SCREENSHOT, dataUrl })
          .catch(err => log.screenshot.error('📸 Broadcast error:', err));
      } catch (e) {
        log.screenshot.error('📸 Broadcast send threw:', e);
      }
    });

    showToast('Screenshot captured (Cmd+V to paste if needed)');
  }

  /**
   * Inject the floating camera button into the page.
   */
  function injectScreenshotButton() {
    if (document.querySelector('.persephone-camera-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'persephone-camera-btn';
    btn.title = 'Screenshot capture · Shift+click to re-pick region · Alt+click to stop';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z"/><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>`;

    // Prevent mousedown from stealing focus away from chat input
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    btn.addEventListener('click', handleScreenshotClick);

    document.body.appendChild(btn);
    log.screenshot('📸 Camera button injected');
  }

  // --- Exports ---
  Object.assign(P, {
    blobToDataUrl, dataUrlToBlob, captureFrame, pasteScreenshotIntoChat, stopScreenshotStream,
    handleScreenshotClick, injectScreenshotButton, defineCropRegion,
    clampQuality, computeCropRect, normalizedRectFromDrag
  });
})();
