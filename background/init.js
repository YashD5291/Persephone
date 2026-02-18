// ============================================
// EXTENSION LIFECYCLE
// ============================================

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
