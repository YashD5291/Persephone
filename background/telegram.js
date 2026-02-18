// ============================================
// API PRECONNECT (Optimization #2)
// ============================================

/**
 * Warm up connection to Telegram API
 * This establishes TCP/TLS connection before it's needed
 */
async function preconnectTelegramAPI() {
  await ensureSettings();
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
