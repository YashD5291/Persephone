(function() {
  'use strict';
  const P = window.Persephone;

  const { sel, state, MSG, log, SITE } = P;

  // Late-bound (defined in modules that load after this one):
  const showToast = (...args) => P.showToast(...args);
  const isContextValid = (...args) => P.isContextValid(...args);

  function isVisibleElement(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function scoreChatInputCandidate(el) {
    let score = 0;
    if (!el) return score;
    if (isVisibleElement(el)) score += 100;
    if (el.matches?.('[contenteditable="true"]')) score += 20;
    if (el.matches?.('div.ProseMirror')) score += 15;
    if (el.matches?.('[data-testid="chat-input"]')) score += 30;
    if (el.matches?.('[role="textbox"]')) score += 10;
    if (el.closest('form')) score += 5;
    if (el.closest('[aria-hidden="true"]')) score -= 200;
    return score;
  }

  /**
   * Find the chat input element, trying the primary selector then fallbacks.
   * Prefers visible editors so inactive tabs don't select hidden stale nodes.
   */
  function findChatInput(options = {}) {
    const allowHidden = options.allowHidden === true;
    const selectors = [
      sel.primary('chatInput'),
      '[data-testid="chat-input"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"]'
    ];
    const candidateSet = new Set();
    selectors.forEach((selector) => {
      if (!selector) return;
      document.querySelectorAll(selector).forEach((el) => candidateSet.add(el));
    });
    const candidates = Array.from(candidateSet);

    if (candidates.length === 0) return null;

    const ranked = candidates
      .map((el) => ({ el, score: scoreChatInputCandidate(el) }))
      .sort((a, b) => b.score - a.score);

    const bestVisible = ranked.find((entry) => isVisibleElement(entry.el));
    if (bestVisible) return bestVisible.el;

    if (allowHidden && ranked.length > 0) return ranked[0].el;
    return null;
  }

  async function findChatInputWithRetry(attempts = 4, delayMs = 120, options = {}) {
    for (let i = 0; i < attempts; i++) {
      const input = findChatInput(options);
      if (input) return input;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  function placeCaretAtEnd(el) {
    try {
      if (!el || !el.isContentEditable) return;
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      // Selection APIs can fail in inactive tabs; safe to ignore.
    }
  }

  function getComposerRoot(input) {
    if (!input) return document.body;
    return input.closest('form') || input.closest('[data-testid*="composer"]') || input.parentElement || document.body;
  }

  function getAttachmentSignalCount(root) {
    if (!root) return 0;
    const selectors = [
      'img[src^="blob:"]',
      'img[src^="data:image"]',
      '[data-testid*="attachment"]',
      '[data-testid*="image"]',
      '[aria-label*="Remove image"]',
      '[aria-label*="Remove attachment"]',
      '[class*="attachment"]'
    ];
    return root.querySelectorAll(selectors.join(',')).length;
  }

  function dispatchImagePaste(input, blob) {
    const file = new File([blob], 'screenshot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        dataTransfer: dt
      }));
    } catch (e) {
      // Some browsers do not accept dataTransfer in InputEvent initializer.
    }
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });
    input.dispatchEvent(pasteEvent);
  }

  function dispatchImageDrop(input, blob) {
    const file = new File([blob], 'screenshot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const targets = [input, input.closest('form'), document.body].filter(Boolean);
    const eventInit = { bubbles: true, cancelable: true, dataTransfer: dt };
    targets.forEach((target) => {
      target.dispatchEvent(new DragEvent('dragenter', eventInit));
      target.dispatchEvent(new DragEvent('dragover', eventInit));
      target.dispatchEvent(new DragEvent('drop', eventInit));
    });
  }

  /**
   * Try to click the send/submit button. Retries up to maxAttempts
   * since the button may appear after text enters the input.
   */
  function submitChatInput() {
    const input = findChatInput();

    // 1. Try the send/submit button if visible and enabled
    const sendBtn = sel.query('sendButton');
    if (sendBtn && !sendBtn.disabled && sendBtn.offsetParent !== null) {
      sendBtn.click();
      log.voice('🎙️ Submit: clicked send button');
      showToast('Voice message sent');
      return;
    }

    // 2. Force-click the button even if hidden/disabled (tab-switch scenario:
    //    framework state is stale but clicking may still trigger the handler)
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.click();
      log.voice('🎙️ Submit: force-clicked send button');
      showToast('Voice message sent');
      return;
    }

    // 3. Try form.requestSubmit() (Grok wraps input in a <form>)
    if (input) {
      const form = input.closest('form');
      if (form) {
        try {
          form.requestSubmit();
          log.voice('🎙️ Submit: form.requestSubmit()');
          showToast('Voice message sent');
          return;
        } catch (e) {
          log.voice.warn('🎙️ Submit: requestSubmit failed:', e.message);
        }
      }
    }

    // 4. Enter key on the input
    if (input) {
      const props = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      input.dispatchEvent(new KeyboardEvent('keydown', props));
      input.dispatchEvent(new KeyboardEvent('keypress', props));
      input.dispatchEvent(new KeyboardEvent('keyup', props));
      log.voice('🎙️ Submit: dispatched Enter key sequence');
      showToast('Voice message sent');
    } else {
      log.voice.warn('🎙️ Submit: failed — no input or button found');
    }
  }

  /**
   * Get the current text value from a chat input element.
   */
  function getInputValue(input) {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return input.value;
    }
    return input.textContent || input.innerText || '';
  }

  /**
   * Poll the chat input for new text from MacWhisper.
   * Polls every 200ms. When text changes and stabilizes for 800ms, fires callback.
   * Uses polling instead of event listeners because MacWhisper's simulated
   * keystrokes may not trigger DOM input events or mutations.
   */
  function watchForTranscription(inputBefore) {
    if (!findChatInput()) {
      log.voice.warn('🎙️ Cannot watch — chat input not found');
      return;
    }

    const POLL_MS = 50;
    log.voice('🎙️ Watching input for transcription (polling)...');

    const pollInterval = setInterval(() => {
      // Re-find input each poll (DOM may rebuild after tab switch)
      const input = findChatInput();
      if (!input) return;

      const current = getInputValue(input).trim();

      if (current.length > 0 && current !== inputBefore) {
        // New text detected — fire immediately
        clearInterval(pollInterval);
        const transcription = inputBefore ? current.replace(inputBefore, '').trim() : current;
        log.voice('TRANSCRIPTION:', transcription);
        log.voice('🎙️ Transcription:', transcription);

        // Broadcast to other Grok/Claude tabs BEFORE submitting locally
        log.voice('🎙️ Broadcasting to other tabs, text:', current.substring(0, 50));
        try {
          chrome.runtime.sendMessage({ type: MSG.BROADCAST_QUESTION, text: current })
            .then(r => log.voice('🎙️ Broadcast response:', r))
            .catch(err => log.voice.error('🎙️ Broadcast error:', err));
        } catch (e) {
          log.voice.error('🎙️ Broadcast send threw:', e);
        }

        if (state.autoSubmitVoice) {
          // Focus input and poke the framework before submitting
          input.focus();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          submitChatInput();

          // Auto-restart mic after a delay if enabled
          if (state.voiceAutoRestart) {
            log.voice(`🎙️ Auto-restart in ${state.voiceRestartDelay}s`);
            setTimeout(() => handleMicClick(), state.voiceRestartDelay * 1000);
          }
        }
      }
    }, POLL_MS);

    // Safety: stop polling after 30 seconds
    setTimeout(() => {
      clearInterval(pollInterval);
      const input = findChatInput();
      if (input) {
        const final = getInputValue(input).trim();
        if (final && final !== inputBefore) {
          log.voice('TRANSCRIPTION (timeout):', final);
          log.voice('🎙️ Transcription (timeout):', final);
        }
      }
    }, 30000);
  }

  /**
   * Insert text into the chat input and submit (used by broadcast from other tabs).
   * Uses multiple strategies because execCommand requires focus which the
   * non-active tab in split view may not have.
   */
  function insertTextAndSubmit(text, options = {}) {
    const focusInput = options.focusInput === true;
    log.voice('🎙️ Broadcast received:', text.substring(0, 50));
    const input = findChatInput();
    if (!input) {
      log.voice.warn('🎙️ Broadcast: no chat input found');
      return;
    }

    if (focusInput && document.visibilityState === 'visible' && document.hasFocus()) {
      input.focus();
    }

    let inserted = false;

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
      inserted = true;
    } else {
      // Contenteditable (ProseMirror) — try execCommand first
      try {
        const selection = window.getSelection();
        selection.selectAllChildren(input);
        document.execCommand('delete');
        inserted = document.execCommand('insertText', false, text);
      } catch (e) {
        log.voice.warn('🎙️ execCommand failed:', e.message);
      }

      // Check if execCommand actually inserted text
      if (!inserted || !getInputValue(input).trim()) {
        log.voice('🎙️ execCommand did not work, using innerHTML fallback');
        // Direct DOM manipulation — ProseMirror's DOMObserver picks up mutations
        input.innerHTML = '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>';
        inserted = true;
      }
    }

    // Poke the framework so it picks up the change
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Small delay to let ProseMirror sync its internal state before submitting
    setTimeout(() => {
      if (focusInput && document.visibilityState === 'visible' && document.hasFocus()) {
        input.focus();
      }
      submitChatInput();
      log.voice('🎙️ Broadcast: submitted');
    }, 100);
  }

  /**
   * Handle mic button click — toggle MacWhisper recording.
   * Guarded against re-entrant calls: rapid clicks while the async
   * sendMessage is in-flight would desync state vs. actual MacWhisper state.
   */
  let micToggling = false;

  async function handleMicClick() {
    if (micToggling) return;

    if (!isContextValid()) {
      showToast('Extension disconnected. Please refresh.');
      return;
    }

    const micBtn = document.querySelector('.persephone-mic-btn');
    if (!micBtn) return;

    micToggling = true;
    try {
      // Always keep focus on the chat input, not the button
      const input = findChatInput();
      if (input) input.focus();

      if (!state.micRecording) {
        // Starting recording
        const result = await chrome.runtime.sendMessage({ type: MSG.TOGGLE_WHISPER });
        if (result?.success) {
          state.micRecording = true;
          micBtn.classList.add('recording');
          if (input) input.focus();
          log.voice('🎙️ Recording started');
        } else {
          showToast('Failed to start MacWhisper');
          log.voice.error('🎙️ Start failed:', result?.error);
        }
      } else {
        // Stopping recording — capture what's in the input before MacWhisper types
        const inputBefore = input ? getInputValue(input).trim() : '';

        // refocus: true tells the native host to re-activate Chrome after F5
        const result = await chrome.runtime.sendMessage({ type: MSG.TOGGLE_WHISPER, refocus: true });
        state.micRecording = false;
        micBtn.classList.remove('recording');

        // Re-focus input so MacWhisper types into it
        if (input) input.focus();
        log.voice('🎙️ Recording stopped, input focused, polling for transcription...');

        // Poll the input for MacWhisper's typing
        watchForTranscription(inputBefore);
      }
    } finally {
      micToggling = false;
    }
  }

  /**
   * Inject the floating mic button into the page.
   * Uses mousedown preventDefault to avoid stealing focus from chat input.
   */
  function injectMicButton() {
    if (document.querySelector('.persephone-mic-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'persephone-mic-btn';
    btn.title = 'Toggle MacWhisper (Alt+M)';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;

    // Prevent mousedown from stealing focus away from chat input
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    btn.addEventListener('click', handleMicClick);

    document.body.appendChild(btn);
    log.voice('🎙️ Mic button injected');
  }

  // --- Exports ---
  Object.assign(P, {
    isVisibleElement, scoreChatInputCandidate, findChatInput, findChatInputWithRetry, 
    placeCaretAtEnd, getComposerRoot, getAttachmentSignalCount, dispatchImagePaste, 
    dispatchImageDrop, submitChatInput, getInputValue, watchForTranscription, insertTextAndSubmit, 
    handleMicClick, injectMicButton
  });
})();
