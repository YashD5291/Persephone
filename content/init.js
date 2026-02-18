(function() {
  'use strict';
  const P = window.Persephone;

  const {
    SITE, MSG, DEFAULT_SKIP_KEYWORDS, log, state, sel, isContextValid, isElementStreaming, 
    getResponseScope, runSelectorHealthCheck, healthCheckWithToast, scanAllResponses, 
    removeAllButtons, processContainer, checkForNewResponse, startGlobalObserver, sendToTelegram, 
    editInTelegram, showToast, triggerPreconnect, loadSettings, toggleExtensionEnabled, 
    showExtensionIndicator, toggleAutoSend, showAutoSendIndicator, updateWidgetStates, 
    injectStyles, injectMicButton, injectSettingsWidget, injectScreenshotButton, handleMicClick, 
    insertTextAndSubmit, dataUrlToBlob, pasteScreenshotIntoChat
  } = P;

  // ============================================
  // DIAGNOSTIC DUMP
  // ============================================

  /**
   * Dump all internal state to the console for debugging.
   * Triggered by Cmd/Ctrl+Shift+D.
   */
  function dumpDiagnostics() {
    const containers = sel.queryAll('responseContainer');
    const health = runSelectorHealthCheck();

    const dump = {
      site: SITE,
      timestamp: new Date().toISOString(),

      settings: {
        extensionEnabled: state.extensionEnabled,
        autoSendFirstChunk: state.autoSendFirstChunk,
        splitThreshold: state.splitThreshold,
        firstChunkWordLimit: state.firstChunkWordLimit,
        autoSubmitVoice: state.autoSubmitVoice,
        autoSendSkipKeywords: state.autoSendSkipKeywords,
      },

      streaming: {
        currentStreamingContainer: state.currentStreamingContainer
          ? { connected: state.currentStreamingContainer.isConnected, streaming: isElementStreaming(state.currentStreamingContainer) }
          : null,
        lastContainerCount: state.lastContainerCount,
        actualContainerCount: containers.length,
        streamingLocks: [...state.streamingLocks],
      },

      tracking: {
        seenTextsSize: state.seenTexts.size,
        sentByHashSize: state.sentByHash.size,
        sentByHashKeys: [...state.sentByHash.keys()],
        sentMessagesSize: state.sentMessages.size,
        pendingScreenshots: state.pendingScreenshots.length,
      },

      media: {
        screenshotStreamActive: !!state.screenshotStream,
        micRecording: state.micRecording,
      },

      selectors: health.results.map(c => ({
        name: c.name,
        count: c.count,
        ok: c.ok,
        critical: c.critical,
      })),

      contextValid: isContextValid(),
    };

    console.group('[Persephone] Diagnostic Dump');
    console.log(JSON.stringify(dump, null, 2));
    console.groupEnd();

    console.group('[Persephone] Recent Log Entries (last 50)');
    const recent = log.getRecent(50);
    recent.forEach(entry => {
      const time = new Date(entry.ts).toLocaleTimeString();
      const prefix = `${time} [${entry.cat}:${entry.lvl}]`;
      console.log(prefix, entry.msg);
    });
    console.groupEnd();

    showToast('Diagnostic dump written to console (Cmd+Opt+J to view)');
  }

  // ============================================
  // INIT
  // ============================================

  async function init() {
    log.init('🚀 Persephone v3.8 (with screenshot capture)');

    injectStyles();
    injectMicButton();
    injectSettingsWidget();
    injectScreenshotButton();

    // Load settings — await so observers start with correct state
    await loadSettings();

    // Trigger API preconnect immediately
    triggerPreconnect();

    // Paste queued screenshots when tab becomes visible (Claude background tab workaround)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.pendingScreenshots.length > 0) {
        const queued = state.pendingScreenshots.splice(0);
        log.screenshot(`📸 Tab visible — pasting ${queued.length} queued screenshot(s)`);
        // Small delay to let the tab fully activate and framework initialize
        setTimeout(async () => {
          for (const blob of queued) {
            const ok = await pasteScreenshotIntoChat(blob, {
              focusInput: true,
              writeClipboard: false
            });
            log.screenshot(ok ? '📸 Queued screenshot pasted' : '📸 Queued screenshot paste failed');
            if (ok) showToast('Screenshot pasted');
          }
        }, 300);
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Alt/Option+M - Toggle MacWhisper mic
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        handleMicClick();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
        // Cmd/Ctrl+Shift+E - Toggle extension
        if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          toggleExtensionEnabled();
        }
        // Cmd/Ctrl+Shift+A - Toggle auto-send
        if (e.key.toLowerCase() === 'a') {
          e.preventDefault();
          toggleAutoSend();
        }
        // Cmd/Ctrl+Shift+D - Diagnostic dump
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault();
          dumpDiagnostics();
        }
      }
    });

    // Listen for messages from popup and background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      // Synchronous response required — must return true
      if (request.type === MSG.GET_AUTO_SEND_STATE) {
        sendResponse({ autoSend: state.autoSendFirstChunk, site: SITE });
        return false;
      }
      if (request.type === MSG.EXTENSION_ENABLED_CHANGED) {
        state.extensionEnabled = request.extensionEnabled;
        showExtensionIndicator(state.extensionEnabled);
        if (state.extensionEnabled) {
          scanAllResponses();
        } else {
          removeAllButtons();
        }
        updateWidgetStates();
      }
      if (request.type === MSG.AUTO_SEND_CHANGED) {
        state.autoSendFirstChunk = request.autoSendFirstChunk;
        showAutoSendIndicator(state.autoSendFirstChunk);
        updateWidgetStates();
      }
      if (request.type === MSG.SKIP_KEYWORDS_CHANGED) {
        state.autoSendSkipKeywords = request.keywords || [...DEFAULT_SKIP_KEYWORDS];
        log.state.debug(`📝 Skip keywords updated: ${state.autoSendSkipKeywords.length} keywords`);
      }
      if (request.type === MSG.SPLIT_THRESHOLD_CHANGED) {
        state.splitThreshold = request.splitThreshold || 250;
        log.state.debug(`📝 Split threshold updated: ${state.splitThreshold}`);
        updateWidgetStates();
      }
      if (request.type === MSG.FIRST_CHUNK_WORD_LIMIT_CHANGED) {
        state.firstChunkWordLimit = request.firstChunkWordLimit || 42;
        log.state.debug(`📝 First chunk word limit updated: ${state.firstChunkWordLimit}`);
        updateWidgetStates();
      }
      if (request.type === MSG.AUTO_SUBMIT_VOICE_CHANGED) {
        state.autoSubmitVoice = request.autoSubmitVoice === true;
        log.voice.debug(`🎙️ Auto-submit voice: ${state.autoSubmitVoice ? 'ON' : 'OFF'}`);
        updateWidgetStates();
      }
      if (request.type === MSG.INSERT_AND_SUBMIT) {
        insertTextAndSubmit(request.text, { focusInput: false });
      }
      if (request.type === MSG.PASTE_SCREENSHOT) {
        const blob = dataUrlToBlob(request.dataUrl);

        // Background tabs: queue immediately. Synthetic paste is unreliable —
        // Claude rejects events entirely, Grok accepts them but Chrome throttles
        // rendering so DOM-based detection fails (causes double-paste).
        if (document.visibilityState !== 'visible') {
          state.pendingScreenshots.push(blob);
          log.screenshot('📸 Screenshot queued — will paste when tab becomes visible');
          sendResponse({ success: true });
          return true;
        }

        pasteScreenshotIntoChat(blob, {
          focusInput: true,
          writeClipboard: false
        }).then((ok) => {
          log.screenshot(ok ? '📸 Screenshot pasted from broadcast' : '📸 Screenshot broadcast paste failed');
          sendResponse({ success: ok });
        });
        return true;
      }
      if (request.type === MSG.SET_AUTO_SEND_STATE) {
        state.autoSendFirstChunk = request.autoSend;
        showAutoSendIndicator(state.autoSendFirstChunk);
        updateWidgetStates();
      }
    });

    // Sync widget when settings change from another context (popup, other tab's widget)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;

      if (changes.extensionEnabled) {
        const val = changes.extensionEnabled.newValue !== false;
        if (val !== state.extensionEnabled) {
          state.extensionEnabled = val;
          if (val) { scanAllResponses(); } else { removeAllButtons(); }
        }
      }
      if (changes.autoSubmitVoice) {
        state.autoSubmitVoice = changes.autoSubmitVoice.newValue === true;
      }
      if (changes.splitThreshold) {
        state.splitThreshold = changes.splitThreshold.newValue || 250;
      }
      if (changes.firstChunkWordLimit) {
        state.firstChunkWordLimit = changes.firstChunkWordLimit.newValue || 42;
      }
      updateWidgetStates();
    });

    // Set initial container count to avoid auto-sending existing responses
    const existingContainers = sel.queryAll('responseContainer');
    state.lastContainerCount = existingContainers.length;

    const count = scanAllResponses();
    log.init(`📋 Initial scan: ${count} buttons added, ${state.lastContainerCount} existing responses`);

    // Run selector health check after initial scan
    healthCheckWithToast();

    // Start global observer for immediate detection of new responses
    startGlobalObserver();

    // Fallback polling (MutationObserver is primary; this is a safety net)
    let lastPollCheck = 0;
    let healthCheckRuns = 0;
    setInterval(() => {
      scanAllResponses();
      const now = Date.now();
      if (now - lastPollCheck >= 2000) {
        lastPollCheck = now;
        checkForNewResponse();
      }
      // Re-run health check every ~30s (15th run of 2s interval)
      healthCheckRuns++;
      if (healthCheckRuns % 15 === 0) {
        healthCheckWithToast();
      }
    }, 2000);

    log.init('✅ Ready');
  }

  init();
})();
