let initialized = false;

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

let initPromise = null;
const pendingMessages = [];

function handleMessage(request, sender, sendResponse) {
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
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (initialized) {
    return handleMessage(request, sender, sendResponse);
  }

  // Queue message until initialization completes
  pendingMessages.push({ request, sender, sendResponse });
  if (!initPromise) initPromise = initialize();
  initPromise.then(() => {
    const queued = pendingMessages.splice(0);
    queued.forEach(m => handleMessage(m.request, m.sender, m.sendResponse));
  });
  return true; // Will respond async
});
