// Persephone - Background Service Worker
// Handles Telegram API communication with MarkdownV2 support
// v3.3 - Added settings caching and API preconnect for lower latency

// ============================================
// MESSAGE PROTOCOL CONSTANTS
// ============================================

const MSG = {
  // Telegram operations
  SEND_TO_TELEGRAM:   'SEND_TO_TELEGRAM',
  EDIT_MESSAGE:       'EDIT_MESSAGE',
  STREAM_EDIT:        'STREAM_EDIT',
  DELETE_MESSAGE:     'DELETE_MESSAGE',
  TEST_CONNECTION:    'TEST_CONNECTION',
  PRECONNECT:         'PRECONNECT',
  GET_STATS:          'GET_STATS',

  // Tab management
  GET_TAB_LIST:       'GET_TAB_LIST',
  GET_TAB_AUTO_SEND:  'GET_TAB_AUTO_SEND',
  SET_TAB_AUTO_SEND:  'SET_TAB_AUTO_SEND',
  SAVE_OWN_AUTO_SEND: 'SAVE_OWN_AUTO_SEND',
  GET_AUTO_SEND_STATE:'GET_AUTO_SEND_STATE',
  SET_AUTO_SEND_STATE:'SET_AUTO_SEND_STATE',

  // Broadcasting
  BROADCAST_QUESTION:   'BROADCAST_QUESTION',
  BROADCAST_SCREENSHOT: 'BROADCAST_SCREENSHOT',
  INSERT_AND_SUBMIT:    'INSERT_AND_SUBMIT',
  PASTE_SCREENSHOT:     'PASTE_SCREENSHOT',

  // Settings (popup → content)
  EXTENSION_ENABLED_CHANGED: 'EXTENSION_ENABLED_CHANGED',
  AUTO_SEND_CHANGED:         'AUTO_SEND_CHANGED',
  SKIP_KEYWORDS_CHANGED:     'SKIP_KEYWORDS_CHANGED',
  SPLIT_THRESHOLD_CHANGED:   'SPLIT_THRESHOLD_CHANGED',
  AUTO_SUBMIT_VOICE_CHANGED: 'AUTO_SUBMIT_VOICE_CHANGED',

  // Features
  TOGGLE_WHISPER: 'TOGGLE_WHISPER',
  GET_CLIPBOARD:  'GET_CLIPBOARD',
};

// ============================================
// STRUCTURED LOGGER
// ============================================

const BG_LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const BG_LOG_LEVEL = 'debug';

const bgLogBuffer = [];
const BG_LOG_BUFFER_MAX = 200;

function createBgLogger() {
  const categories = ['settings', 'telegram', 'screenshot', 'broadcast', 'native', 'init'];
  const logger = {};

  function emit(category, level, args) {
    const entry = {
      ts: Date.now(),
      cat: category,
      lvl: level,
      msg: args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ')
    };
    bgLogBuffer.push(entry);
    if (bgLogBuffer.length > BG_LOG_BUFFER_MAX) bgLogBuffer.shift();

    if (BG_LOG_LEVELS[level] <= BG_LOG_LEVELS[BG_LOG_LEVEL]) {
      const prefix = `[Persephone:${category}]`;
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(prefix, ...args);
    }
  }

  categories.forEach(cat => {
    const logFn = (...args) => emit(cat, 'info', args);
    logFn.debug = (...args) => emit(cat, 'debug', args);
    logFn.info = (...args) => emit(cat, 'info', args);
    logFn.warn = (...args) => emit(cat, 'warn', args);
    logFn.error = (...args) => emit(cat, 'error', args);
    logger[cat] = logFn;
  });

  logger.getBuffer = () => [...bgLogBuffer];
  logger.getRecent = (n = 50) => bgLogBuffer.slice(-n);

  return logger;
}

const log = createBgLogger();

const TELEGRAM_MAX_LENGTH = 4096;

// ============================================
// SETTINGS CACHE (Optimization #1)
// ============================================

let settingsCache = {
  botToken: null,
  chatId: null,
  messageCount: 0,
  lastLoaded: 0
};

// Per-tab auto-send overrides (tabId -> boolean)
// Persisted to chrome.storage.local so they survive service worker restarts
let tabAutoSendOverrides = {};

async function loadTabOverrides() {
  try {
    const data = await chrome.storage.local.get('tabAutoSendOverrides');
    tabAutoSendOverrides = data.tabAutoSendOverrides || {};
  } catch (e) {
    tabAutoSendOverrides = {};
  }
}

