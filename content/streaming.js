(function() {
  'use strict';
  const P = window.Persephone;

  const {
    state, log, sel, SITE, getContainerId, isElementStreaming, getLatestUserQuestion, 
    shouldSkipAutoSend, processContainer, extractText, hashText, getResponseScope, MSG, 
    isContextValid, sendToTelegram, editInTelegram, streamEditTelegram, showToast, 
    createActionButtonGroup, triggerPreconnect
  } = P;

  /**
   * Check for new streaming response
   */
  function checkForNewResponse() {
    if (!state.extensionEnabled) return;

    const containers = sel.queryAll('responseContainer');
    if (containers.length === 0) return;

    const latest = containers[containers.length - 1];
    const containerId = getContainerId(latest);

    // Per-container lock: prevents re-entrant processing from overlapping callbacks
    if (state.streamingLocks.has(containerId)) return;
    state.streamingLocks.add(containerId);

    try {
      const isNewContainer = containers.length > state.lastContainerCount;
      const isStreaming = isElementStreaming(latest);

      // Detect new response (container count increased or new streaming on different container)
      if (isNewContainer || (isStreaming && latest !== state.currentStreamingContainer)) {
        state.lastContainerCount = containers.length;

        if (isStreaming) {
          log.streaming('⚡ Streaming response detected');
          state.currentStreamingContainer = latest;

          // Capture the user question for keyword skip checking
          const question = getLatestUserQuestion(latest);
          state.containerQuestions.set(containerId, question);
          if (question) log.streaming(`📝 Question: "${question.substring(0, 80)}"`);

          // Warm up connection immediately when streaming starts
          if (state.autoSendFirstChunk) {
            triggerPreconnect();
          }

          startStreamingObserver(latest);
        } else {
          state.currentStreamingContainer = latest;
          processContainer(latest);
        }
      }
    } finally {
      state.streamingLocks.delete(containerId);
    }
  }

  /**
   * Watch the entire page for new response containers (faster than polling)
   */
  function startGlobalObserver() {
    const mainContainer = document.body;
    let checkScheduled = false;

    const observer = new MutationObserver((mutations) => {
      // Quick check if any mutations might contain response content
      let shouldCheck = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) { // Element node
              // Check if this is or contains a response container
              if (SITE === 'claude'
                ? (node.classList?.contains('standard-markdown') ||
                   node.classList?.contains('progressive-markdown') ||
                   node.querySelector?.('.standard-markdown, .progressive-markdown') ||
                   node.matches?.('[data-is-streaming]') ||
                   node.querySelector?.('[data-is-streaming]'))
                : (node.classList?.contains('response-content-markdown') ||
                   node.querySelector?.('.response-content-markdown') ||
                   node.classList?.contains('items-start') ||
                   node.querySelector?.('.items-start'))) {
                shouldCheck = true;
                break;
              }
            }
          }
        }
        if (shouldCheck) break;
      }

      if (shouldCheck && !checkScheduled) {
        checkScheduled = true;
        queueMicrotask(() => {
          checkScheduled = false;
          checkForNewResponse();
        });
      }
    });

    observer.observe(mainContainer, {
      childList: true,
      subtree: true
    });

    log.ui('👁️ Global observer started');
  }

  /**
   * Watch a streaming response for new chunks
   */
  function startStreamingObserver(container) {
    // Prevent duplicate observers on the same container
    const containerId = getContainerId(container);
    if (state.activeStreamingObservers.has(containerId)) return;
    state.activeStreamingObservers.add(containerId);

    // Start live streaming the first chunk (runs independently)
    if (state.extensionEnabled && state.autoSendFirstChunk && !state.autoSentContainers.has(containerId)) {
      startLiveStream(container);
    }

    const observer = new MutationObserver(() => {
      processContainer(container);

      if (!isElementStreaming(container)) {
        log.streaming('✅ Streaming complete');
        observer.disconnect();
        state.activeStreamingObservers.delete(containerId);
        setTimeout(() => processContainer(container), 200);
      }
    });

    const observerOptions = {
      childList: true,
      subtree: true,
      characterData: true
    };
    // For Claude, also watch the data-is-streaming attribute to detect streaming end
    if (SITE === 'claude') {
      observerOptions.attributes = true;
      observerOptions.attributeFilter = ['data-is-streaming'];
    }
    observer.observe(container, observerOptions);

    // Initial processing
    processContainer(container);
  }

  // ============================================
  // LIVE STREAM FIRST CHUNK
  // ============================================

  /**
   * Fire-and-forget edit for live streaming (no await, suppresses errors)

  /**
   * Wait for the first content element in a container to have enough text.
   * Resolves with the element, or null if streaming ends first.
   */
  function waitForFirstElement(container, minChars) {
    return new Promise((resolve) => {
      let resolved = false;
      const contentSelector = 'p, h1, h2, h3, h4, h5, h6, pre, blockquote';

      // Find the first content element in the response scope (skips thinking)
      const findContent = () => {
        const scope = getResponseScope(container);
        if (!scope) return null; // Thinking in progress, response not started
        const candidates = scope.querySelectorAll(contentSelector);
        for (const el of candidates) {
          return el;
        }
        return null;
      };

      const startTime = Date.now();
      const check = () => {
        if (resolved) return;
        const el = findContent();
        if (el) {
          const text = extractText(el);
          if (text && text.length >= minChars) {
            resolved = true;
            resolve(el);
            return;
          }
        }
        if (!isElementStreaming(container)) {
          resolved = true;
          resolve(el || null);
          return;
        }
        // Safety: give up after 120s (thinking + web search can take a while)
        if (Date.now() - startTime > 120000) {
          resolved = true;
          resolve(el || null);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * Live stream the first chunk to Telegram.
   * Sends initial text immediately, then edits the message every 500ms as text grows.
   */
  async function startLiveStream(container) {
    // Check skip keywords
    const streamContainerId = getContainerId(container);
    const question = state.containerQuestions.get(streamContainerId) || '';
    if (shouldSkipAutoSend(question)) {
      log.streaming('⏭️ Skipping live stream: keyword match');
      state.autoSentContainers.add(streamContainerId);
      return;
    }

    // Mark immediately to prevent duplicates
    state.autoSentContainers.add(streamContainerId);

    // Wait for first content element with enough text
    const firstElement = await waitForFirstElement(container, 10);
    if (!firstElement) {
      log.streaming.warn('⚠️ Live stream: no content element found');
      return;
    }

    let lastSentText = extractText(firstElement);
    if (!lastSentText || lastSentText.length < 5) return;

    // Send initial text
    log.streaming('📡 Live stream: sending initial text...');
    const result = await sendToTelegram(lastSentText);

    if (!result.success) {
      log.streaming.warn('⚠️ Live stream: initial send failed');
      return;
    }

    const messageId = Array.isArray(result.messageId) ? result.messageId[0] : result.messageId;
    log.streaming(`📡 Live stream: started (msgId: ${messageId})`);

    // Show streaming indicator on the element
    firstElement.style.position = 'relative';
    const streamingIndicator = document.createElement('span');
    streamingIndicator.className = 'persephone-sent-indicator persephone-streaming';
    streamingIndicator.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
    streamingIndicator.title = 'Streaming to Telegram...';
    firstElement.appendChild(streamingIndicator);

    let streamFinalized = false;
    // Anchor: first ~50 chars of initial text, used to verify element identity
    const textAnchor = lastSentText.substring(0, 50);

    /**
     * Get the best available text for the first paragraph.
     * Tries: original element → new first <p> in container (after DOM rebuild) → lastSentText
     */
    const getFinalText = () => {
      const anchor = textAnchor.substring(0, 30);

      // 1. Try original element (works if still connected, or detached with frozen text)
      const origText = extractText(firstElement);
      if (origText && origText.startsWith(anchor)) {
        // If element is detached, text may be stale — check container for a fresher version
        if (!firstElement.isConnected) {
          const newFirst = container.querySelector('p, h1, h2, h3, h4, h5, h6, pre, blockquote');
          if (newFirst) {
            const newText = extractText(newFirst);
            if (newText && newText.startsWith(anchor)) {
              // New element has text that starts the same — use whichever is longer (more complete)
              return newText.length >= origText.length ? newText : origText;
            }
          }
        }
        return origText;
      }

      // 2. Original element is stale/reused — try container's current first <p>
      const newFirst = container.querySelector('p, h1, h2, h3, h4, h5, h6, pre, blockquote');
      if (newFirst) {
        const newText = extractText(newFirst);
        if (newText && newText.startsWith(anchor)) return newText;
      }

      // 3. Fall back to last streamed text
      return lastSentText;
    };

    // Finalize: final edit with full text (no splitting for first chunk), update maps, show buttons
    const finalize = async () => {
      if (streamFinalized) return;
      streamFinalized = true;
      clearInterval(streamInterval);
      clearInterval(stopCheckInterval);

      const finalText = getFinalText();
      if (!finalText || finalText.length < 5) return;

      // Store in maps BEFORE the async edit so DOM rebuild can find sent state
      const finalHash = hashText(finalText);
      const msgData = {
        messageId,
        text: finalText,
        isMultiPart: result.isMultiPart,
        status: 'pending'
      };
      state.sentByHash.set(finalHash, msgData);

      // First chunk is always sent in full — no split threshold
      if (finalText !== lastSentText) {
        const editOk = await editInTelegram(messageId, finalText);
        if (!editOk) {
          log.streaming.warn('⚠️ Live stream: final edit failed');
          state.sentByHash.delete(finalHash);
          return;
        }
      }
      msgData.status = 'sent';

      if (firstElement.isConnected) {
        state.sentMessages.set(firstElement, msgData);

        // Clean up streaming indicator, add action buttons
        const indicator = firstElement.querySelector('.persephone-streaming');
        if (indicator) indicator.remove();
        const btnGroup = createActionButtonGroup(firstElement);
        firstElement.appendChild(btnGroup);
      }

      log.streaming('📡 Live stream: finalized');
      showToast('✓ Streamed first chunk');
    };

    // Poll and edit every 500ms — stream raw text, no splitting mid-stream
    const anchor = textAnchor.substring(0, 30);
    const streamInterval = setInterval(() => {
      if (streamFinalized) return;

      const text = extractText(firstElement);
      if (!text || !text.startsWith(anchor) || text === lastSentText) return;

      lastSentText = text;
      streamEditTelegram(messageId, text);
    }, 500);

    // Watch for stop conditions (paragraph complete or streaming ended)
    const stopCheckInterval = setInterval(() => {
      if (streamFinalized) return;
      const containerDone = !isElementStreaming(container);
      const elementDone = !isElementStreaming(firstElement);
      if (containerDone || elementDone) {
        finalize();
      }
    }, 100);

    // Safety: finalize after 60 seconds no matter what
    setTimeout(() => finalize(), 60000);
  }

  // --- Exports ---
  Object.assign(P, {
    checkForNewResponse, startGlobalObserver, startStreamingObserver, startLiveStream
  });
})();
