(function() {
  'use strict';
  const P = window.Persephone;

  const { DEFAULT_SKIP_KEYWORDS } = P;

  let _containerIdSeq = 0;

  /**
   * Get or create a stable ID for a DOM container element.
   * Used to key Sets/Maps instead of element references (which break on DOM rebuild).
   */
  function getContainerId(el) {
    if (!el) return null;
    let id = el.getAttribute('data-persephone-id');
    if (!id) {
      id = 'p-' + (++_containerIdSeq);
      el.setAttribute('data-persephone-id', id);
    }
    return id;
  }

  const state = {
    // Settings (loaded from storage)
    extensionEnabled: true,
    autoSendFirstChunk: true,
    splitThreshold: 250,
    firstChunkWordLimit: 42,
    autoSubmitVoice: false,
    autoSendSkipKeywords: [...DEFAULT_SKIP_KEYWORDS],

    // Streaming detection
    currentStreamingContainer: null,
    lastContainerCount: 0,
    streamingLocks: new Set(),  // Set<containerId> — prevents re-entrant processing per container

    // Tracking maps
    seenTexts: new Set(),
    sentMessages: new Map(),       // element -> { messageId, text, isMultiPart }
    sentByHash: new Map(),         // textHash -> { messageId, text, isMultiPart }

    // Container tracking (keyed by container ID string, not element reference)
    autoSentContainers: new Set(),       // Set<containerId> — containers that had auto-send
    activeStreamingObservers: new Set(), // Set<containerId> — containers with active observers
    containerQuestions: new Map(),       // Map<containerId, questionText>

    // Media
    screenshotStream: null,
    screenshotVideo: null,
    pendingScreenshots: [],
    micRecording: false,

    // Health check
    healthCheckWarned: false,
  };

  // --- Exports ---
  Object.assign(P, { getContainerId, state });
})();