function saveTabOverrides() {
  chrome.storage.local.set({ tabAutoSendOverrides });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendScreenshotToTabWithRetry(tab, dataUrl, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: MSG.PASTE_SCREENSHOT,
        dataUrl
      });

      if (response?.success) {
        log.screenshot(`Screenshot paste ACK from tab ${tab.id} on attempt ${attempt}`);
        return true;
      }

      log.screenshot.warn(`Screenshot paste NACK/empty from tab ${tab.id} on attempt ${attempt}`);
    } catch (err) {
      log.screenshot.error(`Failed screenshot send to tab ${tab.id} on attempt ${attempt}:`, err?.message || err);
    }

    if (attempt < maxAttempts) {
      await sleep(200 * attempt);
    }
  }

  log.screenshot.error(`Screenshot delivery failed after retries for tab ${tab.id}: ${tab.url}`);
  return false;
}

// Clean up overrides for closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId in tabAutoSendOverrides) {
    delete tabAutoSendOverrides[tabId];
    saveTabOverrides();
  }
});

/**
 * Load settings into memory cache
 */
async function loadSettingsCache() {
  const settings = await chrome.storage.sync.get(['botToken', 'chatId', 'messageCount']);

  settingsCache = {
    botToken: settings.botToken || null,
    chatId: settings.chatId || null,
    messageCount: settings.messageCount || 0,
    lastLoaded: Date.now()
  };

  log.settings('Settings cached in memory');
  return settingsCache;
}

/**
 * Ensure settings are loaded — reloads from storage if botToken or chatId is missing.
 * Returns true if settings are available, false otherwise.
 */
async function ensureSettings() {
  if (!settingsCache.botToken || !settingsCache.chatId) {
    await loadSettingsCache();
  }
  return !!(settingsCache.botToken && settingsCache.chatId);
}

/**
 * Update a specific cached setting and persist to storage
 */
async function updateCachedSetting(key, value) {
  settingsCache[key] = value;
  await chrome.storage.sync.set({ [key]: value });
}

// Listen for storage changes to keep cache in sync
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settingsCache) {
      settingsCache[key] = newValue;
      log.settings(`Cache updated: ${key}`);
    }
  }
});

// ============================================
// API PRECONNECT (Optimization #2)
// ============================================

/**
 * Warm up connection to Telegram API
 * This establishes TCP/TLS connection before it's needed
 */
async function preconnectTelegramAPI() {
  if (!settingsCache.botToken) {
    log.telegram('Skipping preconnect - no bot token configured');
    return;
  }
  
  try {
    // Use getMe as a lightweight ping to establish connection
    const response = await fetch(`https://api.telegram.org/bot${settingsCache.botToken}/getMe`, {
      method: 'GET',
      // Keep connection alive for reuse
      keepalive: true
    });
    
    if (response.ok) {
      log.telegram('API preconnect successful - connection warmed up');
    } else {
      log.telegram.warn('API preconnect returned non-OK status');
    }
  } catch (error) {
    log.telegram.warn('API preconnect failed:', error.message);
  }
}

/**
 * Periodic keep-alive to maintain warm connection
 * Uses chrome.alarms to survive service worker termination
 */
function startConnectionKeepAlive() {
  chrome.alarms.create('keepAlive', { periodInMinutes: 4 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    preconnectTelegramAPI();
  }
});

// ============================================
// NATIVE MESSAGING (MacWhisper)
// ============================================

/**
 * Toggle MacWhisper recording via native messaging host
 */
