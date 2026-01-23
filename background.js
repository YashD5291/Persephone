// Persephone - Background Service Worker
// Handles Telegram API communication with MarkdownV2 support
// v3.3 - Added settings caching and API preconnect for lower latency

const TELEGRAM_MAX_LENGTH = 4096;

// ============================================
// SETTINGS CACHE (Optimization #1)
// ============================================

let settingsCache = {
  botToken: null,
  chatId: null,
  enabled: true,
  messageCount: 0,
  lastLoaded: 0
};

/**
 * Load settings into memory cache
 */
async function loadSettingsCache() {
  const settings = await chrome.storage.sync.get(['botToken', 'chatId', 'enabled', 'messageCount']);
  
  settingsCache = {
    botToken: settings.botToken || null,
    chatId: settings.chatId || null,
    enabled: settings.enabled !== false, // Default true
    messageCount: settings.messageCount || 0,
    lastLoaded: Date.now()
  };
  
  console.log('[Persephone] Settings cached in memory');
  return settingsCache;
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
      console.log(`[Persephone] Cache updated: ${key}`);
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
    console.log('[Persephone] Skipping preconnect - no bot token configured');
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
      console.log('[Persephone] API preconnect successful - connection warmed up');
    } else {
      console.warn('[Persephone] API preconnect returned non-OK status');
    }
  } catch (error) {
    console.warn('[Persephone] API preconnect failed:', error.message);
  }
}

/**
 * Periodic keep-alive to maintain warm connection
 * Runs every 4 minutes (Telegram timeout is ~5 min)
 */
function startConnectionKeepAlive() {
  setInterval(() => {
    if (settingsCache.botToken) {
      preconnectTelegramAPI();
    }
  }, 4 * 60 * 1000); // 4 minutes
}

// ============================================
// MESSAGE HANDLERS
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TEST_CONNECTION') {
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

  if (request.type === 'SEND_TO_TELEGRAM') {
    handleSendToTelegram(request.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'EDIT_MESSAGE') {
    handleEditMessage(request.messageId, request.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'DELETE_MESSAGE') {
    handleDeleteMessage(request.messageId)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'GET_STATS') {
    // Return from cache immediately
    sendResponse({ messageCount: settingsCache.messageCount });
    return false; // Synchronous response
  }
  
  if (request.type === 'PRECONNECT') {
    preconnectTelegramAPI();
    sendResponse({ success: true });
    return false;
  }
});

async function sendTestMessage(botToken, chatId) {
  const testMessage = `✅ *Persephone connected\\!*

🕐 ${escapeMarkdownV2(new Date().toLocaleString())}

_Ready to receive messages\\._`;
  
  return sendTelegramMessage(botToken, chatId, testMessage);
}

async function handleSendToTelegram(text) {
  // Use cached settings (fast!)
  if (!settingsCache.botToken || !settingsCache.chatId) {
    // Fallback: try loading from storage
    await loadSettingsCache();
    
    if (!settingsCache.botToken || !settingsCache.chatId) {
      return { success: false, error: 'Bot token or chat ID not configured. Please set up in extension popup.' };
    }
  }

  if (settingsCache.enabled === false) {
    return { success: false, error: 'Sending is disabled in settings' };
  }

  const result = await sendTelegramMessage(settingsCache.botToken, settingsCache.chatId, text);

  if (result.success) {
    // Update count in cache and storage
    settingsCache.messageCount++;
    chrome.storage.sync.set({ messageCount: settingsCache.messageCount }); // Fire and forget
    console.log(`[Persephone] Message sent successfully. Total: ${settingsCache.messageCount}`);
  }

  return result;
}

/**
 * Handle editing a message in Telegram
 */
async function handleEditMessage(messageId, newText) {
  if (!settingsCache.botToken || !settingsCache.chatId) {
    return { success: false, error: 'Bot token or chat ID not configured.' };
  }

  return editTelegramMessage(settingsCache.botToken, settingsCache.chatId, messageId, newText);
}

/**
 * Handle deleting a message from Telegram
 */
async function handleDeleteMessage(messageId) {
  if (!settingsCache.botToken || !settingsCache.chatId) {
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
          console.warn('[Persephone] Markdown failed, retrying without formatting:', data.description);
          
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
        console.error('[Persephone] Telegram API error:', data);
        return { success: false, error: data.description || 'Unknown error' };
      }

      if (data.result?.message_id) {
        messageIds.push(data.result.message_id);
      }

      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } catch (error) {
      console.error('[Persephone] Network error:', error);
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
        console.warn('[Persephone] Markdown failed on edit, retrying without formatting');
        
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
      console.error('[Persephone] Edit error:', data);
      return { success: false, error: data.description || 'Failed to edit message' };
    }

    console.log('[Persephone] Message edited successfully');
    return { success: true };

  } catch (error) {
    console.error('[Persephone] Edit network error:', error);
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
        console.error('[Persephone] Delete error:', data);
        return { success: false, error: data.description || 'Failed to delete message' };
      }

      if (messageIds.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    console.log('[Persephone] Message(s) deleted successfully');
    return { success: true };

  } catch (error) {
    console.error('[Persephone] Delete network error:', error);
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

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Persephone] Extension installed/updated:', details.reason);
  
  // Set default settings
  const result = await chrome.storage.sync.get(['enabled', 'messageCount', 'botToken', 'chatId']);
  const defaults = {};
  if (result.enabled === undefined) defaults.enabled = true;
  if (result.messageCount === undefined) defaults.messageCount = 0;
  
  if (Object.keys(defaults).length > 0) {
    await chrome.storage.sync.set(defaults);
    console.log('[Persephone] Default settings applied:', defaults);
  }
  
  // Load settings into cache
  await loadSettingsCache();
  
  // Preconnect to API
  preconnectTelegramAPI();
  
  // Start keep-alive interval
  startConnectionKeepAlive();
});

// Service worker startup (when woken up)
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Persephone] Service worker started');
  
  // Load settings into cache
  await loadSettingsCache();
  
  // Preconnect to API
  preconnectTelegramAPI();
  
  // Start keep-alive interval
  startConnectionKeepAlive();
});

// Initialize on script load (for when service worker is first loaded)
(async () => {
  console.log('[Persephone] Initializing...');
  await loadSettingsCache();
  preconnectTelegramAPI();
  startConnectionKeepAlive();
})();

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.runtime.openOptionsPage();
});