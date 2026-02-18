(function() {
  'use strict';
  const P = window.Persephone;

  const { SITE, sel, state, log } = P;

  /**
   * Get the response content scope within a streaming container.
   * Claude thinking models use a grid inside div[data-is-streaming]:
   *   .row-start-1 = collapsed thinking summary button
   *   .row-start-2 = response area, which has two .row-start-1 children:
   *     - z-[2]: actual response content (empty during thinking, fills when response starts)
   *     - z-[3]: .font-ui tool timeline (web search results, thinking steps)
   * We need to return ONLY the response content child, not the .font-ui timeline.
   * Returns null if thinking is active but response content area isn't ready.
   */
  function getResponseScope(container) {
    if (SITE !== 'claude') return container;
    const responseRow = container.querySelector('.row-start-2');
    if (responseRow) {
      // Find the child .row-start-1 that does NOT contain .font-ui (tool timeline)
      for (const child of responseRow.children) {
        if (child.classList.contains('row-start-1') && !child.querySelector('.font-ui')) {
          return child;
        }
      }
      // Only .font-ui children — response content not ready yet
      return null;
    }
    // No grid yet — if .row-start-1 exists, thinking has started
    if (container.querySelector('.row-start-1')) return null;
    // No grid structure at all — non-thinking model, use container directly
    return container;
  }

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
      const scope = getResponseScope(streamingAncestor);
      if (!scope) return false; // Thinking in progress, no response content yet
      const allContent = Array.from(scope.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, blockquote, li'));
      return allContent.length > 0 && allContent[allContent.length - 1] === element;
    }
    return element.querySelector('.animate-gaussian') !== null;
  }

  function normalizeForHash(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  // cyrb53 — fast 53-bit hash, near-zero collision rate for text
  function hashText(text) {
    const str = normalizeForHash(text);
    if (!str) return '0';
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  /**
   * Get the latest user question from the conversation DOM.
   * User messages use items-end (right-aligned), AI responses use items-start (left-aligned).
   * Extract text from .message-bubble to avoid grabbing button labels.
   */
  function getLatestUserQuestion(container) {
    try {
      if (!sel.primary('userQuestion')) return '';
      const allUserMsgs = sel.queryAll('userQuestion');
      if (allUserMsgs.length === 0) return '';
      const question = allUserMsgs[allUserMsgs.length - 1].textContent.trim();
      return question;
    } catch (e) {
      return '';
    }
  }

  function shouldSkipAutoSend(question) {
    if (!question || state.autoSendSkipKeywords.length === 0) return false;
    const lower = question.toLowerCase();
    return state.autoSendSkipKeywords.some(kw => {
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
    sel.queryAll('cleanTextRemove', clone)
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

  // --- Exports ---
  Object.assign(P, {
    getResponseScope, isContextValid, isElementStreaming, normalizeForHash, hashText, 
    getLatestUserQuestion, shouldSkipAutoSend, extractText, formatListItem, cleanText, formatList, 
    formatCode, formatTable, splitText
  });
})();