async function toggleWhisper(refocus = false) {
  try {
    const response = await chrome.runtime.sendNativeMessage('com.persephone.host', { action: 'toggle', refocus });
    return { success: response?.success ?? false };
  } catch (error) {
    log.native.error('Native messaging error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Read clipboard contents via native messaging host
 */
async function getClipboard() {
  try {
    const response = await chrome.runtime.sendNativeMessage('com.persephone.host', { action: 'get_clipboard' });
    return { success: response?.success ?? false, text: response?.text ?? '' };
  } catch (error) {
    log.native.error('Clipboard read error:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// MESSAGE HANDLERS
// ============================================

const KNOWN_MSG_TYPES = new Set(Object.values(MSG));

function validateMessage(request) {
  if (!request || typeof request.type !== 'string') return 'missing or invalid type';
  if (!KNOWN_MSG_TYPES.has(request.type)) return `unknown type: ${request.type}`;
  // Type-specific required fields
  if (request.type === MSG.SEND_TO_TELEGRAM && typeof request.text !== 'string') return 'SEND_TO_TELEGRAM requires text';
  if (request.type === MSG.EDIT_MESSAGE && (!request.messageId || typeof request.text !== 'string')) return 'EDIT_MESSAGE requires messageId and text';
  if (request.type === MSG.STREAM_EDIT && (!request.messageId || typeof request.text !== 'string')) return 'STREAM_EDIT requires messageId and text';
  if (request.type === MSG.DELETE_MESSAGE && !request.messageId) return 'DELETE_MESSAGE requires messageId';
  if (request.type === MSG.TEST_CONNECTION && (!request.botToken || !request.chatId)) return 'TEST_CONNECTION requires botToken and chatId';
  if (request.type === MSG.SET_TAB_AUTO_SEND && (request.tabId == null || request.autoSend == null)) return 'SET_TAB_AUTO_SEND requires tabId and autoSend';
  if (request.type === MSG.BROADCAST_SCREENSHOT && !request.dataUrl) return 'BROADCAST_SCREENSHOT requires dataUrl';
  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const validationError = validateMessage(request);
  if (validationError) {
    log.settings.warn('Invalid message:', validationError, request);
    sendResponse({ success: false, error: validationError });
    return false;
  }

  if (request.type === MSG.TEST_CONNECTION) {
    sendTestMessage(request.botToken, request.chatId)
      .then(result => {
        // Update cache with new credentials after successful test
        if (result.success) {
          settingsCache.botToken = request.botToken;
          settingsCache.chatId = request.chatId;
          // Preconnect with new credentials
          preconnectTelegramAPI();
        }
        sendResponse(result);
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === MSG.SEND_TO_TELEGRAM) {
    handleSendToTelegram(request.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === MSG.EDIT_MESSAGE) {
    handleEditMessage(request.messageId, request.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === MSG.STREAM_EDIT) {
    handleStreamEdit(request.messageId, request.text)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (request.type === MSG.DELETE_MESSAGE) {
    handleDeleteMessage(request.messageId)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === MSG.TOGGLE_WHISPER) {
    toggleWhisper(request.refocus || false)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === MSG.GET_CLIPBOARD) {
    getClipboard()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === MSG.BROADCAST_QUESTION) {
    const TAB_URLS = ['https://grok.com/*', 'https://x.com/i/grok*', 'https://claude.ai/*'];
    const senderTabId = sender.tab?.id;
    log.broadcast('Broadcasting question to other tabs, sender:', senderTabId);
    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      log.broadcast('Found tabs:', tabs.map(t => `${t.id}:${t.url}`));
      tabs.forEach(tab => {
        if (tab.id !== senderTabId) {
          log.broadcast('Sending INSERT_AND_SUBMIT to tab:', tab.id, tab.url);
          chrome.tabs.sendMessage(tab.id, {
            type: MSG.INSERT_AND_SUBMIT,
            text: request.text
          }).catch(err => log.broadcast.error('Failed to send to tab:', tab.id, err));
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === MSG.GET_TAB_LIST) {
    const TAB_URLS = ['https://grok.com/*', 'https://x.com/i/grok*', 'https://claude.ai/*'];
    const senderTabId = sender.tab?.id;
    chrome.tabs.query({ url: TAB_URLS }, async (tabs) => {
      const tabList = [];
      for (const tab of tabs) {
        // Use persisted override if available, otherwise query the tab
        const override = tabAutoSendOverrides[tab.id];
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_AUTO_SEND_STATE });
          tabList.push({
            id: tab.id,
            title: tab.title || '',
            url: tab.url,
            autoSend: override !== undefined ? override : (response?.autoSend ?? true),
            site: response?.site || (tab.url.includes('claude') ? 'claude' : 'grok')
          });
        } catch (e) {
          tabList.push({
            id: tab.id,
            title: tab.title || '',
            url: tab.url,
            autoSend: override !== undefined ? override : true,
            site: tab.url.includes('claude') ? 'claude' : 'grok'
          });
        }
      }
      sendResponse({ tabs: tabList, currentTabId: senderTabId });
    });
    return true;
  }

  if (request.type === MSG.SET_TAB_AUTO_SEND) {
    // Persist the override so it survives tab refresh
    tabAutoSendOverrides[request.tabId] = request.autoSend;
    saveTabOverrides();
    chrome.tabs.sendMessage(request.tabId, {
      type: MSG.SET_AUTO_SEND_STATE,
      autoSend: request.autoSend
    }).then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === MSG.GET_TAB_AUTO_SEND) {
    const tabId = sender.tab?.id;
    const override = tabId != null ? tabAutoSendOverrides[tabId] : undefined;
    sendResponse({ hasOverride: override !== undefined, autoSend: override });
    return false;
  }

  if (request.type === MSG.SAVE_OWN_AUTO_SEND) {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      tabAutoSendOverrides[tabId] = request.autoSend;
      saveTabOverrides();
    }
    sendResponse({ success: true });
    return false;
  }

  if (request.type === MSG.BROADCAST_SCREENSHOT) {
    const TAB_URLS = ['https://grok.com/*', 'https://x.com/i/grok*', 'https://claude.ai/*'];
    const senderTabId = sender.tab?.id;
    log.screenshot('Broadcasting screenshot to other tabs, sender:', senderTabId);
    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      const targetTabs = tabs.filter(tab => tab.id !== senderTabId);
      Promise.all(targetTabs.map((tab) => {
        log.screenshot('Sending PASTE_SCREENSHOT to tab:', tab.id, tab.url);
        return sendScreenshotToTabWithRetry(tab, request.dataUrl);
      }))
        .then((results) => {
          const delivered = results.filter(Boolean).length;
          sendResponse({ success: true, delivered, total: results.length });
        })
        .catch((err) => {
          log.screenshot.error('Screenshot broadcast failure:', err?.message || err);
          sendResponse({ success: false, error: err?.message || String(err) });
        });
    });
    return true;
  }

  if (request.type === MSG.GET_STATS) {
    // Return from cache immediately
    sendResponse({ messageCount: settingsCache.messageCount });
    return false; // Synchronous response
  }
  
  if (request.type === MSG.PRECONNECT) {
    preconnectTelegramAPI();
    sendResponse({ success: true });
    return false;
  }

  // Catch-all: message type passed validation but has no handler
  log.settings.warn('Unhandled message type:', request.type);
  sendResponse({ success: false, error: `No handler for ${request.type}` });
  return false;
});

async function sendTestMessage(botToken, chatId) {
  const testMessage = `✅ *Persephone connected\\!*

🕐 ${escapeMarkdownV2(new Date().toLocaleString())}

_Ready to receive messages\\._`;
  
  return sendTelegramMessage(botToken, chatId, testMessage);
}

async function handleSendToTelegram(text) {
  if (!await ensureSettings()) {
    return { success: false, error: 'Bot token or chat ID not configured. Please set up in extension popup.' };
  }

  const result = await sendTelegramMessage(settingsCache.botToken, settingsCache.chatId, text);

  if (result.success) {
    // Update count in cache and storage
    settingsCache.messageCount++;
    chrome.storage.sync.set({ messageCount: settingsCache.messageCount }); // Fire and forget
    log.telegram(`Message sent successfully. Total: ${settingsCache.messageCount}`);
  }

  return result;
}

/**
 * Handle editing a message in Telegram
 */
async function handleEditMessage(messageId, newText) {
  if (!await ensureSettings()) {
    return { success: false, error: 'Bot token or chat ID not configured.' };
  }

  return editTelegramMessage(settingsCache.botToken, settingsCache.chatId, messageId, newText);
}

/**
 * Handle lightweight stream edit - no markdown, ignores "not modified"
 */
async function handleStreamEdit(messageId, text) {
  if (!await ensureSettings()) {
    return { success: false };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${settingsCache.botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        chat_id: settingsCache.chatId,
        message_id: messageId,
        text: text,
        disable_web_page_preview: true
      }),
    });
    const data = await response.json();

    if (!data.ok && data.description?.includes('not modified')) {
      return { success: true };
    }

    return { success: data.ok };
  } catch (error) {
    return { success: false };
  }
}

/**
 * Handle deleting a message from Telegram
 */
async function handleDeleteMessage(messageId) {
  if (!await ensureSettings()) {
    return { success: false, error: 'Bot token or chat ID not configured.' };
  }

  return deleteTelegramMessage(settingsCache.botToken, settingsCache.chatId, messageId);
}

/**
 * Escape special characters for Telegram MarkdownV2
 * Characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Check if text contains Markdown formatting
 */
function hasMarkdownFormatting(text) {
  // Check for common Markdown patterns
  return /[*_`~]/.test(text) || /\[.*\]\(.*\)/.test(text) || /^>/.test(text);
}

async function sendTelegramMessage(botToken, chatId, text) {
  const messages = splitMessage(text, TELEGRAM_MAX_LENGTH);
  const messageIds = [];

  for (let i = 0; i < messages.length; i++) {
    const chunk = messages[i];
    const prefix = messages.length > 1 ? `[${i + 1}/${messages.length}] ` : '';
    const fullText = prefix + chunk;

    try {
      const useMarkdown = hasMarkdownFormatting(chunk);

      let response;
      let data;

      if (useMarkdown) {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true, // Reuse connection
          body: JSON.stringify({
            chat_id: chatId,
            text: fullText,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          }),
        });
        data = await response.json();

        if (!data.ok && data.description?.includes('parse')) {
          log.telegram.warn('Markdown failed, retrying without formatting:', data.description);
          
          response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
              chat_id: chatId,
              text: fullText.replace(/[*_`~\[\]]/g, ''),
              disable_web_page_preview: true
            }),
          });
          data = await response.json();
        }
      } else {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            chat_id: chatId,
            text: fullText,
            disable_web_page_preview: true
          }),
        });
        data = await response.json();
      }

      if (!data.ok) {
        log.telegram.error('Telegram API error:', data);
        return { success: false, error: data.description || 'Unknown error' };
      }

      if (data.result?.message_id) {
        messageIds.push(data.result.message_id);
      }

      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } catch (error) {
      log.telegram.error('Network error:', error);
      return { success: false, error: error.message };
    }
  }

  return { 
    success: true, 
    messageId: messageIds.length === 1 ? messageIds[0] : messageIds,
    isMultiPart: messageIds.length > 1
  };
}

