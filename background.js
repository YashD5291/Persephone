// Persephone - Background Service Worker
// Handles Telegram API communication with MarkdownV2 support

const TELEGRAM_MAX_LENGTH = 4096;

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TEST_CONNECTION') {
    sendTestMessage(request.botToken, request.chatId)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'SEND_TO_TELEGRAM') {
    handleSendToTelegram(request.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'GET_STATS') {
    chrome.storage.sync.get(['messageCount'], (result) => {
      sendResponse({ messageCount: result.messageCount || 0 });
    });
    return true;
  }
});

async function sendTestMessage(botToken, chatId) {
  const testMessage = `✅ *Persephone connected\\!*

🕐 ${escapeMarkdownV2(new Date().toLocaleString())}

_Ready to receive messages\\._`;
  
  return sendTelegramMessage(botToken, chatId, testMessage);
}

async function handleSendToTelegram(text) {
  const settings = await chrome.storage.sync.get(['botToken', 'chatId', 'enabled', 'messageCount']);

  if (!settings.botToken || !settings.chatId) {
    return { success: false, error: 'Bot token or chat ID not configured. Please set up in extension popup.' };
  }

  // Default enabled to true if not set
  if (settings.enabled === false) {
    return { success: false, error: 'Sending is disabled in settings' };
  }

  const result = await sendTelegramMessage(settings.botToken, settings.chatId, text);

  if (result.success) {
    const newCount = (settings.messageCount || 0) + 1;
    await chrome.storage.sync.set({ messageCount: newCount });
    console.log(`[Persephone] Message sent successfully. Total: ${newCount}`);
  }

  return result;
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

  for (let i = 0; i < messages.length; i++) {
    const chunk = messages[i];
    const prefix = messages.length > 1 ? `[${i + 1}/${messages.length}] ` : '';
    const fullText = prefix + chunk;

    try {
      // Determine if we should use Markdown
      const useMarkdown = hasMarkdownFormatting(chunk);

      // Try sending with appropriate parse mode
      let response;
      let data;

      if (useMarkdown) {
        // Try Markdown first (legacy, more forgiving)
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: fullText,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          }),
        });
        data = await response.json();

        // If Markdown fails, try without formatting
        if (!data.ok && data.description?.includes('parse')) {
          console.warn('[Persephone] Markdown failed, retrying without formatting:', data.description);
          
          response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: fullText.replace(/[*_`~\[\]]/g, ''), // Strip markdown chars
              disable_web_page_preview: true
            }),
          });
          data = await response.json();
        }
      } else {
        // No markdown, send as plain text
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

      // Rate limiting: small delay between chunks
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } catch (error) {
      console.error('[Persephone] Network error:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: true };
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

    // Try to split at natural break points (in order of preference)
    const breakPoints = [
      { pattern: '\n```', offset: 4 },      // End of code block
      { pattern: '```\n', offset: 0 },      // Start of code block
      { pattern: '\n\n', offset: 2 },       // Paragraph break
      { pattern: '\n', offset: 1 },         // Line break
      { pattern: '. ', offset: 2 },         // Sentence end
      { pattern: ', ', offset: 2 },         // Clause break
      { pattern: ' ', offset: 1 },          // Word boundary
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

// Extension lifecycle
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Persephone] Extension installed/updated:', details.reason);
  
  // Set default settings
  chrome.storage.sync.get(['enabled', 'messageCount', 'botToken', 'chatId'], (result) => {
    const defaults = {};
    if (result.enabled === undefined) defaults.enabled = true;
    if (result.messageCount === undefined) defaults.messageCount = 0;
    
    if (Object.keys(defaults).length > 0) {
      chrome.storage.sync.set(defaults);
      console.log('[Persephone] Default settings applied:', defaults);
    }
  });
});

// Handle extension icon click (open popup or options)
chrome.action.onClicked.addListener((tab) => {
  chrome.runtime.openOptionsPage();
});