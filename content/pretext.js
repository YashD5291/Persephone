(function() {
  'use strict';
  const P = window.Persephone;

  const { state, log } = P;

  // Stored in chrome.storage.local (not sync): one entry per chat URL adds up,
  // and sync's per-item quota is too small to hold them.
  const STORAGE_KEY = 'preTexts';

  /**
   * Key identifying the current chat. The hash is dropped; the query string is
   * kept because x.com/i/grok holds the conversation id there.
   */
  function getChatUrlKey() {
    return location.origin + location.pathname + location.search;
  }

  /**
   * True when the URL is a blank chat with no conversation id yet
   * (claude.ai/new, grok.com/, x.com/i/grok). Used to carry a pre-text over
   * when the SPA swaps that URL for a real conversation URL.
   */
  function isNewChatUrl() {
    const path = location.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/new' || path === '/chat') return true;
    if (path === '/i/grok') return !new URLSearchParams(location.search).get('conversation');
    return false;
  }

  /** Read the whole {urlKey: preText} map. */
  async function readAllPreTexts() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY]);
      return data[STORAGE_KEY] || {};
    } catch (e) {
      log.state.error('📝 Failed to read pre-texts:', e.message);
      return {};
    }
  }

  // Tracks the chat the loaded pre-text belongs to, so SPA navigation is noticed.
  let lastKey = null;
  let lastWasNewChat = false;

  /** Load this chat's pre-text into state. */
  async function loadPreText() {
    const all = await readAllPreTexts();
    lastKey = getChatUrlKey();
    lastWasNewChat = isNewChatUrl();
    state.preText = all[lastKey] || '';
    if (state.preText) log.state(`📝 Pre-text loaded (${state.preText.length} chars)`);
    return state.preText;
  }

  /**
   * Persist a pre-text for `key`. An empty value removes the entry so the map
   * doesn't grow with blanks.
   */
  async function savePreText(text, key = getChatUrlKey()) {
    const value = (text || '').trim();
    try {
      const all = await readAllPreTexts();
      if (value) {
        all[key] = value;
      } else {
        delete all[key];
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: all });
      if (key === getChatUrlKey()) state.preText = value;
      log.state(`📝 Pre-text ${value ? 'saved' : 'cleared'} for this chat`);
    } catch (e) {
      log.state.error('📝 Failed to save pre-text:', e.message);
    }
  }

  /** Prepend this chat's pre-text to `text`. */
  function applyPreText(text) {
    const pre = (state.preText || '').trim();
    if (!pre) return text;
    return `${pre} ${text}`;
  }

  /**
   * Point state at whatever chat the URL now names. Returns true if the URL
   * changed. A pre-text typed on a blank chat is carried over when that chat
   * turns into a real conversation, so it isn't lost on the first message.
   */
  async function syncPreTextForUrl() {
    const key = getChatUrlKey();
    if (key === lastKey) return false;

    const previousKey = lastKey;
    const carried = lastWasNewChat ? (state.preText || '').trim() : '';
    lastKey = key;
    lastWasNewChat = isNewChatUrl();

    const all = await readAllPreTexts();
    const stored = all[key];

    if (stored) {
      state.preText = stored;
    } else if (carried && previousKey) {
      state.preText = carried;
      await savePreText(carried, key);
      await savePreText('', previousKey);
      log.state('📝 Pre-text carried over to the new chat URL');
    } else {
      state.preText = '';
    }

    if (P.updateWidgetStates) P.updateWidgetStates();
    return true;
  }

  /**
   * These are single-page apps: sending the first message rewrites the URL
   * without a reload, so poll for it.
   */
  function startPreTextUrlWatcher() {
    setInterval(syncPreTextForUrl, 1000);
  }

  // --- Exports ---
  Object.assign(P, {
    getChatUrlKey, isNewChatUrl, loadPreText, savePreText, applyPreText,
    syncPreTextForUrl, startPreTextUrlWatcher
  });
})();
