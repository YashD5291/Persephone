// Persephone - Content Script for grok.com
// v3.1 - Inline send buttons only, no floating panel

(function() {
  'use strict';

  let seenTexts = new Set();
  let currentStreamingContainer = null;

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
    if (tag === 'ul' || tag === 'ol') return formatList(element, tag);
    if (tag === 'pre') return formatCode(element);
    if (tag === 'blockquote') return `> ${cleanText(element)}`;
    if (tag === 'table') return formatTable(element);
    
    return cleanText(element);
  }

  function cleanText(element) {
    const clone = element.cloneNode(true);
    
    // Remove unwanted elements
    clone.querySelectorAll('button, svg, img, .persephone-inline-btn, .animate-gaussian, .citation')
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

  function addButtonToElement(element) {
    // Skip if already has button
    if (element.querySelector('.persephone-inline-btn')) return false;
    
    // Skip if still streaming
    if (isElementStreaming(element)) return false;
    
    // Extract text
    const text = extractText(element);
    if (!text || text.length < 5) return false;

    // Create button
    const btn = document.createElement('button');
    btn.className = 'persephone-inline-btn';
    btn.title = 'Send to Telegram';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
    
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (btn.classList.contains('sent')) return;
      
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
      
      const success = await sendToTelegram(text);
      
      if (success) {
        btn.classList.add('sent');
        btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        btn.title = 'Sent!';
      } else {
        btn.style.opacity = '0.8';
        btn.style.pointerEvents = 'auto';
      }
    });

    element.style.position = 'relative';
    element.appendChild(btn);

    // Track
    const hash = hashText(text);
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
    if (!container) return 0;
    
    const elements = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, table');
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
    
    if (latest !== currentStreamingContainer) {
      const isStreaming = isElementStreaming(latest);
      
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
   * Watch a streaming response for new chunks
   */
  function startStreamingObserver(container) {
    const observer = new MutationObserver(() => {
      processContainer(container);
      
      if (!isElementStreaming(container)) {
        debug('✅ Streaming complete');
        observer.disconnect();
        setTimeout(() => processContainer(container), 200);
      }
    });
    
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });
    
    processContainer(container);
  }

  // ============================================
  // TELEGRAM
  // ============================================

  async function sendToTelegram(text) {
    if (!isContextValid()) {
      showToast('⚠️ Extension disconnected. Please refresh the page.');
      return false;
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_TELEGRAM',
        text: text
      });
      
      if (response?.success) {
        debug('✓ Sent to Telegram');
        return true;
      } else {
        debug('✗ Send failed:', response?.error);
        showToast(`Failed: ${response?.error || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      debug('✗ Error:', error.message);
      if (error.message?.includes('Extension context invalidated')) {
        showToast('⚠️ Extension disconnected. Please refresh the page.');
      }
      return false;
    }
  }

  function showToast(message) {
    const existing = document.querySelector('.persephone-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'persephone-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 5000);
  }

  // ============================================
  // STYLES
  // ============================================

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .persephone-inline-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
        border: none;
        border-radius: 5px;
        cursor: pointer;
        margin-left: 6px;
        vertical-align: middle;
        opacity: 0.7;
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(168, 85, 247, 0.3);
      }
      .persephone-inline-btn:hover {
        opacity: 1;
        transform: scale(1.1);
        box-shadow: 0 4px 8px rgba(168, 85, 247, 0.4);
      }
      .persephone-inline-btn.sent {
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        cursor: default;
        box-shadow: 0 2px 4px rgba(34, 197, 94, 0.3);
      }
      .persephone-inline-btn svg {
        width: 12px;
        height: 12px;
        fill: white;
      }
      
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
      
      @keyframes persephoneSlideIn {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ============================================
  // INIT
  // ============================================

  function init() {
    debug('🚀 Persephone v3.1 (inline buttons only)');

    injectStyles();

    setTimeout(() => {
      const count = scanAllResponses();
      debug(`📋 Initial scan: ${count} buttons added`);

      // Poll for new responses and rescan for DOM changes
      setInterval(() => {
        checkForNewResponse();
        scanAllResponses();
      }, 1000);

      debug('✅ Ready');
    }, 1500);
  }

  init();

})();