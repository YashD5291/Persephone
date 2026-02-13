// Persephone - Content Script for grok.com and claude.ai
// v3.4 - Multi-site support (Grok + Claude)

(function() {
  'use strict';

  let seenTexts = new Set();
  let currentStreamingContainer = null;
  let lastContainerCount = 0;
  let autoSentContainers = new WeakSet(); // Track containers that had auto-send
  let sentMessages = new Map(); // Track sent messages: element -> { messageId, text }
  let sentByHash = new Map(); // Track sent messages by text hash -> { messageId, text, isMultiPart }
  let extensionEnabled = true; // Master toggle - enabled by default
  let autoSendFirstChunk = true; // Enabled by default
  let splitThreshold = 250; // Character count above which paragraphs get split send buttons
  let autoSubmitVoice = false; // Auto-submit transcribed voice input

  const DEFAULT_SKIP_KEYWORDS = ['short', 'shorter', 'shrt', 'shrtr', 'shrter'];
  let autoSendSkipKeywords = [...DEFAULT_SKIP_KEYWORDS];
  let containerQuestions = new WeakMap(); // container -> question text at time of streaming start

  const DEBUG = true;

  const SITE = window.location.hostname.includes('claude.ai') ? 'claude' : 'grok';

  const SELECTORS = SITE === 'claude' ? {
    responseContainer: 'div[data-is-streaming]',
    userQuestion: null,
    cleanTextRemove: 'button, svg, img, .persephone-inline-btn, .persephone-btn-group, .persephone-sent-indicator',
    chatInput: 'div.ProseMirror[data-testid="chat-input"]',
    sendButton: 'button[aria-label="Send message"]',
  } : {
    responseContainer: '.items-start .response-content-markdown',
    userQuestion: '[class*="items-end"] .message-bubble',
    cleanTextRemove: 'button, svg, img, .persephone-inline-btn, .persephone-btn-group, .persephone-sent-indicator, .animate-gaussian, .citation',
    chatInput: '.query-bar div.tiptap.ProseMirror[contenteditable="true"]',
    sendButton: 'button[aria-label="Submit"]',
  };

  function debug(...args) {
    if (DEBUG) console.log('[Persephone]', ...args);
  }

  // ============================================
  // HELPERS
  // ============================================

  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (e) {
      return false;
    }
  }

  function isElementStreaming(element) {
    if (SITE === 'claude') {
      // Container-level: element IS the div[data-is-streaming]
      if (element.hasAttribute('data-is-streaming')) {
        return element.getAttribute('data-is-streaming') === 'true';
      }
      // Element-level: only the last content element in a streaming response is "still streaming"
      const streamingAncestor = element.closest('[data-is-streaming="true"]');
      if (!streamingAncestor) return false;
      const allContent = streamingAncestor.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, blockquote, li');
      return allContent.length > 0 && allContent[allContent.length - 1] === element;
    }
    return element.querySelector('.animate-gaussian') !== null;
  }

  function hashText(text) {
    let h = 0;
    const str = (text || '').substring(0, 200);
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h = h & h;
    }
    return h.toString();
  }

  /**
   * Get the latest user question from the conversation DOM.
   * User messages use items-end (right-aligned), AI responses use items-start (left-aligned).
   * Extract text from .message-bubble to avoid grabbing button labels.
   */
  function getLatestUserQuestion(container) {
    try {
      if (!SELECTORS.userQuestion) return '';
      const allUserMsgs = document.querySelectorAll(SELECTORS.userQuestion);
      if (allUserMsgs.length === 0) return '';
      const question = allUserMsgs[allUserMsgs.length - 1].textContent.trim();
      return question;
    } catch (e) {
      return '';
    }
  }

  function shouldSkipAutoSend(question) {
    if (!question || autoSendSkipKeywords.length === 0) return false;
    const lower = question.toLowerCase();
    return autoSendSkipKeywords.some(kw => {
      const k = kw.toLowerCase().trim();
      return k && lower.includes(k);
    });
  }

  // ============================================
  // TEXT EXTRACTION
  // ============================================

  function extractText(element) {
    const tag = element.tagName.toLowerCase();

    if (tag === 'p') return cleanText(element);
    if (tag.match(/^h[1-6]$/)) return `*${cleanText(element)}*`;
    if (tag === 'li') return formatListItem(element);
    if (tag === 'ul' || tag === 'ol') return formatList(element, tag);
    if (tag === 'pre') return formatCode(element);
    if (tag === 'blockquote') return `> ${cleanText(element)}`;
    if (tag === 'table') return formatTable(element);

    return cleanText(element);
  }

  function formatListItem(li) {
    const parent = li.parentElement;
    const tag = parent?.tagName.toLowerCase();
    const index = Array.from(parent?.children || []).indexOf(li);
    const prefix = tag === 'ol' ? `${index + 1}.` : '•';
    return `${prefix} ${cleanText(li)}`;
  }

  function cleanText(element) {
    const clone = element.cloneNode(true);
    
    // Remove unwanted elements
    clone.querySelectorAll(SELECTORS.cleanTextRemove)
      .forEach(el => el.remove());

    // Convert formatting
    clone.querySelectorAll('strong, b').forEach(el => {
      el.outerHTML = `*${el.textContent}*`;
    });
    clone.querySelectorAll('em, i').forEach(el => {
      el.outerHTML = `_${el.textContent}_`;
    });
    clone.querySelectorAll('code').forEach(el => {
      if (!el.closest('pre')) {
        el.outerHTML = `\`${el.textContent}\``;
      }
    });

    return clone.textContent.trim();
  }

  function formatList(list, tag) {
    const items = [];
    list.querySelectorAll(':scope > li').forEach((li, i) => {
      const prefix = tag === 'ol' ? `${i + 1}.` : '•';
      items.push(`${prefix} ${cleanText(li)}`);
    });
    return items.join('\n');
  }

  function formatCode(pre) {
    const code = pre.querySelector('code');
    const lang = code?.className.match(/language-(\w+)/)?.[1] || '';
    const content = (code || pre).textContent.trim();
    return '```' + lang + '\n' + content + '\n```';
  }

  function formatTable(table) {
    const rows = [];
    table.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('th, td').forEach(cell => cells.push(cell.textContent.trim()));
      if (cells.length) rows.push(cells.join(' | '));
    });
    return rows.join('\n');
  }

  /**
   * Split long text at ~halfway on a sentence boundary, falling back to comma, then space.
   * Returns [firstHalf, secondHalf].
   */
  function splitText(text) {
    const mid = Math.floor(text.length / 2);
    const searchRange = Math.floor(text.length * 0.2); // Look within 20% of midpoint

    // Try splitting on sentence boundary (". ")
    let bestIdx = -1;
    for (let i = mid - searchRange; i <= mid + searchRange; i++) {
      if (i > 0 && i < text.length - 1 && text[i] === '.' && text[i + 1] === ' ') {
        if (bestIdx === -1 || Math.abs(i - mid) < Math.abs(bestIdx - mid)) {
          bestIdx = i + 1; // Include the period in the first half
        }
      }
    }
    if (bestIdx > 0) return [text.substring(0, bestIdx).trim(), text.substring(bestIdx).trim()];

    // Fall back to comma
    for (let i = mid - searchRange; i <= mid + searchRange; i++) {
      if (i > 0 && i < text.length - 1 && text[i] === ',' && text[i + 1] === ' ') {
        if (bestIdx === -1 || Math.abs(i - mid) < Math.abs(bestIdx - mid)) {
          bestIdx = i + 1; // Include the comma in the first half
        }
      }
    }
    if (bestIdx > 0) return [text.substring(0, bestIdx).trim(), text.substring(bestIdx).trim()];

    // Fall back to nearest space
    for (let i = mid - searchRange; i <= mid + searchRange; i++) {
      if (i > 0 && i < text.length && text[i] === ' ') {
        if (bestIdx === -1 || Math.abs(i - mid) < Math.abs(bestIdx - mid)) {
          bestIdx = i;
        }
      }
    }
    if (bestIdx > 0) return [text.substring(0, bestIdx).trim(), text.substring(bestIdx).trim()];

    // Last resort: hard split at midpoint
    return [text.substring(0, mid).trim(), text.substring(mid).trim()];
  }

  // ============================================
  // BUTTON INJECTION
  // ============================================

  function createSendButton(element, text) {
    const btn = document.createElement('button');
    btn.className = 'persephone-inline-btn persephone-send-btn';
    btn.title = 'Send to Telegram';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

    const textHash = hashText(text);

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';

      const result = await sendToTelegram(text);

      if (result.success) {
        const msgData = {
          messageId: result.messageId,
          text: text,
          isMultiPart: result.isMultiPart
        };

        // Store message info for edit/delete (by element and by hash)
        sentMessages.set(element, msgData);
        sentByHash.set(textHash, msgData);

        // Replace send button with action buttons
        replaceWithActionButtons(element, btn);
      } else {
        btn.style.opacity = '0.8';
        btn.style.pointerEvents = 'auto';
      }
    });

    return btn;
  }

  /**
   * Create a send button for a sub-chunk with a chunk indicator badge.
   * @param {Element} element - The DOM element this button belongs to
   * @param {string} chunkText - The text this button will send
   * @param {number} chunkNum - 1 or 2
   */
  function createSplitSendButton(element, chunkText, chunkNum) {
    const btn = document.createElement('button');
    btn.className = 'persephone-inline-btn persephone-send-btn persephone-split-btn';
    btn.title = `Send part ${chunkNum} to Telegram`;
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg><span class="persephone-chunk-badge">${chunkNum}</span>`;

    const textHash = hashText(chunkText);

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';

      const result = await sendToTelegram(chunkText);

      if (result.success) {
        const msgData = {
          messageId: result.messageId,
          text: chunkText,
          isMultiPart: result.isMultiPart
        };

        sentByHash.set(textHash, msgData);

        // Replace this button with a checkmark
        const sentIndicator = document.createElement('span');
        sentIndicator.className = 'persephone-sent-indicator';
        sentIndicator.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        sentIndicator.title = `Part ${chunkNum} sent`;
        btn.replaceWith(sentIndicator);
      } else {
        btn.style.opacity = '0.85';
        btn.style.pointerEvents = 'auto';
      }
    });

    return btn;
  }

  function createActionButtonGroup(element) {
    const btnGroup = document.createElement('span');
    btnGroup.className = 'persephone-btn-group';

    // Sent indicator (checkmark)
    const sentIndicator = document.createElement('span');
    sentIndicator.className = 'persephone-sent-indicator';
    sentIndicator.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    sentIndicator.title = 'Sent to Telegram';

    // Resend button
    const resendBtn = document.createElement('button');
    resendBtn.className = 'persephone-inline-btn persephone-resend-btn';
    resendBtn.title = 'Resend message';
    resendBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`;

    resendBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const msgData = sentMessages.get(element);
      if (!msgData) return;

      resendBtn.style.opacity = '0.5';
      resendBtn.style.pointerEvents = 'none';

      const result = await sendToTelegram(msgData.text);

      if (result.success) {
        const newMsgData = {
          messageId: result.messageId,
          text: msgData.text,
          isMultiPart: result.isMultiPart
        };
        // Update both maps
        sentMessages.set(element, newMsgData);
        sentByHash.set(hashText(msgData.text), newMsgData);
        showToast('✓ Message resent');
      }

      resendBtn.style.opacity = '0.8';
      resendBtn.style.pointerEvents = 'auto';
    });

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'persephone-inline-btn persephone-edit-btn';
    editBtn.title = 'Edit message';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;

    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditModal(element);
    });

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'persephone-inline-btn persephone-delete-btn';
    deleteBtn.title = 'Delete message';
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

    deleteBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const msgData = sentMessages.get(element);
      if (!msgData) return;

      // Show confirmation
      if (!confirm('Delete this message from Telegram?')) return;

      deleteBtn.style.opacity = '0.5';
      deleteBtn.style.pointerEvents = 'none';

      const success = await deleteFromTelegram(msgData.messageId);

      if (success) {
        // Remove from both maps
        const textHash = hashText(msgData.text);
        sentMessages.delete(element);
        sentByHash.delete(textHash);

        // Replace action buttons with send button again
        const newSendBtn = createSendButton(element, extractText(element));
        btnGroup.replaceWith(newSendBtn);
        showToast('✓ Message deleted');
      } else {
        deleteBtn.style.opacity = '0.8';
        deleteBtn.style.pointerEvents = 'auto';
      }
    });

    btnGroup.appendChild(sentIndicator);
    btnGroup.appendChild(resendBtn);
    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(deleteBtn);

    return btnGroup;
  }

  function replaceWithActionButtons(element, sendBtn) {
    const btnGroup = createActionButtonGroup(element);
    sendBtn.replaceWith(btnGroup);
  }

  function addButtonToElement(element) {
    // Skip if this element already has its own button (direct child)
    const hasOwnButton = Array.from(element.children).some(
      child => child.classList.contains('persephone-inline-btn') ||
               child.classList.contains('persephone-btn-group') ||
               child.classList.contains('persephone-sent-indicator')
    );
    if (hasOwnButton) return false;

    // Skip if still streaming
    if (isElementStreaming(element)) return false;

    // Extract text
    const text = extractText(element);
    if (!text || text.length < 5) return false;

    const hash = hashText(text);
    element.style.position = 'relative';

    // Check if this text was already sent (e.g. live-streamed first chunk after DOM rebuild)
    if (sentByHash.has(hash)) {
      const msgData = sentByHash.get(hash);
      sentMessages.set(element, msgData);
      const btnGroup = createActionButtonGroup(element);
      element.appendChild(btnGroup);
      debug(`♻️ Restored sent state for: ${text.substring(0, 50)}...`);
      return true;
    }

    // Long paragraph: split into two sub-chunks (only for non-streamed paragraphs)
    if (text.length > splitThreshold) {
      const [chunk1, chunk2] = splitText(text);
      const hash1 = hashText(chunk1);
      const hash2 = hashText(chunk2);

      // Check if chunks were already sent (restore path)
      const sent1 = sentByHash.has(hash1);
      const sent2 = sentByHash.has(hash2);

      if (sent1) {
        const indicator = document.createElement('span');
        indicator.className = 'persephone-sent-indicator';
        indicator.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        indicator.title = 'Part 1 sent';
        element.appendChild(indicator);
      } else {
        element.appendChild(createSplitSendButton(element, chunk1, 1));
      }

      if (sent2) {
        const indicator = document.createElement('span');
        indicator.className = 'persephone-sent-indicator';
        indicator.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        indicator.title = 'Part 2 sent';
        element.appendChild(indicator);
      } else {
        element.appendChild(createSplitSendButton(element, chunk2, 2));
      }

      if (!seenTexts.has(hash)) {
        seenTexts.add(hash);
        debug(`✅ <${element.tagName.toLowerCase()}> (split): ${text.substring(0, 50)}...`);
      }

      return true;
    }

    // Create send button
    const btn = createSendButton(element, text);
    element.appendChild(btn);

    if (!seenTexts.has(hash)) {
      seenTexts.add(hash);
      debug(`✅ <${element.tagName.toLowerCase()}>: ${text.substring(0, 50)}...`);
    }

    return true;
  }

  /**
   * Scan a container and add buttons to all content elements
   */
  function processContainer(container) {
    if (!container || !extensionEnabled) return 0;

    // Add buttons to lists (full) and individual list items
    const elements = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, table');
    let count = 0;

    elements.forEach(el => {
      if (addButtonToElement(el)) count++;
    });

    return count;
  }

  /**
   * Scan ALL responses on the page
   */
  function scanAllResponses() {
    if (!extensionEnabled) return 0;

    const containers = document.querySelectorAll(SELECTORS.responseContainer);
    let totalAdded = 0;

    containers.forEach(container => {
      totalAdded += processContainer(container);
    });

    if (totalAdded > 0) {
      debug(`📦 Added ${totalAdded} buttons`);
    }

    return totalAdded;
  }

  /**
   * Check for new streaming response
   */
  function checkForNewResponse() {
    if (!extensionEnabled) return;

    const containers = document.querySelectorAll(SELECTORS.responseContainer);
    if (containers.length === 0) return;

    const latest = containers[containers.length - 1];
    const isNewContainer = containers.length > lastContainerCount;
    const isStreaming = isElementStreaming(latest);

    // Detect new response (container count increased or new streaming on different container)
    if (isNewContainer || (isStreaming && latest !== currentStreamingContainer)) {
      lastContainerCount = containers.length;

      if (isStreaming) {
        debug('⚡ Streaming response detected');
        currentStreamingContainer = latest;

        // Capture the user question for keyword skip checking
        const question = getLatestUserQuestion(latest);
        containerQuestions.set(latest, question);
        if (question) debug(`📝 Question: "${question.substring(0, 80)}"`);

        // Warm up connection immediately when streaming starts
        if (autoSendFirstChunk) {
          triggerPreconnect();
        }

        startStreamingObserver(latest);
      } else {
        currentStreamingContainer = latest;
        processContainer(latest);
      }
    }
  }

  /**
   * Watch the entire page for new response containers (faster than polling)
   */
  function startGlobalObserver() {
    const mainContainer = document.body;

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

      if (shouldCheck) {
        checkForNewResponse();
      }
    });

    observer.observe(mainContainer, {
      childList: true,
      subtree: true
    });

    debug('👁️ Global observer started');
  }

  /**
   * Watch a streaming response for new chunks
   */
  function startStreamingObserver(container) {
    // Start live streaming the first chunk (runs independently)
    if (extensionEnabled && autoSendFirstChunk && !autoSentContainers.has(container)) {
      startLiveStream(container);
    }

    const observer = new MutationObserver(() => {
      processContainer(container);

      if (!isElementStreaming(container)) {
        debug('✅ Streaming complete');
        observer.disconnect();
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
   */
  function streamEditTelegram(messageId, text) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'STREAM_EDIT',
        messageId: messageId,
        text: text
      }).catch(() => {});
    } catch (e) {
      // Ignore
    }
  }

  /**
   * Wait for the first content element in a container to have enough text.
   * Resolves with the element, or null if streaming ends first.
   */
  function waitForFirstElement(container, minChars) {
    return new Promise((resolve) => {
      let resolved = false;
      const check = () => {
        if (resolved) return;
        const el = container.querySelector('p, h1, h2, h3, h4, h5, h6, pre, blockquote');
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
        setTimeout(check, 50);
      };
      check();
      // Safety: resolve with whatever we have after 10s
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        resolve(container.querySelector('p, h1, h2, h3, h4, h5, h6, pre, blockquote'));
      }, 10000);
    });
  }

  /**
   * Live stream the first chunk to Telegram.
   * Sends initial text immediately, then edits the message every 500ms as text grows.
   */
  async function startLiveStream(container) {
    // Check skip keywords
    const question = containerQuestions.get(container) || '';
    if (shouldSkipAutoSend(question)) {
      debug('⏭️ Skipping live stream: keyword match');
      autoSentContainers.add(container);
      return;
    }

    // Mark immediately to prevent duplicates
    autoSentContainers.add(container);

    // Wait for first content element with enough text
    const firstElement = await waitForFirstElement(container, 10);
    if (!firstElement) {
      debug('⚠️ Live stream: no content element found');
      return;
    }

    let lastSentText = extractText(firstElement);
    if (!lastSentText || lastSentText.length < 5) return;

    // Send initial text
    debug('📡 Live stream: sending initial text...');
    const result = await sendToTelegram(lastSentText);

    if (!result.success) {
      debug('⚠️ Live stream: initial send failed');
      return;
    }

    const messageId = Array.isArray(result.messageId) ? result.messageId[0] : result.messageId;
    debug(`📡 Live stream: started (msgId: ${messageId})`);

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

      // First chunk is always sent in full — no split threshold
      if (finalText !== lastSentText) {
        await editInTelegram(messageId, finalText);
      }

      // Store in maps for edit/delete
      const msgData = {
        messageId,
        text: finalText,
        isMultiPart: result.isMultiPart
      };
      sentByHash.set(hashText(finalText), msgData);
      if (firstElement.isConnected) {
        sentMessages.set(firstElement, msgData);

        // Clean up streaming indicator, add action buttons
        const indicator = firstElement.querySelector('.persephone-streaming');
        if (indicator) indicator.remove();
        const btnGroup = createActionButtonGroup(firstElement);
        firstElement.appendChild(btnGroup);
      }

      debug('📡 Live stream: finalized');
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

  // ============================================
  // EDIT MODAL
  // ============================================

  function openEditModal(element) {
    const msgData = sentMessages.get(element);
    if (!msgData) {
      showToast('⚠️ Message data not found');
      return;
    }

    // Check if multi-part message
    if (msgData.isMultiPart) {
      showToast('⚠️ Editing multi-part messages is not supported');
      return;
    }

    // Remove existing modal if any
    closeEditModal();

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'persephone-modal-overlay';
    modal.innerHTML = `
      <div class="persephone-modal">
        <div class="persephone-modal-header">
          <span>Edit Message</span>
          <button class="persephone-modal-close">&times;</button>
        </div>
        <div class="persephone-modal-body">
          <textarea class="persephone-edit-textarea">${escapeHtml(msgData.text)}</textarea>
          <div class="persephone-modal-hint">Markdown formatting is supported: *bold*, _italic_, \`code\`</div>
        </div>
        <div class="persephone-modal-footer">
          <button class="persephone-modal-btn persephone-modal-cancel">Cancel</button>
          <button class="persephone-modal-btn persephone-modal-save">Save Changes</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const textarea = modal.querySelector('.persephone-edit-textarea');
    const closeBtn = modal.querySelector('.persephone-modal-close');
    const cancelBtn = modal.querySelector('.persephone-modal-cancel');
    const saveBtn = modal.querySelector('.persephone-modal-save');

    // Focus textarea and move cursor to end
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Close handlers
    closeBtn.addEventListener('click', closeEditModal);
    cancelBtn.addEventListener('click', closeEditModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeEditModal();
    });

    // Save handler
    saveBtn.addEventListener('click', async () => {
      const newText = textarea.value.trim();
      
      if (!newText) {
        showToast('⚠️ Message cannot be empty');
        return;
      }

      if (newText === msgData.text) {
        closeEditModal();
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      const success = await editInTelegram(msgData.messageId, newText);

      if (success) {
        // Remove old hash, add new hash
        const oldHash = hashText(msgData.text);
        sentByHash.delete(oldHash);

        // Update stored text
        msgData.text = newText;
        sentMessages.set(element, msgData);
        sentByHash.set(hashText(newText), msgData);

        closeEditModal();
        showToast('✓ Message updated');
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    });

    // Keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeEditModal();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        saveBtn.click();
      }
    });
  }

  function closeEditModal() {
    const modal = document.querySelector('.persephone-modal-overlay');
    if (modal) modal.remove();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // TELEGRAM API
  // ============================================

  /**
   * Trigger API preconnect in background script
   */
  function triggerPreconnect() {
    if (!isContextValid()) return;
    
    try {
      chrome.runtime.sendMessage({ type: 'PRECONNECT' });
      debug('🔌 Preconnect triggered');
    } catch (e) {
      // Ignore errors
    }
  }

  async function sendToTelegram(text) {
    if (!isContextValid()) {
      showToast('⚠️ Extension disconnected. Please refresh the page.');
      return { success: false };
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_TELEGRAM',
        text: text
      });
      
      if (response?.success) {
        debug('✔ Sent to Telegram, messageId:', response.messageId);
        return { 
          success: true, 
          messageId: response.messageId,
          isMultiPart: response.isMultiPart
        };
      } else {
        debug('✗ Send failed:', response?.error);
        showToast(`Failed: ${response?.error || 'Unknown error'}`);
        return { success: false };
      }
    } catch (error) {
      debug('✗ Error:', error.message);
      if (error.message?.includes('Extension context invalidated')) {
        showToast('⚠️ Extension disconnected. Please refresh the page.');
      }
      return { success: false };
    }
  }

  async function editInTelegram(messageId, newText) {
    if (!isContextValid()) {
      showToast('⚠️ Extension disconnected. Please refresh the page.');
      return false;
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'EDIT_MESSAGE',
        messageId: messageId,
        text: newText
      });
      
      if (response?.success) {
        debug('✔ Message edited');
        return true;
      } else {
        debug('✗ Edit failed:', response?.error);
        showToast(`Edit failed: ${response?.error || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      debug('✗ Edit error:', error.message);
      showToast('⚠️ Failed to edit message');
      return false;
    }
  }

  async function deleteFromTelegram(messageId) {
    if (!isContextValid()) {
      showToast('⚠️ Extension disconnected. Please refresh the page.');
      return false;
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DELETE_MESSAGE',
        messageId: messageId
      });
      
      if (response?.success) {
        debug('✔ Message deleted');
        return true;
      } else {
        debug('✗ Delete failed:', response?.error);
        showToast(`Delete failed: ${response?.error || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      debug('✗ Delete error:', error.message);
      showToast('⚠️ Failed to delete message');
      return false;
    }
  }

  function showToast(message) {
    const existing = document.querySelector('.persephone-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'persephone-toast';
    
    // Success or error styling
    if (message.startsWith('✓')) {
      toast.classList.add('persephone-toast-success');
    }
    
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
  }

  // ============================================
  // STYLES
  // ============================================

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* Button Group */
      .persephone-btn-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 6px;
        vertical-align: middle;
      }
      
      /* Sent Indicator */
      .persephone-sent-indicator {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        border-radius: 50%;
      }
      .persephone-sent-indicator svg {
        width: 10px;
        height: 10px;
        fill: white;
      }
      
      /* Base Button Styles (Send Button) */
      .persephone-inline-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: #fff;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        margin-left: 6px;
        vertical-align: middle;
        opacity: 0.85;
        transition: all 0.15s ease;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
      }
      .persephone-inline-btn:hover {
        opacity: 1;
        transform: scale(1.1);
        box-shadow: 0 2px 8px rgba(255, 255, 255, 0.3);
      }
      .persephone-inline-btn svg {
        width: 12px;
        height: 12px;
        fill: #1a1a1a;
      }

      /* In button group - smaller margins */
      .persephone-btn-group .persephone-inline-btn {
        margin-left: 0;
        width: 20px;
        height: 20px;
      }
      .persephone-btn-group .persephone-inline-btn svg {
        width: 11px;
        height: 11px;
      }

      /* Resend Button */
      .persephone-resend-btn {
        background: #fff;
      }
      .persephone-resend-btn svg {
        fill: #1a1a1a;
      }

      /* Edit Button */
      .persephone-edit-btn {
        background: #525252;
      }
      .persephone-edit-btn svg {
        fill: #fff;
      }

      /* Delete Button */
      .persephone-delete-btn {
        background: #dc2626;
      }
      .persephone-delete-btn svg {
        fill: #fff;
      }

      /* Split Send Button */
      .persephone-split-btn {
        position: relative;
      }
      .persephone-chunk-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        background: #1a1a1a;
        color: #fff;
        font-size: 8px;
        font-weight: 700;
        font-family: system-ui, sans-serif;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        pointer-events: none;
      }
      
      /* Live Streaming Indicator */
      .persephone-streaming {
        background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%) !important;
        animation: persephonePulse 1s ease-in-out infinite;
      }
      @keyframes persephonePulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
      }

      /* Floating Mic Button */
      .persephone-mic-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: none;
        background: #525252;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        z-index: 9999998;
        transition: background 0.2s, transform 0.15s;
      }
      .persephone-mic-btn:hover {
        background: #3f3f3f;
        transform: scale(1.08);
      }
      .persephone-mic-btn:active {
        transform: scale(0.95);
      }
      .persephone-mic-btn svg {
        width: 22px;
        height: 22px;
      }
      .persephone-mic-btn.recording {
        background: #dc2626;
        animation: persephoneMicPulse 1s ease-in-out infinite;
      }
      @keyframes persephoneMicPulse {
        0%, 100% { box-shadow: 0 4px 14px rgba(220, 38, 38, 0.4); transform: scale(1); }
        50% { box-shadow: 0 4px 24px rgba(220, 38, 38, 0.7); transform: scale(1.06); }
      }

      /* Toast */
      .persephone-toast {
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ef4444;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: system-ui, sans-serif;
        font-size: 14px;
        z-index: 9999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: persephoneSlideIn 0.3s ease;
      }
      .persephone-toast-success {
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      }
      
      @keyframes persephoneSlideIn {
        from { opacity: 0; transform: translateY(-20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      /* Modal */
      .persephone-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999999;
        animation: persephoneFadeIn 0.2s ease;
      }
      
      @keyframes persephoneFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      .persephone-modal {
        background: #fff;
        border-radius: 12px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        border: 1px solid #e5e5e5;
        animation: persephoneSlideUp 0.3s ease;
      }

      @keyframes persephoneSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .persephone-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #eee;
        font-family: system-ui, sans-serif;
        font-weight: 600;
        font-size: 16px;
        color: #1a1a1a;
      }

      .persephone-modal-close {
        background: none;
        border: none;
        color: #999;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        transition: color 0.2s;
      }
      .persephone-modal-close:hover {
        color: #1a1a1a;
      }

      .persephone-modal-body {
        padding: 20px;
        flex: 1;
        overflow: auto;
      }

      .persephone-edit-textarea {
        width: 100%;
        min-height: 200px;
        padding: 12px;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fafafa;
        color: #1a1a1a;
        font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
        font-size: 14px;
        line-height: 1.5;
        resize: vertical;
        box-sizing: border-box;
      }
      .persephone-edit-textarea:focus {
        outline: none;
        border-color: #1a1a1a;
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.06);
      }

      .persephone-modal-hint {
        margin-top: 8px;
        font-family: system-ui, sans-serif;
        font-size: 12px;
        color: #888;
      }

      .persephone-modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 16px 20px;
        border-top: 1px solid #eee;
      }

      .persephone-modal-btn {
        padding: 10px 20px;
        border-radius: 6px;
        border: none;
        font-family: system-ui, sans-serif;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
      }

      .persephone-modal-cancel {
        background: #fff;
        color: #666;
        border: 1px solid #e0e0e0;
      }
      .persephone-modal-cancel:hover {
        background: #f5f5f5;
        color: #1a1a1a;
      }

      .persephone-modal-save {
        background: #1a1a1a;
        color: white;
      }
      .persephone-modal-save:hover {
        background: #333;
      }
      .persephone-modal-save:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `;
    document.head.appendChild(style);
  }

  // ============================================
  // AUTO-SEND
  // ============================================

  async function loadSettings() {
    if (!isContextValid()) return;

    try {
      const autoSendKey = SITE === 'claude' ? 'autoSendClaude' : 'autoSendGrok';
      const settings = await chrome.storage.sync.get(['extensionEnabled', autoSendKey, 'autoSendSkipKeywords', 'splitThreshold', 'autoSubmitVoice']);
      extensionEnabled = settings.extensionEnabled !== false; // Default true
      autoSendFirstChunk = settings[autoSendKey] !== false; // Default true
      autoSendSkipKeywords = settings.autoSendSkipKeywords || [...DEFAULT_SKIP_KEYWORDS];
      splitThreshold = settings.splitThreshold || 250;
      autoSubmitVoice = settings.autoSubmitVoice === true; // Default false
      debug(`🔌 Extension: ${extensionEnabled ? 'ON' : 'OFF'}, Auto-send: ${autoSendFirstChunk ? 'ON' : 'OFF'}, Skip keywords: ${autoSendSkipKeywords.length}`);
    } catch (e) {
      debug('Failed to load settings');
    }
  }

  function toggleExtensionEnabled() {
    extensionEnabled = !extensionEnabled;

    // Save to storage
    if (isContextValid()) {
      chrome.storage.sync.set({ extensionEnabled });
    }

    // Show indicator and update UI
    showExtensionIndicator(extensionEnabled);

    if (extensionEnabled) {
      // Re-scan when enabled
      scanAllResponses();
    } else {
      // Remove all buttons when disabled
      removeAllButtons();
    }

    debug(`🔌 Extension toggled: ${extensionEnabled ? 'ON' : 'OFF'}`);
  }

  function showExtensionIndicator(enabled) {
    const existing = document.querySelector('.persephone-extension-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement('div');
    indicator.className = 'persephone-extension-indicator';
    indicator.innerHTML = enabled
      ? '✓ Persephone ON'
      : '✗ Persephone OFF';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${enabled ? '#22c55e' : '#666'};
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      font-weight: 500;
      z-index: 9999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: persephoneSlideIn 0.3s ease;
    `;

    document.body.appendChild(indicator);
    setTimeout(() => indicator.remove(), 2000);
  }

  function removeAllButtons() {
    document.querySelectorAll('.persephone-inline-btn, .persephone-btn-group').forEach(el => el.remove());
    debug('🧹 Removed all buttons');
  }

  function toggleAutoSend() {
    autoSendFirstChunk = !autoSendFirstChunk;

    // Save to per-site storage key
    if (isContextValid()) {
      const autoSendKey = SITE === 'claude' ? 'autoSendClaude' : 'autoSendGrok';
      chrome.storage.sync.set({ [autoSendKey]: autoSendFirstChunk });
    }

    // Show indicator
    showAutoSendIndicator(autoSendFirstChunk);
    debug(`⚡ Auto-send toggled: ${autoSendFirstChunk ? 'ON' : 'OFF'}`);
  }

  function showAutoSendIndicator(enabled) {
    // Remove existing indicator
    const existing = document.querySelector('.persephone-autosend-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement('div');
    indicator.className = 'persephone-autosend-indicator';
    indicator.innerHTML = enabled
      ? '⚡ Auto-send ON'
      : '⚡ Auto-send OFF';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${enabled ? '#1a1a1a' : '#666'};
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      font-weight: 500;
      z-index: 9999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: persephoneSlideIn 0.3s ease;
    `;

    document.body.appendChild(indicator);
    setTimeout(() => indicator.remove(), 2000);
  }

  // ============================================
  // VOICE INPUT (MacWhisper)
  // ============================================

  let micRecording = false;

  /**
   * Find the chat input element, trying the primary selector then fallbacks.
   */
  function findChatInput() {
    let el = document.querySelector(SELECTORS.chatInput);
    if (el) return el;
    // Fallback: any ProseMirror contenteditable (both sites use tiptap/ProseMirror)
    el = document.querySelector('div.ProseMirror[contenteditable="true"]');
    if (el) return el;
    el = document.querySelector('[contenteditable="true"]');
    return el;
  }

  /**
   * Try to click the send/submit button. Retries up to maxAttempts
   * since the button may appear after text enters the input.
   */
  function submitChatInput() {
    const input = findChatInput();

    // 1. Try the send/submit button if visible and enabled
    const sendBtn = document.querySelector(SELECTORS.sendButton);
    if (sendBtn && !sendBtn.disabled && sendBtn.offsetParent !== null) {
      sendBtn.click();
      debug('🎙️ Submit: clicked send button');
      showToast('Voice message sent');
      return;
    }

    // 2. Force-click the button even if hidden/disabled (tab-switch scenario:
    //    framework state is stale but clicking may still trigger the handler)
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.click();
      debug('🎙️ Submit: force-clicked send button');
      showToast('Voice message sent');
      return;
    }

    // 3. Try form.requestSubmit() (Grok wraps input in a <form>)
    if (input) {
      const form = input.closest('form');
      if (form) {
        try {
          form.requestSubmit();
          debug('🎙️ Submit: form.requestSubmit()');
          showToast('Voice message sent');
          return;
        } catch (e) {
          debug('🎙️ Submit: requestSubmit failed:', e.message);
        }
      }
    }

    // 4. Enter key on the input
    if (input) {
      const props = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      input.dispatchEvent(new KeyboardEvent('keydown', props));
      input.dispatchEvent(new KeyboardEvent('keypress', props));
      input.dispatchEvent(new KeyboardEvent('keyup', props));
      debug('🎙️ Submit: dispatched Enter key sequence');
      showToast('Voice message sent');
    } else {
      debug('🎙️ Submit: failed — no input or button found');
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
      debug('🎙️ Cannot watch — chat input not found');
      return;
    }

    const POLL_MS = 50;
    debug('🎙️ Watching input for transcription (polling)...');

    const pollInterval = setInterval(() => {
      // Re-find input each poll (DOM may rebuild after tab switch)
      const input = findChatInput();
      if (!input) return;

      const current = getInputValue(input).trim();

      if (current.length > 0 && current !== inputBefore) {
        // New text detected — fire immediately
        clearInterval(pollInterval);
        const transcription = inputBefore ? current.replace(inputBefore, '').trim() : current;
        console.log('[Persephone] TRANSCRIPTION:', transcription);
        debug('🎙️ Transcription:', transcription);

        // Broadcast to other Grok/Claude tabs BEFORE submitting locally
        debug('🎙️ Broadcasting to other tabs, text:', current.substring(0, 50));
        try {
          chrome.runtime.sendMessage({ type: 'BROADCAST_QUESTION', text: current })
            .then(r => debug('🎙️ Broadcast response:', r))
            .catch(err => debug('🎙️ Broadcast error:', err));
        } catch (e) {
          debug('🎙️ Broadcast send threw:', e);
        }

        if (autoSubmitVoice) {
          // Focus input and poke the framework before submitting
          input.focus();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          submitChatInput();
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
          console.log('[Persephone] TRANSCRIPTION (timeout):', final);
          debug('🎙️ Transcription (timeout):', final);
        }
      }
    }, 30000);
  }

  /**
   * Insert text into the chat input and submit (used by broadcast from other tabs).
   * Uses multiple strategies because execCommand requires focus which the
   * non-active tab in split view may not have.
   */
  function insertTextAndSubmit(text) {
    debug('🎙️ Broadcast received:', text.substring(0, 50));
    const input = findChatInput();
    if (!input) {
      debug('🎙️ Broadcast: no chat input found');
      return;
    }

    // Try to grab focus
    window.focus();
    input.focus();

    let inserted = false;

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
      inserted = true;
    } else {
      // Contenteditable (ProseMirror) — try execCommand first
      try {
        const sel = window.getSelection();
        sel.selectAllChildren(input);
        document.execCommand('delete');
        inserted = document.execCommand('insertText', false, text);
      } catch (e) {
        debug('🎙️ execCommand failed:', e.message);
      }

      // Check if execCommand actually inserted text
      if (!inserted || !getInputValue(input).trim()) {
        debug('🎙️ execCommand did not work, using innerHTML fallback');
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
      input.focus();
      submitChatInput();
      debug('🎙️ Broadcast: submitted');
    }, 100);
  }

  /**
   * Handle mic button click — toggle MacWhisper recording.
   */
  async function handleMicClick() {
    if (!isContextValid()) {
      showToast('Extension disconnected. Please refresh.');
      return;
    }

    const micBtn = document.querySelector('.persephone-mic-btn');
    if (!micBtn) return;

    // Always keep focus on the chat input, not the button
    const input = findChatInput();
    if (input) input.focus();

    if (!micRecording) {
      // Starting recording
      const result = await chrome.runtime.sendMessage({ type: 'TOGGLE_WHISPER' });
      if (result?.success) {
        micRecording = true;
        micBtn.classList.add('recording');
        if (input) input.focus();
        debug('🎙️ Recording started');
      } else {
        showToast('Failed to start MacWhisper');
        debug('🎙️ Start failed:', result?.error);
      }
    } else {
      // Stopping recording — capture what's in the input before MacWhisper types
      const inputBefore = input ? getInputValue(input).trim() : '';

      // refocus: true tells the native host to re-activate Chrome after F5
      const result = await chrome.runtime.sendMessage({ type: 'TOGGLE_WHISPER', refocus: true });
      micRecording = false;
      micBtn.classList.remove('recording');

      // Re-focus input so MacWhisper types into it
      if (input) input.focus();
      debug('🎙️ Recording stopped, input focused, polling for transcription...');

      // Poll the input for MacWhisper's typing
      watchForTranscription(inputBefore);
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
    debug('🎙️ Mic button injected');
  }

  // ============================================
  // INIT
  // ============================================

  function init() {
    debug('🚀 Persephone v3.6 (with voice input)');

    injectStyles();
    injectMicButton();

    // Load settings
    loadSettings();

    // Trigger API preconnect immediately
    triggerPreconnect();

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
      }
    });

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'EXTENSION_ENABLED_CHANGED') {
        extensionEnabled = request.extensionEnabled;
        showExtensionIndicator(extensionEnabled);
        if (extensionEnabled) {
          scanAllResponses();
        } else {
          removeAllButtons();
        }
      }
      if (request.type === 'AUTO_SEND_CHANGED') {
        autoSendFirstChunk = request.autoSendFirstChunk;
        showAutoSendIndicator(autoSendFirstChunk);
      }
      if (request.type === 'SKIP_KEYWORDS_CHANGED') {
        autoSendSkipKeywords = request.keywords || [...DEFAULT_SKIP_KEYWORDS];
        debug(`📝 Skip keywords updated: ${autoSendSkipKeywords.length} keywords`);
      }
      if (request.type === 'SPLIT_THRESHOLD_CHANGED') {
        splitThreshold = request.splitThreshold || 250;
        debug(`📝 Split threshold updated: ${splitThreshold}`);
      }
      if (request.type === 'AUTO_SUBMIT_VOICE_CHANGED') {
        autoSubmitVoice = request.autoSubmitVoice === true;
        debug(`🎙️ Auto-submit voice: ${autoSubmitVoice ? 'ON' : 'OFF'}`);
      }
      if (request.type === 'INSERT_AND_SUBMIT') {
        insertTextAndSubmit(request.text);
      }
    });

    setTimeout(() => {
      // Set initial container count to avoid auto-sending existing responses
      const existingContainers = document.querySelectorAll(SELECTORS.responseContainer);
      lastContainerCount = existingContainers.length;

      const count = scanAllResponses();
      debug(`📋 Initial scan: ${count} buttons added, ${lastContainerCount} existing responses`);

      // Start global observer for immediate detection of new responses
      startGlobalObserver();

      // Fallback polling (fast interval for reliability)
      setInterval(() => {
        checkForNewResponse();
        scanAllResponses();
      }, 200);

      debug('✅ Ready');
    }, 500);
  }

  init();

})();