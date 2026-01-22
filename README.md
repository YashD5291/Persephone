# Persephone

A Chrome extension that monitors [grok.com](https://grok.com) and automatically sends Grok's responses to Telegram.

## Features

- Detects when Grok finishes streaming a response
- Automatically sends to Telegram with toast confirmation
- Handles long messages (splits at 4096 char limit)
- Deduplication prevents sending the same message twice
- Ignores pre-existing messages on page load
- Enable/disable toggle in the popup
- Message counter tracks how many have been sent

## Installation

1. **Open Chrome Extensions page:**
   - Navigate to `chrome://extensions/`
   - Or go to Menu → More Tools → Extensions

2. **Enable Developer Mode:**
   - Toggle the "Developer mode" switch in the top-right corner

3. **Load the extension:**
   - Click "Load unpacked"
   - Select this `Persephone` folder

4. **Configure Telegram:**
   - Click the Persephone icon in your toolbar
   - Enter your **Bot Token** (from @BotFather)
   - Enter your **Chat ID** (your user ID or group chat ID)
   - Enable "Auto-send to Telegram"
   - Click "Save Settings"
   - Use "Test Connection" to verify it works

## Getting Telegram Credentials

### Bot Token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the token it gives you (looks like `123456789:ABC-DEF...`)

### Chat ID

1. **Important:** Message your bot first (send any message to it)
2. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Look for `"chat":{"id":123456789}` in the response
4. That number is your Chat ID

**For group chats:**
- Add your bot to the group
- The Chat ID will be negative (e.g., `-1001234567890`)

## Project Structure

```
Persephone/
├── manifest.json      # Extension manifest (V3)
├── popup.html         # Settings popup UI
├── popup.css          # Popup styling
├── popup.js           # Popup logic
├── content.js         # DOM monitor for grok.com
├── background.js      # Telegram API handler
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How It Works

1. **Content Script** (`content.js`) runs on grok.com and monitors the DOM for new assistant messages
2. When a message finishes streaming (detected via stability check), it extracts the text
3. The message is sent to the **Background Service Worker** (`background.js`)
4. The service worker calls the Telegram Bot API to send the message
5. A toast notification confirms success/failure on the page

## Configuration Options

| Setting | Description |
|---------|-------------|
| Bot Token | Your Telegram bot's API token from @BotFather |
| Chat ID | Target chat ID (user, group, or channel) |
| Auto-send | Toggle to enable/disable automatic sending |

## Troubleshooting

**"Not configured" status:**
- Make sure both Bot Token and Chat ID are filled in
- Click "Save Settings" after entering credentials

**Test connection fails:**
- Verify your bot token is correct
- Make sure you've messaged the bot at least once
- Check that the Chat ID is correct

**Messages not being sent:**
- Ensure "Auto-send to Telegram" is enabled
- Check the browser console for errors (F12 → Console)
- The extension waits 1.5 seconds after streaming stops to ensure the message is complete

**Duplicate messages:**
- The extension tracks sent messages by hash
- If you reload the page, existing messages won't be re-sent

## Privacy

- Your Bot Token and Chat ID are stored locally in Chrome's sync storage
- Messages are sent directly to Telegram's API (no intermediary servers)
- The extension only runs on grok.com domains

## License

MIT