/**
 * Edit a message in Telegram
 */
async function editTelegramMessage(botToken, chatId, messageId, newText) {
  try {
    const useMarkdown = hasMarkdownFormatting(newText);
    
    let response;
    let data;

    if (useMarkdown) {
      response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }),
      });
      data = await response.json();

      if (!data.ok && data.description?.includes('parse')) {
        log.telegram.warn('Markdown failed on edit, retrying without formatting');
        
        response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: newText.replace(/[*_`~\[\]]/g, ''),
            disable_web_page_preview: true
          }),
        });
        data = await response.json();
      }
    } else {
      response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          disable_web_page_preview: true
        }),
      });
      data = await response.json();
    }

    if (!data.ok) {
      log.telegram.error('Edit error:', data);
      return { success: false, error: data.description || 'Failed to edit message' };
    }

    log.telegram('Message edited successfully');
    return { success: true };

  } catch (error) {
    log.telegram.error('Edit network error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a message from Telegram
 */
async function deleteTelegramMessage(botToken, chatId, messageId) {
  try {
    const messageIds = Array.isArray(messageId) ? messageId : [messageId];
    
    for (const id of messageIds) {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          chat_id: chatId,
          message_id: id
        }),
      });
      
      const data = await response.json();

      if (!data.ok) {
        log.telegram.error('Delete error:', data);
        return { success: false, error: data.description || 'Failed to delete message' };
      }

      if (messageIds.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    log.telegram('Message(s) deleted successfully');
    return { success: true };

  } catch (error) {
    log.telegram.error('Delete network error:', error);
    return { success: false, error: error.message };
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;

    const breakPoints = [
      { pattern: '\n```', offset: 4 },
      { pattern: '```\n', offset: 0 },
      { pattern: '\n\n', offset: 2 },
      { pattern: '\n', offset: 1 },
      { pattern: '. ', offset: 2 },
      { pattern: ', ', offset: 2 },
      { pattern: ' ', offset: 1 },
    ];

    for (const bp of breakPoints) {
      const idx = remaining.lastIndexOf(bp.pattern, maxLength);
      if (idx > maxLength * 0.4) {
        splitIndex = idx + bp.offset;
        break;
      }
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

// ============================================
// EXTENSION LIFECYCLE
// ============================================

let initialized = false;

async function initialize() {
  if (initialized) return;
  initialized = true;

  log.init('Initializing...');
  await loadSettingsCache();
  await loadTabOverrides();
  preconnectTelegramAPI();
  startConnectionKeepAlive();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  log.init('Extension installed/updated:', details.reason);

  // Set default settings
  const result = await chrome.storage.sync.get(['messageCount', 'botToken', 'chatId']);
  const defaults = {};
  if (result.messageCount === undefined) defaults.messageCount = 0;

  if (Object.keys(defaults).length > 0) {
    await chrome.storage.sync.set(defaults);
    log.init('Default settings applied:', defaults);
  }

  await initialize();
});

// Service worker startup (when woken up)
chrome.runtime.onStartup.addListener(async () => {
  log.init('Service worker started');
  await initialize();
});

// Initialize on script load (for when service worker is first loaded)
initialize();

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.runtime.openOptionsPage();
});
