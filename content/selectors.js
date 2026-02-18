(function() {
  'use strict';
  const P = window.Persephone;

  const { log, state } = P;

  // Late-bound (defined in modules that load after this one):
  const showToast = (...args) => P.showToast(...args);

  const SITE = window.location.hostname.includes('claude.ai') ? 'claude' : 'grok';

  const SELECTOR_DEFS = SITE === 'claude' ? {
    responseContainer: {
      primary: 'div[data-is-streaming]',
      fallbacks: ['[data-is-streaming]', '.font-claude-response'],
      critical: true,
    },
    userQuestion: {
      primary: '[data-testid="user-message"]',
      fallbacks: ['[data-testid*="user-message"]'],
      critical: false,
    },
    cleanTextRemove: {
      primary: 'button, svg, img, .persephone-inline-btn, .persephone-btn-group, .persephone-sent-indicator',
      fallbacks: [],
      critical: false,
    },
    chatInput: {
      primary: 'div.ProseMirror[data-testid="chat-input"]',
      fallbacks: [],  // findChatInput has its own fallback chain
      critical: false,
    },
    sendButton: {
      primary: 'button[aria-label="Send message"]',
      fallbacks: ['button[aria-label="Send Message"]', 'button[data-testid="send-button"]'],
      critical: false,
    },
  } : {
    responseContainer: {
      primary: '.items-start .response-content-markdown',
      fallbacks: ['.response-content-markdown'],
      critical: true,
    },
    userQuestion: {
      primary: '[class*="items-end"] .message-bubble',
      fallbacks: ['.message-bubble'],
      critical: false,
    },
    cleanTextRemove: {
      primary: 'button, svg, img, .persephone-inline-btn, .persephone-btn-group, .persephone-sent-indicator, .animate-gaussian, .citation',
      fallbacks: [],
      critical: false,
    },
    chatInput: {
      primary: '.query-bar div.tiptap.ProseMirror[contenteditable="true"]',
      fallbacks: [],  // findChatInput has its own fallback chain
      critical: false,
    },
    sendButton: {
      primary: 'button[aria-label="Submit"]',
      fallbacks: ['button[type="submit"]'],
      critical: false,
    },
  };

  // Selector registry — tries primary first, then fallbacks. Logs when fallback activates.
  const sel = {
    _active: {},  // name -> currently working selector string

    primary(name) {
      const def = SELECTOR_DEFS[name];
      return def ? def.primary : null;
    },

    query(name, root = document) {
      const def = SELECTOR_DEFS[name];
      if (!def) { log.selectors.warn('Unknown selector:', name); return null; }

      let result = root.querySelector(def.primary);
      if (result) { this._active[name] = def.primary; return result; }

      for (const fb of def.fallbacks) {
        result = root.querySelector(fb);
        if (result) {
          if (this._active[name] !== fb) {
            log.selectors.warn(`${name}: primary failed, using fallback "${fb}"`);
            this._active[name] = fb;
          }
          return result;
        }
      }
      return null;
    },

    queryAll(name, root = document) {
      const def = SELECTOR_DEFS[name];
      if (!def) { log.selectors.warn('Unknown selector:', name); return []; }

      let results = root.querySelectorAll(def.primary);
      if (results.length > 0) { this._active[name] = def.primary; return results; }

      for (const fb of def.fallbacks) {
        results = root.querySelectorAll(fb);
        if (results.length > 0) {
          if (this._active[name] !== fb) {
            log.selectors.warn(`${name}: primary failed, using fallback "${fb}"`);
            this._active[name] = fb;
          }
          return results;
        }
      }
      return results;  // empty NodeList
    },
  };

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================
  // SELECTOR HEALTH CHECKS
  // ============================================

  /**
   * Run health checks on all critical selectors.
   * Returns { ok: boolean, results: Array<{ name, selector, count, critical, ok }> }
   * Called on init and periodically to detect site-side DOM changes.
   */
  function runSelectorHealthCheck() {
    const checks = [];

    // Check each SELECTOR_DEFS entry (primary + any active fallback)
    for (const [name, def] of Object.entries(SELECTOR_DEFS)) {
      const primaryCount = document.querySelectorAll(def.primary).length;
      const activeFallback = sel._active[name] !== def.primary ? sel._active[name] : null;
      checks.push({
        name,
        selector: def.primary,
        count: primaryCount,
        critical: def.critical,
        ok: primaryCount > 0,
        fallbackActive: activeFallback,
      });
    }

    // Site-specific structural selectors (extra checks beyond SELECTOR_DEFS)
    const structural = SITE === 'claude' ? [
      { name: 'claude:markdown-content', selector: '.standard-markdown, .progressive-markdown', critical: false },
      { name: 'claude:font-response', selector: '.font-claude-response', critical: false },
    ] : [
      { name: 'grok:streaming-indicator', selector: '.animate-gaussian', critical: false },
    ];

    for (const { name, selector, critical } of structural) {
      const count = document.querySelectorAll(selector).length;
      checks.push({ name, selector, count, critical, ok: count > 0 });
    }

    const allOk = checks.every(c => c.ok);

    // Log results
    for (const c of checks) {
      if (c.ok) {
        const fbNote = c.fallbackActive ? ` (via fallback: ${c.fallbackActive})` : '';
        log.selectors.debug(`✔ ${c.name}: ${c.count} matches${fbNote}`);
      } else {
        const level = c.critical ? 'warn' : 'debug';
        log.selectors[level](`✗ ${c.name}: 0 matches (${c.selector})`);
      }
    }

    return { ok: allOk, results: checks };
  }

  /**
   * Run health check and show toast if critical selectors are broken.
   * Only warns once per session to avoid spam.
   */

  function healthCheckWithToast() {
    const { ok, results } = runSelectorHealthCheck();
    const criticalFailures = results.filter(c => c.critical && !c.ok);

    if (criticalFailures.length > 0 && !state.healthCheckWarned) {
      // Only warn if the page has loaded enough content to expect matches
      const hasContent = document.querySelectorAll('p, h1, h2, pre').length > 3;
      if (hasContent) {
        state.healthCheckWarned = true;
        const names = criticalFailures.map(c => c.name).join(', ');
        log.selectors.warn(`Critical selector failures: ${names}`);
        showToast(`Persephone: DOM structure may have changed (${names})`, 'error');
      }
    }

    return ok;
  }

  // --- Exports ---
  Object.assign(P, {
    SITE, SELECTOR_DEFS, sel, delay, runSelectorHealthCheck, healthCheckWithToast
  });
})();
