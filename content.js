// Persephone - Content Script for grok.com
// v3.3 - Inline send buttons with edit/delete + latency optimizations

(function() {
  'use strict';

  let seenTexts = new Set();
  let currentStreamingContainer = null;
  let lastContainerCount = 0;
  let autoSentContainers = new WeakSet(); // Track containers that had auto-send
  let sentMessages = new Map(); // Track sent messages: element -> { messageId, text }
  let sentByHash = new Map(); // Track sent messages by text hash -> { messageId, text, isMultiPart }
  let autoSendFirstChunk = true; // Enabled by default

  const DEBUG = true;

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
    clone.querySelectorAll('button, svg, img, .persephone-inline-btn, .persephone-btn-group, .animate-gaussian, .citation')
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
               child.classList.contains('persephone-btn-group')
    );
    if (hasOwnButton) return false;

    // Skip if still streaming
    if (isElementStreaming(element)) return false;

    // Extract text
    const text = extractText(element);
    if (!text || text.length < 5) return false;

    const hash = hashText(text);
    element.style.position = 'relative';

    // Check if this text was already sent (container replacement scenario)
    if (sentByHash.has(hash)) {
      const msgData = sentByHash.get(hash);
      // Update element reference in sentMessages
      sentMessages.set(element, msgData);

      // Create action buttons directly (already sent)
      const btnGroup = createActionButtonGroup(element);
      element.appendChild(btnGroup);
      debug(`♻️ Restored sent state for: ${text.substring(0, 50)}...`);
    } else {
      // Create send button
      const btn = createSendButton(element, text);
      element.appendChild(btn);

      // Track
      if (!seenTexts.has(hash)) {
        seenTexts.add(hash);
        debug(`✅ <${element.tagName.toLowerCase()}>: ${text.substring(0, 50)}...`);
      }
    }

    return true;
  }

  /**
   * Scan a container and add buttons to all content elements
   */
  function processContainer(container) {
    if (!container) return 0;

    // Add buttons to lists (full) and individual list items
    const elements = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, table');
    let count = 0;

    elements.forEach(el => {
      if (addButtonToElement(el)) count++;
    });

    return count;
  }

  /**
   * Scan ALL Grok responses on the page
   */
  function scanAllResponses() {
    const containers = document.querySelectorAll('.items-start .response-content-markdown');
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
    const containers = document.querySelectorAll('.items-start .response-content-markdown');
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
              if (node.classList?.contains('response-content-markdown') ||
                  node.querySelector?.('.response-content-markdown') ||
                  node.classList?.contains('items-start') ||
                  node.querySelector?.('.items-start')) {
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
    // Function to try auto-sending first chunk
    const tryAutoSend = () => {
      if (!autoSendFirstChunk || autoSentContainers.has(container)) return false;

      // Find first complete (non-streaming) content element
      const firstElement = container.querySelector('p, h1, h2, h3, h4, h5, h6, pre, blockquote');
      if (firstElement && !isElementStreaming(firstElement)) {
        const text = extractText(firstElement);
        if (text && text.length >= 5) {
          debug('⚡ Auto-sending while streaming...');
          autoSentContainers.add(container);
          autoSendElement(firstElement);
          return true;
        }
      }
      return false;
    };

    const observer = new MutationObserver(() => {
      processContainer(container);
      tryAutoSend();

      if (!isElementStreaming(container)) {
        debug('✅ Streaming complete');
        observer.disconnect();
        clearInterval(autoSendInterval);
        setTimeout(() => processContainer(container), 200);
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Initial check
    processContainer(container);
    tryAutoSend();

    // Also poll quickly for auto-send in case mutations are missed
    const autoSendInterval = setInterval(() => {
      if (autoSentContainers.has(container) || !isElementStreaming(container)) {
        clearInterval(autoSendInterval);
        return;
      }
      tryAutoSend();
    }, 100);

    // Safety: clear interval after 30 seconds
    setTimeout(() => clearInterval(autoSendInterval), 30000);
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
      
      /* Toast */
      .persephone-toast {
        position: fixed;
        bottom: 20px;
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
        from { opacity: 0; transform: translateY(20px); }
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

  async function loadAutoSendSetting() {
    if (!isContextValid()) return;

    try {
      const settings = await chrome.storage.sync.get(['autoSendFirstChunk']);
      autoSendFirstChunk = settings.autoSendFirstChunk !== false; // Default true
      debug(`⚡ Auto-send first chunk: ${autoSendFirstChunk ? 'ON' : 'OFF'}`);
    } catch (e) {
      debug('Failed to load auto-send setting');
    }
  }

  function toggleAutoSend() {
    autoSendFirstChunk = !autoSendFirstChunk;

    // Save to storage
    if (isContextValid()) {
      chrome.storage.sync.set({ autoSendFirstChunk });
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

  async function autoSendElement(element) {
    const text = extractText(element);
    if (!text || text.length < 5) return;

    debug('⚡ Auto-sending first chunk...');

    const result = await sendToTelegram(text);

    if (result.success) {
      const msgData = {
        messageId: result.messageId,
        text: text,
        isMultiPart: result.isMultiPart
      };

      // Store in both maps (by element and by hash)
      sentMessages.set(element, msgData);
      sentByHash.set(hashText(text), msgData);

      // Add button group instead of send button
      const btn = element.querySelector('.persephone-inline-btn');
      if (btn) {
        replaceWithActionButtons(element, btn);
      }

      showToast('✓ Auto-sent first chunk');
    }
  }

  // ============================================
  // INIT
  // ============================================

  function init() {
    debug('🚀 Persephone v3.4 (with auto-send)');

    injectStyles();

    // Load auto-send setting
    loadAutoSendSetting();

    // Trigger API preconnect immediately
    triggerPreconnect();

    // Keyboard shortcut: Cmd+Shift+A (Mac) or Ctrl+Shift+A (Windows/Linux) to toggle auto-send
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        toggleAutoSend();
      }
    });

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'AUTO_SEND_CHANGED') {
        autoSendFirstChunk = request.autoSendFirstChunk;
        showAutoSendIndicator(autoSendFirstChunk);
      }
    });

    setTimeout(() => {
      // Set initial container count to avoid auto-sending existing responses
      const existingContainers = document.querySelectorAll('.items-start .response-content-markdown');
      lastContainerCount = existingContainers.length;

      const count = scanAllResponses();
      debug(`📋 Initial scan: ${count} buttons added, ${lastContainerCount} existing responses`);

      // Start global observer for immediate detection of new responses
      startGlobalObserver();

      // Fallback polling (faster interval for reliability)
      setInterval(() => {
        checkForNewResponse();
        scanAllResponses();
      }, 300);

      debug('✅ Ready');
    }, 500);
  }

  init();

})();