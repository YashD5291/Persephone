(function() {
  'use strict';
  const P = window.Persephone;

  const {
    state, log, hashText, extractText, splitText, isElementStreaming, getResponseScope, sel, 
    getContainerId, isContextValid, MSG, sendToTelegram, editInTelegram, deleteFromTelegram, 
    showToast
  } = P;

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
        state.sentMessages.set(element, msgData);
        state.sentByHash.set(textHash, msgData);

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

        state.sentByHash.set(textHash, msgData);

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

      const msgData = state.sentMessages.get(element);
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
        state.sentMessages.set(element, newMsgData);
        state.sentByHash.set(hashText(msgData.text), newMsgData);
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

      const msgData = state.sentMessages.get(element);
      if (!msgData) return;

      // Show confirmation
      if (!confirm('Delete this message from Telegram?')) return;

      deleteBtn.style.opacity = '0.5';
      deleteBtn.style.pointerEvents = 'none';

      const success = await deleteFromTelegram(msgData.messageId);

      if (success) {
        // Remove from both maps
        const textHash = hashText(msgData.text);
        state.sentMessages.delete(element);
        state.sentByHash.delete(textHash);

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
    if (state.sentByHash.has(hash)) {
      const msgData = state.sentByHash.get(hash);
      state.sentMessages.set(element, msgData);
      const btnGroup = createActionButtonGroup(element);
      element.appendChild(btnGroup);
      log.state(`♻️ Restored sent state for: ${text.substring(0, 50)}...`);
      return true;
    }

    // Long paragraph: split into two sub-chunks (only for non-streamed paragraphs)
    if (text.length > state.splitThreshold) {
      const [chunk1, chunk2] = splitText(text);
      const hash1 = hashText(chunk1);
      const hash2 = hashText(chunk2);

      // Check if chunks were already sent (restore path)
      const sent1 = state.sentByHash.has(hash1);
      const sent2 = state.sentByHash.has(hash2);

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

      if (!state.seenTexts.has(hash)) {
        state.seenTexts.add(hash);
        log.ui.debug(`✅ <${element.tagName.toLowerCase()}> (split): ${text.substring(0, 50)}...`);
      }

      return true;
    }

    // Create send button
    const btn = createSendButton(element, text);
    element.appendChild(btn);

    if (!state.seenTexts.has(hash)) {
      state.seenTexts.add(hash);
      log.ui.debug(`✅ <${element.tagName.toLowerCase()}>: ${text.substring(0, 50)}...`);
    }

    return true;
  }

  /**
   * Scan a container and add buttons to all content elements
   */
  function processContainer(container) {
    if (!container || !state.extensionEnabled) return 0;

    // Scope to response section only (skips thinking content for Claude)
    const scope = getResponseScope(container);
    if (!scope) return 0; // Thinking in progress, response not started

    // Add buttons to lists (full) and individual list items
    const elements = scope.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, table');
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
    if (!state.extensionEnabled) return 0;

    const containers = sel.queryAll('responseContainer');
    let totalAdded = 0;

    containers.forEach(container => {
      totalAdded += processContainer(container);
    });

    if (totalAdded > 0) {
      log.ui.debug(`📦 Added ${totalAdded} buttons`);
    }

    return totalAdded;
  }

  // ============================================
  // EDIT MODAL
  // ============================================

  function openEditModal(element) {
    const msgData = state.sentMessages.get(element);
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
        state.sentByHash.delete(oldHash);

        // Update stored text
        msgData.text = newText;
        state.sentMessages.set(element, msgData);
        state.sentByHash.set(hashText(newText), msgData);

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

  function removeAllButtons() {
    document.querySelectorAll('.persephone-inline-btn, .persephone-btn-group').forEach(el => el.remove());
    log.ui('🧹 Removed all buttons');
  }


  // --- Exports ---
  Object.assign(P, {
    createSendButton, createSplitSendButton, createActionButtonGroup, replaceWithActionButtons, 
    addButtonToElement, processContainer, scanAllResponses, openEditModal, closeEditModal, 
    escapeHtml, removeAllButtons
  });
})();
