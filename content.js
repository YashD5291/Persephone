// Persephone - Content Script for grok.com
// Monitors Grok responses and sends them to Telegram

(function() {
  'use strict';

  // State
  let enabled = false;
  let processedMessages = new Set();
  let initialLoadComplete = false;
  let observer = null;
  let pendingResponse = null;
  let stabilityTimer = null;

  // Configuration
  const STABILITY_DELAY = 1500; // Wait for response to stabilize (stop streaming)
  const INITIAL_LOAD_DELAY = 2000; // Wait before starting to track new messages

  // Initialize
  init();

  async function init() {
    console.log('[Persephone] Initializing on grok.com');

    // Load settings
    const settings = await chrome.storage.sync.get(['enabled']);
    enabled = settings.enabled || false;

    // Mark existing messages as processed (don't send old messages)
    setTimeout(() => {
      markExistingMessagesAsProcessed();
      initialLoadComplete = true;
      startObserving();
      console.log('[Persephone] Ready - monitoring for new Grok responses');
    }, INITIAL_LOAD_DELAY);

    // Listen for settings changes
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'SETTINGS_UPDATED') {
        enabled = request.enabled;
        console.log(`[Persephone] Auto-send ${enabled ? 'enabled' : 'disabled'}`);
      }
    });
  }

  function markExistingMessagesAsProcessed() {
    const messages = findGrokMessages();
    messages.forEach(msg => {
      const hash = hashMessage(msg.textContent);
      processedMessages.add(hash);
    });
    console.log(`[Persephone] Marked ${processedMessages.size} existing messages as processed`);
  }

  function findGrokMessages() {
    // Grok's assistant messages - try multiple selectors for robustness
    const selectors = [
      '[data-testid="message-assistant"]',
      '.message-assistant',
      '[class*="assistant"]',
      'div[class*="MessageContent"]',
      // Common patterns in AI chat UIs
      '.prose',
      '.markdown-body',
      '[data-message-author="assistant"]'
    ];

    for (const selector of selectors) {
      const messages = document.querySelectorAll(selector);
      if (messages.length > 0) {
        return Array.from(messages);
      }
    }

    // Fallback: Look for message containers and filter by context
    const allMessages = document.querySelectorAll('[class*="message"], [class*="Message"]');
    return Array.from(allMessages).filter(el => {
      const classes = el.className.toLowerCase();
      return classes.includes('assistant') || classes.includes('grok') || classes.includes('bot');
    });
  }

  function findLatestGrokMessage() {
    const messages = findGrokMessages();
    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  function isMessageStreaming(element) {
    // Check for common streaming indicators
    const streamingIndicators = [
      '[class*="streaming"]',
      '[class*="typing"]',
      '[class*="loading"]',
      '.cursor-blink',
      '[data-streaming="true"]'
    ];

    for (const selector of streamingIndicators) {
      if (element.querySelector(selector) || element.matches(selector)) {
        return true;
      }
    }

    // Check if the element or its parent has streaming-related attributes
    const hasStreamingAttr = element.closest('[data-streaming]') ||
                            element.querySelector('[data-streaming]');
    if (hasStreamingAttr) {
      return hasStreamingAttr.getAttribute('data-streaming') === 'true';
    }

    return false;
  }

  function extractMessageText(element) {
    // Clone to avoid modifying the DOM
    const clone = element.cloneNode(true);

    // Remove any UI elements that shouldn't be in the text
    const uiElements = clone.querySelectorAll('button, [class*="action"], [class*="toolbar"]');
    uiElements.forEach(el => el.remove());

    // Get text content, preserving some structure
    let text = '';

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();

        // Add line breaks for block elements
        if (['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          if (text && !text.endsWith('\n')) {
            text += '\n';
          }
        }

        // Handle code blocks
        if (tag === 'pre' || tag === 'code') {
          text += '```\n';
        }

        for (const child of node.childNodes) {
          walk(child);
        }

        if (tag === 'pre' || tag === 'code') {
          if (!text.endsWith('\n')) text += '\n';
          text += '```\n';
        }

        if (['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          if (!text.endsWith('\n')) {
            text += '\n';
          }
        }
      }
    };

    walk(clone);

    // Clean up
    text = text
      .replace(/```\n```/g, '') // Remove empty code blocks
      .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines
      .trim();

    return text;
  }

  function hashMessage(text) {
    // Simple hash for deduplication
    let hash = 0;
    const str = text.substring(0, 500); // Use first 500 chars for hash
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  function startObserving() {
    if (observer) {
      observer.disconnect();
    }

    // Find the chat container
    const chatContainer = document.querySelector('[class*="chat"], [class*="conversation"], main, #root');

    if (!chatContainer) {
      console.log('[Persephone] Chat container not found, retrying...');
      setTimeout(startObserving, 1000);
      return;
    }

    observer = new MutationObserver(handleMutations);

    observer.observe(chatContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    console.log('[Persephone] Observer started');
  }

  function handleMutations(mutations) {
    if (!initialLoadComplete || !enabled) return;

    // Check if there's a new or updated Grok message
    const latestMessage = findLatestGrokMessage();

    if (!latestMessage) return;

    const currentText = extractMessageText(latestMessage);
    const currentHash = hashMessage(currentText);

    // Skip if already processed or empty
    if (processedMessages.has(currentHash) || !currentText.trim()) {
      return;
    }

    // Skip if still streaming
    if (isMessageStreaming(latestMessage)) {
      return;
    }

    // Track this as a pending response and wait for stability
    if (pendingResponse !== currentHash) {
      pendingResponse = currentHash;

      // Clear existing timer
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
      }

      // Wait for the message to stabilize (stop changing)
      stabilityTimer = setTimeout(() => {
        // Re-check the message after delay
        const finalMessage = findLatestGrokMessage();
        if (!finalMessage) return;

        const finalText = extractMessageText(finalMessage);
        const finalHash = hashMessage(finalText);

        // Only send if the message hasn't changed and isn't streaming
        if (finalHash === pendingResponse && !isMessageStreaming(finalMessage) && !processedMessages.has(finalHash)) {
          processedMessages.add(finalHash);
          sendToTelegram(finalText);
        }

        pendingResponse = null;
      }, STABILITY_DELAY);
    }
  }

  async function sendToTelegram(text) {
    if (!enabled) {
      console.log('[Persephone] Auto-send disabled, skipping');
      return;
    }

    console.log('[Persephone] Sending message to Telegram...');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_TELEGRAM',
        text: text
      });

      if (response.success) {
        showToast('Sent to Telegram', 'success');
        console.log('[Persephone] Message sent successfully');
      } else {
        showToast(`Failed: ${response.error}`, 'error');
        console.error('[Persephone] Failed to send:', response.error);
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
      console.error('[Persephone] Error sending message:', error);
    }
  }

  function showToast(message, type = 'info') {
    // Remove existing toast
    const existing = document.getElementById('persephone-toast');
    if (existing) {
      existing.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'persephone-toast';
    toast.textContent = message;

    const colors = {
      success: { bg: 'rgba(34, 197, 94, 0.95)', border: '#22c55e' },
      error: { bg: 'rgba(239, 68, 68, 0.95)', border: '#ef4444' },
      info: { bg: 'rgba(168, 85, 247, 0.95)', border: '#a855f7' }
    };

    const color = colors[type] || colors.info;

    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${color.bg};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      border: 1px solid ${color.border};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      animation: persephone-slide-in 0.3s ease-out;
    `;

    // Add animation styles if not already present
    if (!document.getElementById('persephone-styles')) {
      const styles = document.createElement('style');
      styles.id = 'persephone-styles';
      styles.textContent = `
        @keyframes persephone-slide-in {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes persephone-slide-out {
          from {
            transform: translateX(0);
            opacity: 1;
          }
          to {
            transform: translateX(100%);
            opacity: 0;
          }
        }
      `;
      document.head.appendChild(styles);
    }

    document.body.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
      toast.style.animation = 'persephone-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

})();
