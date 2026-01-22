// Persephone - Content Script for grok.com
// Floating panel for manual chunk selection

(function() {
  'use strict';

  let enabled = false;
  let seenHashes = new Set();
  let lastResponseId = null;
  let checkInterval = null;
  let chunks = [];
  let panel = null;

  const DEBUG = true;

  function debug(...args) {
    if (DEBUG) console.log('[Persephone]', ...args);
  }

  init();

  async function init() {
    debug('Initializing');

    const settings = await chrome.storage.sync.get(['enabled']);
    enabled = settings.enabled || false;

    createPanel();

    setTimeout(() => {
      captureExistingContent();
      startPolling();
      debug('=== READY ===');
    }, 3000);

    chrome.runtime.onMessage.addListener((request) => {
      if (request.type === 'SETTINGS_UPDATED') {
        enabled = request.enabled;
      }
    });
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'persephone-panel';
    panel.innerHTML = `
      <div class="p-header">
        <span class="p-title">Persephone</span>
        <div class="p-controls">
          <button class="p-btn p-clear" title="Clear all">Clear</button>
          <button class="p-btn p-minimize" title="Minimize">_</button>
        </div>
      </div>
      <div class="p-chunks"></div>
      <div class="p-actions">
        <button class="p-btn p-send-selected">Send Selected</button>
        <button class="p-btn p-send-all">Send All</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      .persephone-inline-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: #a855f7;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-left: 8px;
        vertical-align: middle;
        opacity: 0.7;
        transition: opacity 0.2s, transform 0.2s;
      }
      .persephone-inline-btn:hover {
        opacity: 1;
        transform: scale(1.1);
      }
      .persephone-inline-btn.sent {
        background: #22c55e;
        cursor: default;
      }
      .persephone-inline-btn svg {
        width: 12px;
        height: 12px;
        fill: white;
      }
      #persephone-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 350px;
        max-height: 500px;
        background: #1a1a2e;
        border: 1px solid #3a3a5c;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #eee;
        z-index: 999999;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
      }
      #persephone-panel.minimized {
        max-height: 40px;
        overflow: hidden;
      }
      #persephone-panel.minimized .p-chunks,
      #persephone-panel.minimized .p-actions {
        display: none;
      }
      .p-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid #3a3a5c;
        cursor: move;
      }
      .p-title {
        font-weight: 600;
        color: #a855f7;
      }
      .p-controls {
        display: flex;
        gap: 6px;
      }
      .p-btn {
        background: #3a3a5c;
        border: none;
        color: #ccc;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      }
      .p-btn:hover {
        background: #4a4a6c;
      }
      .p-chunks {
        flex: 1;
        overflow-y: auto;
        max-height: 350px;
        padding: 8px;
      }
      .p-chunk {
        display: flex;
        gap: 8px;
        padding: 8px;
        margin-bottom: 6px;
        background: #252542;
        border-radius: 6px;
        align-items: flex-start;
      }
      .p-chunk.sent {
        opacity: 0.5;
      }
      .p-chunk input[type="checkbox"] {
        margin-top: 3px;
        accent-color: #a855f7;
      }
      .p-chunk-content {
        flex: 1;
        word-break: break-word;
        max-height: 80px;
        overflow: hidden;
        line-height: 1.4;
      }
      .p-chunk-tag {
        font-size: 10px;
        color: #a855f7;
        background: rgba(168, 85, 247, 0.2);
        padding: 2px 6px;
        border-radius: 3px;
        margin-bottom: 4px;
        display: inline-block;
      }
      .p-chunk-text {
        color: #bbb;
        font-size: 12px;
      }
      .p-chunk-send {
        background: #a855f7;
        color: white;
        border: none;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        white-space: nowrap;
      }
      .p-chunk-send:hover {
        background: #9333ea;
      }
      .p-chunk-send:disabled {
        background: #666;
        cursor: not-allowed;
      }
      .p-actions {
        display: flex;
        gap: 8px;
        padding: 10px;
        border-top: 1px solid #3a3a5c;
      }
      .p-actions .p-btn {
        flex: 1;
      }
      .p-send-selected {
        background: #a855f7 !important;
        color: white !important;
      }
      .p-send-selected:hover {
        background: #9333ea !important;
      }
      .p-empty {
        text-align: center;
        color: #666;
        padding: 20px;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    // Event listeners
    panel.querySelector('.p-minimize').addEventListener('click', () => {
      panel.classList.toggle('minimized');
      panel.querySelector('.p-minimize').textContent = panel.classList.contains('minimized') ? '□' : '_';
    });

    panel.querySelector('.p-clear').addEventListener('click', clearChunks);
    panel.querySelector('.p-send-selected').addEventListener('click', sendSelected);
    panel.querySelector('.p-send-all').addEventListener('click', sendAll);

    // Make draggable
    makeDraggable(panel, panel.querySelector('.p-header'));

    updateChunksUI();
  }

  function makeDraggable(element, handle) {
    let offsetX, offsetY, isDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - element.getBoundingClientRect().left;
      offsetY = e.clientY - element.getBoundingClientRect().top;
      element.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      element.style.left = (e.clientX - offsetX) + 'px';
      element.style.top = (e.clientY - offsetY) + 'px';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      element.style.transition = '';
    });
  }

  function updateChunksUI() {
    const container = panel.querySelector('.p-chunks');

    if (chunks.length === 0) {
      container.innerHTML = '<div class="p-empty">No chunks yet. Start a conversation with Grok.</div>';
      return;
    }

    container.innerHTML = chunks.map((chunk, i) => `
      <div class="p-chunk ${chunk.sent ? 'sent' : ''}" data-index="${i}">
        <input type="checkbox" ${chunk.selected ? 'checked' : ''} ${chunk.sent ? 'disabled' : ''}>
        <div class="p-chunk-content">
          <div class="p-chunk-tag">&lt;${chunk.tag}&gt;</div>
          <div class="p-chunk-text">${escapeHtml(chunk.text.substring(0, 150))}${chunk.text.length > 150 ? '...' : ''}</div>
        </div>
        <button class="p-chunk-send" ${chunk.sent ? 'disabled' : ''}>Send</button>
      </div>
    `).join('');

    // Add event listeners
    container.querySelectorAll('.p-chunk').forEach(el => {
      const index = parseInt(el.dataset.index);

      el.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
        chunks[index].selected = e.target.checked;
      });

      el.querySelector('.p-chunk-send').addEventListener('click', () => {
        sendChunk(index);
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function addChunk(tag, text) {
    chunks.push({
      tag,
      text,
      selected: false,
      sent: false
    });
    updateChunksUI();

    // Scroll to bottom
    const container = panel.querySelector('.p-chunks');
    container.scrollTop = container.scrollHeight;
  }

  function clearChunks() {
    chunks = [];
    updateChunksUI();
  }

  async function sendChunk(index) {
    const chunk = chunks[index];
    if (chunk.sent) return;

    const success = await sendToTelegram(chunk.text);
    if (success) {
      chunk.sent = true;
      chunk.selected = false;
      updateChunksUI();
    }
  }

  async function sendSelected() {
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].selected && !chunks[i].sent) {
        await sendChunk(i);
        await sleep(100); // Small delay between sends
      }
    }
  }

  async function sendAll() {
    for (let i = 0; i < chunks.length; i++) {
      if (!chunks[i].sent) {
        await sendChunk(i);
        await sleep(100);
      }
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function captureExistingContent() {
    document.querySelectorAll('[id^="response-"].items-start').forEach(resp => {
      const markdown = resp.querySelector('.response-content-markdown');
      if (markdown) {
        markdown.querySelectorAll(':scope > *').forEach(child => {
          const text = extractText(child);
          if (text) seenHashes.add(hash(text));
        });
      }
    });

    const responses = document.querySelectorAll('[id^="response-"].items-start');
    if (responses.length > 0) {
      lastResponseId = responses[responses.length - 1].id;
    }

    debug(`Captured ${seenHashes.size} existing content hashes`);
  }

  function startPolling() {
    checkInterval = setInterval(checkForNewContent, 500);
  }

  function checkForNewContent() {
    const responses = document.querySelectorAll('[id^="response-"].items-start');
    if (responses.length === 0) return;

    const latestResponse = responses[responses.length - 1];

    if (latestResponse.id !== lastResponseId) {
      debug('🆕 New response detected:', latestResponse.id);
      lastResponseId = latestResponse.id;
    }

    const markdown = latestResponse.querySelector('.response-content-markdown');
    if (!markdown) return;

    markdown.querySelectorAll(':scope > *').forEach(child => {
      processElement(child);
    });
  }

  function processElement(element) {
    const tag = element.tagName.toLowerCase();
    if (['section', 'div', 'button', 'span'].includes(tag)) return;

    // Skip if already has our button
    if (element.querySelector('.persephone-inline-btn')) return;

    const text = extractText(element);
    if (!text || text.length < 3) return;

    const h = hash(text);
    if (seenHashes.has(h)) return;

    seenHashes.add(h);
    console.log(`[Persephone] ✅ <${tag}>:`, text);

    // Add inline send button to the element
    addInlineButton(element, text);

    // Add to panel
    addChunk(tag, text);
  }

  function addInlineButton(element, text) {
    const btn = document.createElement('button');
    btn.className = 'persephone-inline-btn';
    btn.title = 'Send to Telegram';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (btn.classList.contains('sent')) return;

      btn.style.opacity = '0.5';
      const success = await sendToTelegram(text);

      if (success) {
        btn.classList.add('sent');
        btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        btn.title = 'Sent!';

        // Also mark as sent in panel
        const chunkIndex = chunks.findIndex(c => c.text === text);
        if (chunkIndex !== -1) {
          chunks[chunkIndex].sent = true;
          updateChunksUI();
        }
      }
      btn.style.opacity = '';
    });

    element.appendChild(btn);
  }

  function extractText(element) {
    const tag = element.tagName.toLowerCase();

    if (tag === 'p') return cleanText(element);
    if (tag.startsWith('h')) return `*${cleanText(element)}*`;
    if (tag === 'ul' || tag === 'ol') return formatList(element, tag);
    if (tag === 'table') return formatTable(element);
    if (tag === 'pre') return formatCode(element);

    return null;
  }

  function cleanText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('button, svg, img, .citation, .no-copy, a[class*="citation"]')
      .forEach(el => el.remove());

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

  function formatTable(table) {
    const rows = [];
    const headers = [];
    table.querySelectorAll('th').forEach(th => headers.push(th.textContent.trim()));
    if (headers.length) rows.push(headers.join(' | '));

    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td').forEach(td => cells.push(td.textContent.trim()));
      if (cells.length) rows.push(cells.join(' | '));
    });
    return rows.join('\n');
  }

  function formatCode(pre) {
    const code = pre.querySelector('code');
    return '```\n' + (code ? code.textContent : pre.textContent).trim() + '\n```';
  }

  function hash(text) {
    let h = 0;
    const str = text.substring(0, 300);
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h = h & h;
    }
    return h.toString();
  }

  async function sendToTelegram(text) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_TELEGRAM',
        text: text
      });
      if (response?.success) {
        debug('✓ Sent');
        return true;
      } else {
        console.error('[Persephone] Failed:', response?.error);
        return false;
      }
    } catch (error) {
      console.error('[Persephone] Error:', error);
      return false;
    }
  }

})();
