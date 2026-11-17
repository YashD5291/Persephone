(function() {
  'use strict';
  const P = window.Persephone;

  const {
    state, log, sel, SITE, getContainerId, isElementStreaming, getLatestUserQuestion,
    shouldSkipAutoSend, processContainer, extractText, hashText,
    findFirstContentElement, MSG,
    isContextValid, sendToTelegram, editInTelegram, streamEditTelegram, showToast,
    createActionButtonGroup, triggerPreconnect, splitAtWordBoundary, createEditPacer
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

  // Shortest time between two edits of the Telegram message being streamed.
  // Telegram limits how often a chat can be written to; edits closer together
  // than this risk a "too many requests" pause that costs far more than it saves.
  const STREAM_EDIT_MIN_GAP_MS = 300;
  // Gap used for the rest of a message once Telegram has asked to slow down.
  const STREAM_EDIT_SLOW_GAP_MS = 1000;
  // How often to re-check for changes the observer might not report.
  const STREAM_SAFETY_CHECK_MS = 250;

  // A voice question older than this is not the one being answered now.
  const VOICE_TIMING_MAX_AGE_MS = 60000;

  /**
   * Report where the time went for a voice question, up to the first words
   * in Telegram. Logged once per question, so the pipeline can be measured on
   * every real question instead of with a stopwatch.
   *
   * `firstText` and `telegram` are `{ perf, epoch }` readings: dictation
   * marks are taken in this page (performance.now), live-text marks partly in
   * the background worker (Date.now), so each mode uses its own clock.
   */
  function reportVoiceTiming(firstText, telegram) {
    const timing = state.voiceTiming;
    state.voiceTiming = null;
    if (!timing) return;
    if (timing.mode === 'live') return reportLiveTiming(timing, firstText.epoch, telegram.epoch);

    if (!timing.submit || firstText.perf - timing.submit > VOICE_TIMING_MAX_AGE_MS) return;
    const ms = (from, to) => `${Math.round(to - from)}ms`;
    log.streaming(
      `⏱ stop click→key pressed ${ms(timing.clicked, timing.stop)}` +
      ` | key pressed→transcript ${ms(timing.stop, timing.transcript)}` +
      ` | transcript→submitted ${ms(timing.transcript, timing.submit)}` +
      ` | submitted→first words ${ms(timing.submit, firstText.perf)}` +
      ` | first words→Telegram ${ms(firstText.perf, telegram.perf)}` +
      ` | total ${ms(timing.clicked, telegram.perf)}`
    );
  }

  /**
   * Live text: the question was already typed when it was sent, so the
   * stages are the user's own press, the hand-over to Claude, Claude's time
   * to its first words, and Telegram.
   */
  function reportLiveTiming(timing, firstTextAt, telegramAt) {
    if (firstTextAt - timing.submittedAt > VOICE_TIMING_MAX_AGE_MS) return;

    const sentAt = timing.pressedAt ?? timing.submittedAt;
    const record = {
      at: new Date(telegramAt).toISOString(),
      // Last word heard -> send pressed: the user's own decision time.
      lastWordToSendMs: timing.lastTextAt != null ? Math.round(sentAt - timing.lastTextAt) : null,
      // Send pressed -> question handed to Claude (null when Enter was pressed in the tab).
      sendToSubmittedMs: timing.pressedAt != null ? Math.round(timing.submittedAt - timing.pressedAt) : null,
      submittedToFirstWordsMs: Math.round(firstTextAt - timing.submittedAt),
      firstWordsToTelegramMs: Math.round(telegramAt - firstTextAt),
      sendToTelegramMs: Math.round(telegramAt - sentAt),
    };
    const show = (value) => (value == null ? 'n/a' : `${value}ms`);
    log.streaming(
      `⏱ live: last word→send ${show(record.lastWordToSendMs)}` +
      ` | send→submitted ${show(record.sendToSubmittedMs)}` +
      ` | submitted→first words ${show(record.submittedToFirstWordsMs)}` +
      ` | first words→Telegram ${show(record.firstWordsToTelegramMs)}` +
      ` | send→Telegram ${show(record.sendToTelegramMs)}`
    );

    const seconds = (value) => (value / 1000).toFixed(1);
    const summary = `Telegram in ${seconds(record.sendToTelegramMs)} s (Claude ${seconds(record.submittedToFirstWordsMs)} s)`;
    if (isContextValid()) {
      try {
        chrome.runtime.sendMessage({ type: MSG.VOICE_TIMING, record, summary }).catch(() => {});
      } catch (e) {
        // The record is a convenience; never let it disturb the stream.
      }
    }
  }

  /**
   * Wait for the first content element in a container to have enough text.
   * Resolves with the element, or null if streaming ends first.
   */
  function waitForFirstElement(container, minChars) {
    return new Promise((resolve) => {
      let resolved = false;
      let pollTimer = null;
      const findContent = () => findFirstContentElement(container);

      const finish = (el) => {
        resolved = true;
        observer.disconnect();
        clearTimeout(pollTimer);
        resolve(el);
      };

      const startTime = Date.now();
      // `repoll` is false when called from the observer, so each change does
      // not start another timer chain.
      const check = (repoll) => {
        if (resolved) return;
        const el = findContent();
        if (el) {
          const text = extractText(el);
          if (text && text.length >= minChars) return finish(el);
        }
        if (!isElementStreaming(container)) return finish(el || null);
        // Safety: give up after 120s (thinking + web search can take a while)
        if (Date.now() - startTime > 120000) return finish(el || null);
        if (repoll) pollTimer = setTimeout(() => check(true), 50);
      };

      // The observer fires the instant text is added, and keeps firing in a
      // tab that is not in front, where Chrome slows the timer below to once
      // a second or worse. The timer stays as a safety net.
      const observer = new MutationObserver(() => check(false));
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      check(true);
    });
  }

  /**
   * Live stream the first chunk to Telegram.
   * Sends initial text immediately, then edits the message every 500ms as text grows.
   * Once 69 words are reached, splits into two Telegram messages:
   *   msg1 = first 69 words (finalized immediately), msg2 = remainder (continues streaming).
   */
  async function startLiveStream(container) {
    const WORD_SPLIT_THRESHOLD = state.firstChunkWordLimit;

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

    // Wait for the first text of the answer. Any text at all: Claude often
    // opens with a piece of only a few characters and then pauses for about a
    // second, and waiting for more would hold the whole message back that long.
    const firstElement = await waitForFirstElement(container, 1);
    if (!firstElement) {
      log.streaming.warn('⚠️ Live stream: no content element found');
      return;
    }

    let lastSentText = extractText(firstElement);
    if (!lastSentText) return;
    const firstText = { perf: performance.now(), epoch: Date.now() };

    // Send initial text
    log.streaming('📡 Live stream: sending initial text...');
    const result = await sendToTelegram(lastSentText);
    if (result.success) reportVoiceTiming(firstText, { perf: performance.now(), epoch: Date.now() });

    if (!result.success) {
      log.streaming.warn('⚠️ Live stream: initial send failed');
      return;
    }

    let activeMessageId = Array.isArray(result.messageId) ? result.messageId[0] : result.messageId;
    log.streaming(`📡 Live stream: started (msgId: ${activeMessageId})`);

    // Show streaming indicator on the element
    firstElement.style.position = 'relative';
    const streamingIndicator = document.createElement('span');
    streamingIndicator.className = 'persephone-sent-indicator persephone-streaming';
    streamingIndicator.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
    streamingIndicator.title = 'Streaming to Telegram...';
    firstElement.appendChild(streamingIndicator);

    let streamFinalized = false;
    let splitting = false;       // Gate to pause poll during async split
    let messages = [{ id: activeMessageId }]; // Array of sent telegram messages
    let frozenChunks = [];       // Text of each finalized chunk
    let lastSentActiveText = lastSentText; // Last text sent/edited to active (last) message

    // Anchor: how the paragraph starts, used to recognise it again after Claude
    // rebuilds its DOM. Plain text rather than the Telegram-formatted text,
    // because a bold word that is still being typed changes its markers
    // ("*Kaf*" then "*Kafka* is") while its plain text only grows.
    const ANCHOR_CHARS = 30;
    const plainText = (el) => (el?.textContent || '').trim();
    let anchor = plainText(firstElement).substring(0, ANCHOR_CHARS);
    const isSameParagraph = (el) => plainText(el).startsWith(anchor);
    // The first text can be a single word; lengthen the anchor as more arrives.
    const growAnchor = () => {
      if (anchor.length >= ANCHOR_CHARS || !firstElement.isConnected) return;
      const text = plainText(firstElement);
      if (text.startsWith(anchor)) anchor = text.substring(0, ANCHOR_CHARS);
    };

    /**
     * Split text into all WORD_SPLIT_THRESHOLD-word chunks.
     * Returns array where last element is the active (partial) chunk.
     */
    const splitAllChunks = (text) => {
      const chunks = [];
      let remaining = text;
      while (true) {
        const parts = splitAtWordBoundary(remaining, WORD_SPLIT_THRESHOLD);
        if (parts) {
          chunks.push(parts[0]);
          remaining = parts[1];
        } else {
          chunks.push(remaining);
          break;
        }
      }
      return chunks;
    };

    /**
     * Get the active (unfrozen) portion of text by skipping past frozen chunks.
     */
    const getActiveText = (fullText) => {
      let remaining = fullText;
      for (let i = 0; i < frozenChunks.length; i++) {
        const parts = splitAtWordBoundary(remaining, WORD_SPLIT_THRESHOLD);
        if (parts) {
          remaining = parts[1];
        } else {
          return '';
        }
      }
      return remaining;
    };

    /**
     * Get the best available text for the first paragraph.
     * Tries: original element → new first <p> in container (after DOM rebuild) → lastSentText
     */
    const getFinalText = () => {
      // 1. Try original element (works if still connected, or detached with frozen text)
      const origText = extractText(firstElement);
      if (origText && isSameParagraph(firstElement)) {
        // If element is detached, text may be stale — check container for a fresher version
        if (!firstElement.isConnected) {
          const newFirst = findFirstContentElement(container);
          if (newFirst && isSameParagraph(newFirst)) {
            const newText = extractText(newFirst);
            if (newText) return newText.length >= origText.length ? newText : origText;
          }
        }
        return origText;
      }

      // 2. Original element is stale/reused — try container's current first real content node
      const newFirst = findFirstContentElement(container);
      if (newFirst && isSameParagraph(newFirst)) {
        const newText = extractText(newFirst);
        if (newText) return newText;
      }

      // 3. Fall back to last streamed text
      return lastSentText;
    };

    /**
     * Perform splits: finalize chunks that exceed threshold, send new messages.
     * Handles multiple splits in one call if text grew past several thresholds.
     */
    const performSplit = async (currentText) => {
      const chunks = splitAllChunks(currentText);
      // chunks.length - 1 = number of finalized chunks needed
      // Process any new chunks beyond what we already have finalized
      const newFinalizedCount = chunks.length - 1;

      for (let i = frozenChunks.length; i < newFinalizedCount; i++) {
        const chunkText = chunks[i];
        const msgId = messages[i].id;

        log.streaming(`📡 Live stream: finalizing chunk ${i + 1} at ${WORD_SPLIT_THRESHOLD} words`);
        const editOk = await editInTelegram(msgId, chunkText);
        if (!editOk) {
          log.streaming.warn(`⚠️ Live stream: chunk ${i + 1} edit failed, stopping split`);
          return;
        }

        frozenChunks.push(chunkText);
        state.sentByHash.set(hashText(chunkText), {
          messageId: msgId,
          text: chunkText,
          isMultiPart: false,
          status: 'sent'
        });

        // Send next chunk as new message if we don't have one yet
        if (i + 1 >= messages.length) {
          const remainderText = chunks.slice(i + 1).join(' ');
          const result2 = await sendToTelegram(remainderText);
          if (!result2.success) {
            log.streaming.warn(`⚠️ Live stream: chunk ${i + 2} send failed`);
            return;
          }
          const newMsgId = Array.isArray(result2.messageId) ? result2.messageId[0] : result2.messageId;
          messages.push({ id: newMsgId });
          lastSentActiveText = remainderText;
          log.streaming(`📡 Live stream: chunk ${messages.length} started (msgId: ${newMsgId})`);
        }
      }
    };

    /**
     * Shared UI cleanup: remove streaming indicator, add action buttons
     */
    const finalizeUI = (msgData) => {
      if (firstElement.isConnected) {
        state.sentMessages.set(firstElement, msgData);
        const indicator = firstElement.querySelector('.persephone-streaming');
        if (indicator) indicator.remove();
        const btnGroup = createActionButtonGroup(firstElement);
        firstElement.appendChild(btnGroup);
      }
    };

    // Finalize: handle final edit, update maps, show buttons
    const finalize = async () => {
      if (streamFinalized) return;
      streamFinalized = true;
      pacer.stop();
      changeObserver.disconnect();
      clearInterval(safetyCheck);

      const fullText = getFinalText();
      if (!fullText || fullText.length < 5) return;

      // If splits are still needed, do them now at finalize time
      if (!splitting) {
        const chunks = splitAllChunks(fullText);
        if (chunks.length - 1 > frozenChunks.length) {
          log.streaming(`📡 Live stream: late split at finalize`);
          await performSplit(fullText);
        }
      }

      if (frozenChunks.length > 0) {
        // --- Multi-message finalization ---
        // All frozen chunks are already finalized and in sentByHash

        // Get the active (last) portion of text
        const activeText = getActiveText(fullText);
        const activeMsgId = messages[messages.length - 1].id;

        if (!activeText || activeText.length < 3) {
          log.streaming('📡 Live stream: finalized (split, no remainder)');
          showToast('✓ Streamed first chunk');
          return;
        }

        // Store active chunk in sentByHash BEFORE async edit (for DOM rebuild)
        const activeHash = hashText(activeText);
        const activeMsgData = {
          messageId: activeMsgId,
          text: activeText,
          isMultiPart: false,
          status: 'pending'
        };
        state.sentByHash.set(activeHash, activeMsgData);

        // Final markdown edit for active message (skip if unchanged)
        if (activeText !== lastSentActiveText) {
          const editOk = await editInTelegram(activeMsgId, activeText);
          if (!editOk) {
            log.streaming.warn('⚠️ Live stream: final edit for active chunk failed');
            state.sentByHash.delete(activeHash);
          } else {
            activeMsgData.status = 'sent';
          }
        } else {
          activeMsgData.status = 'sent';
        }

        // Store composite entry under the full text hash for DOM rebuild restoration
        const allMessageIds = messages.map(m => m.id);
        const compositeData = {
          messageId: allMessageIds,
          text: fullText,
          isMultiPart: true,
          status: 'sent'
        };
        state.sentByHash.set(hashText(fullText), compositeData);

        finalizeUI(compositeData);
        log.streaming(`📡 Live stream: finalized (${messages.length} messages)`);
        showToast(`✓ Streamed first chunk (${messages.length} parts)`);

      } else {
        // --- Single-message finalization (no split needed) ---
        const msgId = messages[0].id;
        const finalHash = hashText(fullText);
        const msgData = {
          messageId: msgId,
          text: fullText,
          isMultiPart: result.isMultiPart,
          status: 'pending'
        };
        state.sentByHash.set(finalHash, msgData);

        if (fullText !== lastSentText) {
          const editOk = await editInTelegram(msgId, fullText);
          if (!editOk) {
            log.streaming.warn('⚠️ Live stream: final edit failed');
            state.sentByHash.delete(finalHash);
            return;
          }
        }
        msgData.status = 'sent';

        finalizeUI(msgData);
        log.streaming('📡 Live stream: finalized');
        showToast('✓ Streamed first chunk');
      }
    };

    /**
     * Send the paragraph's current text to Telegram. Called by the pacer,
     * which decides when. Returns null when there was nothing new to send,
     * otherwise Telegram's answer so the pacer can slow down if asked to.
     */
    const sendLatest = async () => {
      if (streamFinalized || splitting) return null;

      const text = extractText(firstElement);
      if (!text || !isSameParagraph(firstElement) || text === lastSentText) return null;
      growAnchor();

      // Check if active portion exceeds threshold — need to split
      const activeText = getActiveText(text);
      if (splitAtWordBoundary(activeText, WORD_SPLIT_THRESHOLD)) {
        lastSentText = text;
        splitting = true;
        try {
          await performSplit(text);
        } finally {
          splitting = false;
        }
        // The split wrote to Telegram, so it counts as a send for pacing.
        return { success: true };
      }

      // Regular stream edit to active (last) message. The text only counts as
      // sent once Telegram has taken it: an edit that was held back or refused
      // must still go out, on the next try or with the final edit. (Marking it
      // sent beforehand left the Telegram message on an older text for good.)
      const activeMsgId = messages[messages.length - 1].id;
      const split = frozenChunks.length > 0;
      if (split && !activeText) return null;
      const result = await streamEditTelegram(activeMsgId, split ? activeText : text);
      if (result?.success) {
        lastSentText = text;
        if (split) lastSentActiveText = activeText;
      }
      return result;
    };

    const pacer = createEditPacer({
      send: sendLatest,
      minGapMs: STREAM_EDIT_MIN_GAP_MS,
      slowGapMs: STREAM_EDIT_SLOW_GAP_MS,
    });

    // Stop conditions: paragraph complete or streaming ended.
    // Skipped while a split is in progress — let performSplit finish before finalizing.
    const finalizeIfDone = () => {
      if (streamFinalized || splitting) return;
      if (!isElementStreaming(container) || !isElementStreaming(firstElement)) finalize();
    };

    // Every change to the answer is pushed as it happens, and the end of the
    // paragraph is noticed the same way. No clock in between: a clock adds its
    // own delay, and Chrome slows clocks in tabs that are not in front.
    const onAnswerChanged = () => {
      if (streamFinalized) return;
      pacer.request();
      finalizeIfDone();
    };
    const changeObserver = new MutationObserver(onAnswerChanged);
    changeObserver.observe(container, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-is-streaming', 'class'],
    });
    // Safety net for anything the observer does not report.
    const safetyCheck = setInterval(onAnswerChanged, STREAM_SAFETY_CHECK_MS);
    // Text may have arrived while the first message was being sent.
    onAnswerChanged();

    // Safety: finalize after 60 seconds no matter what
    setTimeout(() => finalize(), 60000);
  }

  // --- Exports ---
  Object.assign(P, {
    checkForNewResponse, startGlobalObserver, startStreamingObserver, startLiveStream
  });
})();
