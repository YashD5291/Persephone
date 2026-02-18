(function() {
  'use strict';
  const P = window.Persephone;

  const { MSG, log } = P;

  // Late-bound (defined in modules that load after this one):
  const isContextValid = (...args) => P.isContextValid(...args);

  function streamEditTelegram(messageId, text) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: MSG.STREAM_EDIT,
        messageId: messageId,
        text: text
      }).catch(() => {});
    } catch (e) {
      // Ignore
    }
  }

  /**
   * Trigger API preconnect in background script
   */
  function triggerPreconnect() {
    if (!isContextValid()) return;

    try {
      chrome.runtime.sendMessage({ type: MSG.PRECONNECT });
      log.telegram('🔌 Preconnect triggered');
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
        type: MSG.SEND_TO_TELEGRAM,
        text: text
      });

      if (response?.success) {
        log.telegram('✔ Sent to Telegram, messageId:', response.messageId);
        return { 
          success: true, 
          messageId: response.messageId,
          isMultiPart: response.isMultiPart
        };
      } else {
        log.telegram.error('✗ Send failed:', response?.error);
        showToast(`Failed: ${response?.error || 'Unknown error'}`);
        return { success: false };
      }
    } catch (error) {
      log.telegram.error('✗ Error:', error.message);
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
        type: MSG.EDIT_MESSAGE,
        messageId: messageId,
        text: newText
      });

      if (response?.success) {
        log.telegram('✔ Message edited');
        return true;
      } else {
        log.telegram.error('✗ Edit failed:', response?.error);
        showToast(`Edit failed: ${response?.error || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      log.telegram.error('✗ Edit error:', error.message);
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
        type: MSG.DELETE_MESSAGE,
        messageId: messageId
      });

      if (response?.success) {
        log.telegram('✔ Message deleted');
        return true;
      } else {
        log.telegram.error('✗ Delete failed:', response?.error);
        showToast(`Delete failed: ${response?.error || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      log.telegram.error('✗ Delete error:', error.message);
      showToast('⚠️ Failed to delete message');
      return false;
    }
  }

  function showToast(message, type) {
    const existing = document.querySelector('.persephone-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'persephone-toast';

    // Auto-detect type from message content if not explicitly passed
    if (!type) {
      const isError = /^(⚠️|Failed|Error|Delete failed|Edit failed)/.test(message)
        || /failed|error|disconnect/i.test(message);
      type = isError ? 'error' : 'success';
    }
    toast.classList.add(type === 'error' ? 'persephone-toast-error' : 'persephone-toast-success');

    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  }

  // --- Exports ---
  Object.assign(P, {
    streamEditTelegram, triggerPreconnect, sendToTelegram, editInTelegram, deleteFromTelegram, 
    showToast
  });
})();
