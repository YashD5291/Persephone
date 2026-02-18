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

const SETTINGS_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Ensure settings are loaded — reloads from storage if botToken/chatId is missing
 * or if cache is older than 10 minutes (guards against chrome.alarms failing to fire).
 * Returns true if settings are available, false otherwise.
 */
async function ensureSettings() {
  const stale = settingsCache.lastLoaded && (Date.now() - settingsCache.lastLoaded > SETTINGS_STALE_MS);
  if (!settingsCache.botToken || !settingsCache.chatId || stale) {
    if (stale) log.settings('Settings stale (>10min), reloading');
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
