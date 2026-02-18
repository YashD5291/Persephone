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

  /**
   * Capture a frame from the active screenshot stream and return as a Blob.
   * Uses ImageCapture API for native-resolution grab, falls back to canvas.
   */
  async function captureFrame() {
    if (!state.screenshotStream) return null;

    const track = state.screenshotStream.getVideoTracks()[0];
    if (!track) return null;

    // Try ImageCapture.grabFrame() — gets raw frame at native resolution
    try {
      const imageCapture = new ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      log.screenshot(`📸 Capture resolution: ${bitmap.width}×${bitmap.height}`);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } catch (e) {
      log.screenshot.warn('📸 ImageCapture failed, using video fallback:', e.message);
    }

    // Fallback: draw from video element
    if (!state.screenshotVideo) return null;
    const canvas = document.createElement('canvas');
    canvas.width = state.screenshotVideo.videoWidth;
    canvas.height = state.screenshotVideo.videoHeight;
    log.screenshot(`📸 Capture resolution (fallback): ${canvas.width}×${canvas.height}`);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(state.screenshotVideo, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
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
        const clipItem = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([clipItem]);
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
    const btn = document.querySelector('.persephone-camera-btn');
    if (btn) btn.classList.remove('stream-active');
    log.screenshot('📸 Stream stopped');
  }

  /**
   * Handle camera button click.
   * First click: prompt user to select a window (getDisplayMedia).
   * Subsequent clicks: capture frame instantly from the existing stream.
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
      showToast('Window selected — click again to capture');
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
    btn.title = 'Screenshot capture (Alt+click to stop)';
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
    handleScreenshotClick, injectScreenshotButton
  });
})();
