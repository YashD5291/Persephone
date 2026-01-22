// Persephone - Background Service Worker
// Handles Telegram API communication

const TELEGRAM_MAX_LENGTH = 4096;

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TEST_CONNECTION') {
    sendTestMessage(request.botToken, request.chatId)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  if (request.type === 'SEND_TO_TELEGRAM') {
    handleSendToTelegram(request.text)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

async function sendTestMessage(botToken, chatId) {
  const testMessage = `Persephone connected successfully!\n\nTimestamp: ${new Date().toISOString()}`;
  return sendTelegramMessage(botToken, chatId, testMessage);
}

async function handleSendToTelegram(text) {
  const settings = await chrome.storage.sync.get(['botToken', 'chatId', 'enabled', 'messageCount']);

  if (!settings.enabled) {
    return { success: false, error: 'Auto-send is disabled' };
  }

  if (!settings.botToken || !settings.chatId) {
    return { success: false, error: 'Bot token or chat ID not configured' };
  }

  const result = await sendTelegramMessage(settings.botToken, settings.chatId, text);

  if (result.success) {
    // Increment message count
    const newCount = (settings.messageCount || 0) + 1;
    await chrome.storage.sync.set({ messageCount: newCount });
  }

  return result;
}

async function sendTelegramMessage(botToken, chatId, text) {
  // Split message if too long
  const messages = splitMessage(text, TELEGRAM_MAX_LENGTH);

  for (let i = 0; i < messages.length; i++) {
    const chunk = messages[i];
    const prefix = messages.length > 1 ? `[${i + 1}/${messages.length}] ` : '';

    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: prefix + chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }),
      });

      const data = await response.json();

      if (!data.ok) {
        // Retry without Markdown if parsing fails
        if (data.description && data.description.includes('parse')) {
          const retryResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: prefix + chunk,
              disable_web_page_preview: true
            }),
          });

          const retryData = await retryResponse.json();
          if (!retryData.ok) {
            return { success: false, error: retryData.description };
          }
        } else {
          return { success: false, error: data.description };
        }
      }

      // Small delay between chunks to avoid rate limiting
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
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

    // Try to split at a natural break point
    let splitIndex = maxLength;

    // Look for paragraph break
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      splitIndex = paragraphBreak + 2;
    } else {
      // Look for line break
      const lineBreak = remaining.lastIndexOf('\n', maxLength);
      if (lineBreak > maxLength * 0.5) {
        splitIndex = lineBreak + 1;
      } else {
        // Look for sentence end
        const sentenceEnd = remaining.lastIndexOf('. ', maxLength);
        if (sentenceEnd > maxLength * 0.5) {
          splitIndex = sentenceEnd + 2;
        } else {
          // Look for word boundary
          const wordBoundary = remaining.lastIndexOf(' ', maxLength);
          if (wordBoundary > maxLength * 0.5) {
            splitIndex = wordBoundary + 1;
          }
        }
      }
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

// Install handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('Persephone extension installed');
});
