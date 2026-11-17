(function() {
  'use strict';
  const P = window.Persephone;

  const { sel, state, MSG, log, SITE } = P;

  // ProseMirror needs a moment to take in text written from outside before
  // the send button will submit it.
  const EDITOR_SYNC_MS = 100;

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

  /** Derive a filename + type for a screenshot blob from its actual mime. */
  function fileMetaForBlob(blob) {
    const type = blob.type || 'image/png';
    const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
    return { name: `screenshot.${ext}`, type };
  }

  function dispatchImagePaste(input, blob) {
    const meta = fileMetaForBlob(blob);
    const file = new File([blob], meta.name, { type: meta.type });
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
    const meta = fileMetaForBlob(blob);
    const file = new File([blob], meta.name, { type: meta.type });
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
        if (state.voiceTiming) state.voiceTiming.transcript = performance.now();
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
          if (state.voiceTiming) state.voiceTiming.submit = performance.now();

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
   * Replace the chat input's content with `text`.
   * Uses multiple strategies because execCommand requires focus which the
   * non-active tab in split view may not have. Returns false if there is no
   * chat input to write to.
   */
  function setChatInputText(text) {
    const input = findChatInput();
    if (!input) return false;
    if (getInputValue(input).trim() === text.trim()) return true;

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
    } else {
      // Contenteditable (ProseMirror) — try execCommand first
      let inserted = false;
      try {
        const selection = window.getSelection();
        selection.selectAllChildren(input);
        document.execCommand('delete');
        inserted = text === '' || document.execCommand('insertText', false, text);
      } catch (e) {
        log.voice.warn('🎙️ execCommand failed:', e.message);
      }

      // Check if execCommand actually put the text there
      if (!inserted || getInputValue(input).trim() !== text.trim()) {
        // Direct DOM manipulation — ProseMirror's DOMObserver picks up mutations
        input.innerHTML = '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>';
      }
    }

    // Poke the framework so it picks up the change
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * Insert text into the chat input and submit (used by broadcast from other tabs).
   */
  function insertTextAndSubmit(text, options = {}) {
    const focusInput = options.focusInput === true;
    const refocus = () => {
      if (focusInput && document.visibilityState === 'visible' && document.hasFocus()) {
        findChatInput()?.focus();
      }
    };
    log.voice('🎙️ Broadcast received:', text.substring(0, 50));

    refocus();
    if (!setChatInputText(text)) {
      log.voice.warn('🎙️ Broadcast: no chat input found');
      return;
    }

    // Small delay to let ProseMirror sync its internal state before submitting
    setTimeout(() => {
      refocus();
      submitChatInput();
      log.voice('🎙️ Broadcast: submitted');
    }, EDITOR_SYNC_MS);
  }

  // ============================================
  // LIVE TEXT (MacWhisper Live Captions)
  // ============================================
  //
  // With "Live text" on, MacWhisper's Live Captions transcribes while the
  // person is still talking and the words land in this chat box as they are
  // spoken. Nothing is sent: the user reads the question and presses Enter.
  // Once the box is empty again (sent or cleared), the next words start a
  // fresh question.
  //
  // The box holds the user's own text followed by the live words:
  //
  //     [ anything the user typed or corrected ][ live tail ]
  //
  // Live text only ever rewrites its own tail. It never touches what is in
  // front of it and it puts the caret back where the user had it, so the user
  // can type in the box while someone is still talking. If the user changes
  // the tail itself (fixing a misheard word), the whole box becomes theirs
  // and what is said from then on is added after it as a new tail.

  // How often the chat box is checked for "sent / cleared / edited by hand".
  const LIVE_BOX_CHECK_MS = 200;

  const LIVE_STATUS_HELP = {
    // The helper starts Live Captions itself; this is shown only when it could not.
    captions_off: 'Could not start Live Captions. Open MacWhisper\'s window and start it there.',
    macwhisper_not_running: 'MacWhisper is not running.',
    no_accessibility: 'Allow Accessibility in System Settings (macOS just asked), then switch live text on again.',
    host_unavailable: 'Live text helper is not installed. Run native-host/install.sh.',
  };

  // Exactly what this module last wrote as the live tail. It sits at the very
  // end of the box; if the box no longer ends with it, a person changed it.
  let liveTail = '';
  // The live words that tail was made from, to skip updates that change nothing.
  let liveShown = '';
  // The box as it was when last looked at, to notice the moment it is emptied.
  let liveBoxSeen = '';
  // A fresh question was asked for (box emptied, or the tail edited by hand).
  // The helper confirms with an empty text; until then its words are old ones.
  let liveAwaitingFresh = false;
  // When the words in the box last changed (ms since epoch), for the latency record.
  let liveTextAt = null;
  let liveBoxTimer = null;
  // This tab is the one receiving live text. Set only by the background, so it
  // is true however live text was switched on: mic button, Alt+M, or the
  // global shortcut. (The "Live text" setting only decides what the mic
  // button does; it must not gate text the user explicitly asked for.)
  let liveReceiving = false;
  // Watches the chat box itself, so a send or an edit is noticed the moment
  // it happens, also in a tab that is not in front (where timers run late).
  let liveBoxObserver = null;
  let liveBoxWatched = null;

  function watchLiveBox() {
    liveBoxObserver?.disconnect();
    liveBoxObserver = null;
    liveBoxWatched = findChatInput({ allowHidden: true });
    if (!liveBoxWatched) return;
    liveBoxObserver = new MutationObserver(checkLiveBox);
    liveBoxObserver.observe(liveBoxWatched, { childList: true, subtree: true, characterData: true });
  }

  // The editor sometimes stores a space as a non-breaking space.
  const plainSpaces = (text) => text.replace(/\u00a0/g, ' ');

  function currentBoxText() {
    const input = findChatInput();
    return input ? getInputValue(input) : null;
  }

  const boxEndsWithLiveTail = (box) => plainSpaces(box).endsWith(plainSpaces(liveTail));

  /**
   * Notice what the user did with the box since the last look: sent or
   * cleared it, or changed the live words themselves. Both start a fresh
   * question. Typing anywhere in front of the live words changes nothing.
   */
  function checkLiveBox() {
    // Claude can replace the box element; keep watching the current one.
    if (liveReceiving && liveBoxWatched && !liveBoxWatched.isConnected) watchLiveBox();
    const box = currentBoxText();
    if (box === null || box === liveBoxSeen) return;
    const wasEmpty = liveBoxSeen.trim() === '';
    liveBoxSeen = box;

    if (box.trim() === '') {
      if (wasEmpty) return;
      // Sent with Enter, or wiped by hand. Either way the old words are done with.
      noteLiveQuestionSent(null);
      startFreshLiveQuestion('box emptied');
    } else if (liveTail !== '' && !boxEndsWithLiveTail(box)) {
      startFreshLiveQuestion('live words edited by hand, the box is the user\'s now');
    }
  }

  /** Forget the live tail and ask the helper to count only what is said from now on. */
  function startFreshLiveQuestion(reason) {
    liveTail = '';
    liveShown = '';
    liveAwaitingFresh = true;
    chrome.runtime.sendMessage({ type: MSG.LIVE_MARK }).catch(() => {});
    log.voice(`🎙️ Live text: ${reason}; the next words start fresh`);
  }

  /** Text heard so far for the current question, pushed from the native host. */
  function handleLiveText(text) {
    if (!liveReceiving) return;
    // Catch a send or an edit that happened since the last look before writing.
    checkLiveBox();
    if (liveAwaitingFresh) {
      if (text !== '') return;   // words from before the fresh start
      liveAwaitingFresh = false;
    }
    if (text === '') {
      // The helper started over. Words already in the box are never deleted
      // from here: they simply stop being the live tail.
      liveTail = '';
      liveShown = '';
      return;
    }
    if (text === liveShown) return;

    const input = findChatInput();
    if (!input) return;
    const box = getInputValue(input);
    const head = box.slice(0, box.length - liveTail.length);
    // One space between the user's text and the live words, unless it is there already.
    const tail = (head === '' || /\s$/.test(head) ? '' : ' ') + text;
    if (replaceInputTail(input, liveTail.length, tail)) {
      liveTail = tail;
      liveShown = text;
      liveBoxSeen = getInputValue(input);
      liveTextAt = Date.now();
    }
  }

  // ---- Writing the live tail without disturbing the user ----

  /** Position in the DOM of a character offset into the box's text. */
  function charPoint(root, offset, preferNextNode) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let last = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // On a boundary between two text nodes, a range start belongs to the
      // later one, so the range never reaches back across a paragraph break.
      if (remaining < node.length || (remaining === node.length && !preferNextNode)) return { node, offset: remaining };
      remaining -= node.length;
      last = node;
    }
    return last ? { node: last, offset: last.length } : null;
  }

  function charRange(root, start, end) {
    const from = charPoint(root, start, true);
    const to = charPoint(root, end, false);
    const range = document.createRange();
    if (!from || !to) {
      // No text in the box yet: the caret goes inside its last paragraph.
      // (Selecting the empty paragraph itself and typing over it left an
      // empty line above the text.)
      const paragraphs = root.querySelectorAll('p');
      range.setStart(paragraphs.length ? paragraphs[paragraphs.length - 1] : root, 0);
      range.collapse(true);
      return range;
    }
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  }

  /** Character offset into the box's text of a DOM position inside it. */
  function charOffset(root, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  /**
   * Where a caret belongs after the live tail (which began at `tailStart`)
   * was rewritten. In the user's own text, or right at its end, it stays put:
   * that is where they are typing. Resting at the end of the live words it
   * follows the end. Inside the live words it keeps its place as far as the
   * new text reaches.
   */
  function movedCaret(offset, tailStart, oldEnd, newEnd) {
    if (offset <= tailStart) return offset;
    if (offset >= oldEnd) return newEnd;
    return Math.min(offset, newEnd);
  }

  const isTypingField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);

  /**
   * Replace the last `tailLength` characters of the chat box with `newTail`.
   * Everything in front of them is left alone, only the part of the tail that
   * really changed is rewritten, and the user's caret or selection is put
   * back afterwards. Returns false if the box does not end up as expected.
   */
  function replaceInputTail(input, tailLength, newTail) {
    const before = getInputValue(input);
    const head = before.slice(0, before.length - tailLength);
    const oldTail = before.slice(head.length);
    const wanted = head + newTail;
    if (plainSpaces(before) === plainSpaces(wanted)) return true;

    let same = 0;
    const limit = Math.min(oldTail.length, newTail.length);
    while (same < limit && plainSpaces(oldTail[same]) === plainSpaces(newTail[same])) same += 1;
    const changeStart = head.length + same;
    const replacement = newTail.slice(same);

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const caret = [input.selectionStart, input.selectionEnd];
      input.value = wanted;
      try {
        input.setSelectionRange(...caret.map((offset) => movedCaret(offset, head.length, before.length, wanted.length)));
      } catch (e) {
        // Not a text-like input; nothing to restore.
      }
    } else {
      const selection = window.getSelection();
      const inBox = selection.rangeCount > 0 && input.contains(selection.anchorNode) && input.contains(selection.focusNode);
      const caret = inBox ? {
        anchor: charOffset(input, selection.anchorNode, selection.anchorOffset),
        focus: charOffset(input, selection.focusNode, selection.focusOffset),
      } : null;
      // A selection elsewhere on the page (text being copied from an answer) is the user's too.
      const elsewhere = inBox ? [] : Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());

      let done = false;
      // execCommand types into whatever field has the focus, so it is only
      // used when that cannot be some other field the user is typing in.
      const focused = document.activeElement;
      const focusElsewhere = isTypingField(focused) && focused !== input && !input.contains(focused);
      const target = focusElsewhere ? null : charRange(input, changeStart, before.length);
      if (target) {
        try {
          selection.removeAllRanges();
          selection.addRange(target);
          done = replacement === ''
            ? document.execCommand('delete')
            : document.execCommand('insertText', false, replacement);
        } catch (e) {
          log.voice.warn('🎙️ execCommand failed:', e.message);
        }
      }
      if (!done || plainSpaces(getInputValue(input)) !== plainSpaces(wanted)) {
        // Edit the text directly; the editor's own observer picks the change up.
        const now = getInputValue(input);
        const headIntact = now !== '' && plainSpaces(now).startsWith(plainSpaces(wanted.slice(0, changeStart)));
        const range = headIntact ? charRange(input, changeStart, now.length) : null;
        if (!range) return setChatInputText(wanted);
        range.deleteContents();
        if (replacement !== '') range.insertNode(document.createTextNode(replacement));
        input.normalize();
      }

      if (caret) {
        const anchor = charPoint(input, movedCaret(caret.anchor, head.length, before.length, wanted.length), false);
        const focus = charPoint(input, movedCaret(caret.focus, head.length, before.length, wanted.length), false);
        if (anchor && focus) selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      } else {
        selection.removeAllRanges();
        elsewhere.forEach((range) => selection.addRange(range));
      }
    }

    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return plainSpaces(getInputValue(input)) === plainSpaces(wanted);
  }

  function handleLiveStatus(status, error) {
    // 'captions_starting' is the helper switching Live Captions on: progress, not a problem.
    if (!liveReceiving || status === 'ready' || status === 'captions_starting') return;
    log.voice.warn('🎙️ Live text:', status, error || '');
    showToast(LIVE_STATUS_HELP[status] || `Live text problem: ${status}`, 'error');
  }

  /**
   * The background switched live text on or off for this tab (this tab is
   * the target chat, or it was the one where the mic was pressed).
   */
  function setLiveActive(active) {
    if (active && liveReceiving) return;
    clearInterval(liveBoxTimer);
    liveBoxTimer = null;
    liveBoxObserver?.disconnect();
    liveBoxObserver = null;
    liveReceiving = active;
    state.micRecording = active;
    document.querySelector('.persephone-mic-btn')?.classList.toggle('recording', active);
    updateLiveButton();

    if (active) {
      // Whatever is already in the box is the user's; the live words go after it.
      liveTail = '';
      liveShown = '';
      liveAwaitingFresh = false;
      liveBoxSeen = currentBoxText() || '';
      watchLiveBox();
      // Safety net for anything the observer does not report.
      liveBoxTimer = setInterval(checkLiveBox, LIVE_BOX_CHECK_MS);
      log.voice('🎙️ Live text ON for this chat');
    } else {
      log.voice('🎙️ Live text OFF');
    }
  }

  /**
   * Live text state for all tabs: lights the mic button wherever live text is
   * running, even when the words are going to another chat.
   */
  function handleLiveState(liveState) {
    const wasActive = state.liveActive;
    state.liveActive = liveState.active === true;
    state.liveTargetTabId = liveState.targetTabId ?? null;
    state.liveTargetHere = liveState.targetHere === true;
    updateLiveButton();
    // The receiving tab's button is set by setLiveActive. Elsewhere, change it
    // only when live text starts or stops, so a dictation in progress in this
    // tab keeps its own red button.
    if (!liveState.activeHere && (state.liveActive || wasActive)) {
      document.querySelector('.persephone-mic-btn')?.classList.toggle('recording', state.liveActive);
    }
  }

  /**
   * The send shortcut was pressed, possibly while this tab is not in front:
   * press send on whatever is in the box. This is the user's own key press.
   */
  function submitLiveQuestion({ pressedAt = null, lastTextAt = null } = {}) {
    const box = currentBoxText();
    if (box === null || box.trim() === '') {
      showToast('Nothing in the chat box to send', 'error');
      return { success: false, error: 'empty' };
    }
    submitChatInput();
    noteLiveQuestionSent(pressedAt ?? Date.now(), lastTextAt);
    return { success: true };
  }

  // The send shortcut empties the box too; that must not be taken for a second send.
  const LIVE_SENT_ECHO_MS = 1500;

  /**
   * Start the latency record for a question that has just gone to the chat.
   * `pressedAt` is when the send shortcut was pressed, or null when the user
   * pressed Enter in the tab (the press itself is not seen, only its effect).
   * Clock times are ms since epoch because they come from two processes.
   */
  function noteLiveQuestionSent(pressedAt, lastTextAt = null) {
    const now = Date.now();
    const existing = state.voiceTiming;
    if (existing?.mode === 'live' && now - existing.submittedAt < LIVE_SENT_ECHO_MS) return;
    state.voiceTiming = { mode: 'live', lastTextAt: lastTextAt ?? liveTextAt, pressedAt, submittedAt: now };
  }

  // What the live button says in each state, in the words the user needs.
  const LIVE_BUTTON_TITLES = {
    live: 'Live text is typing into this chat (click to switch it off)',
    elsewhere: 'Live text is typing into another chat (click to bring it here)',
    target: 'Live text will type into this chat (click to switch it on)',
    idle: 'Live text into this chat (click to switch it on)',
  };

  /** Show on the live button where live text is going: here, elsewhere, or nowhere. */
  function updateLiveButton() {
    const btn = document.querySelector('.persephone-live-btn');
    if (!btn) return;
    const look = liveReceiving ? 'live' : state.liveActive ? 'elsewhere' : state.liveTargetHere ? 'target' : 'idle';
    for (const name of ['live', 'elsewhere', 'target']) btn.classList.toggle(name, name === look);
    btn.title = LIVE_BUTTON_TITLES[look];
  }

  let liveHereBusy = false;

  /**
   * The live button: one click puts live text into this chat (switching it on,
   * or moving it here from another chat); a click while it is typing here
   * switches it off. It only starts and stops the typing. It never sends.
   */
  async function liveTextHere() {
    if (liveHereBusy) return;
    if (!isContextValid()) {
      showToast('Extension disconnected. Please refresh.');
      return;
    }
    liveHereBusy = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: MSG.LIVE_HERE });
      if (!result?.success) {
        log.voice.error('🎙️ Live button failed:', result?.error);
        showToast(LIVE_STATUS_HELP[result?.error] || LIVE_STATUS_HELP.host_unavailable, 'error');
      }
    } catch (error) {
      log.voice.error('🎙️ Live button failed:', error.message);
      showToast(LIVE_STATUS_HELP.host_unavailable, 'error');
    } finally {
      liveHereBusy = false;
    }
  }

  /**
   * Ask the background where live text stands for this tab. Needed on page
   * load: a chat that was refreshed while receiving must carry on receiving,
   * and the button has to show the right state from the first moment.
   */
  async function syncLiveState() {
    if (!isContextValid()) return;
    try {
      const liveState = await chrome.runtime.sendMessage({ type: MSG.LIVE_GET_STATE });
      if (!liveState) return;
      handleLiveState(liveState);
      if (liveState.activeHere) setLiveActive(true);
    } catch (error) {
      // Background not ready yet: the next LIVE_STATE broadcast will bring it.
    }
  }

  function injectLiveButton() {
    if (document.querySelector('.persephone-live-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'persephone-live-btn';
    // Speech lines: tells it apart from the mic (dictation) button below it.
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="10" width="2.5" height="4" rx="1.25"/><rect x="7.2" y="6.5" width="2.5" height="11" rx="1.25"/><rect x="11.4" y="3" width="2.5" height="18" rx="1.25"/><rect x="15.6" y="7.5" width="2.5" height="9" rx="1.25"/><rect x="19.8" y="10.5" width="2.5" height="3" rx="1.25"/></svg>`;
    // Keep the caret in the chat box, as the mic button does.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', liveTextHere);

    document.body.appendChild(btn);
    updateLiveButton();
    syncLiveState();
    log.voice('🎙️ Live button injected');
  }

  /** Mic button / Alt+M in live mode: ask the background to switch live text on or off. */
  async function toggleLiveText() {
    const result = await chrome.runtime.sendMessage({ type: MSG.LIVE_TOGGLE });
    if (!result?.success) {
      log.voice.error('🎙️ Live text toggle failed:', result?.error);
      showToast(LIVE_STATUS_HELP[result?.error] || LIVE_STATUS_HELP.host_unavailable, 'error');
    }
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

      // While live text is running, the mic button controls it even if the
      // "Live text" setting is off (it may have been started by the shortcut).
      if (state.voiceLiveCaptions || state.liveActive) {
        await toggleLiveText();
        return;
      }

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
        const clickedAt = performance.now();
        const result = await chrome.runtime.sendMessage({ type: MSG.TOGGLE_WHISPER, refocus: true });
        state.voiceTiming = { clicked: clickedAt, stop: performance.now() };
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
    setChatInputText, handleLiveText, handleLiveStatus, handleLiveState, setLiveActive, submitLiveQuestion, 
    liveTextHere, syncLiveState, injectLiveButton, handleMicClick, injectMicButton
  });
})();
