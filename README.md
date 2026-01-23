# Persephone

A Chrome extension that monitors [grok.com](https://grok.com) and lets you send Grok's responses to Telegram with inline controls.

## Features

### Inline Send Buttons
- **Send button** appears next to each paragraph, list, code block, and heading as Grok responds
- Click to send individual chunks to Telegram instantly
- Buttons appear in real-time as content streams

### Edit & Delete
- After sending, the send button transforms into **edit** and **delete** buttons
- **Edit**: Opens a modal to modify the message in Telegram
- **Delete**: Removes the message from Telegram (with confirmation)
- Green checkmark indicates sent status

### Smart Content Detection
- Automatically detects paragraphs (`<p>`), headings (`<h1>`-`<h6>`), lists (`<ul>`, `<ol>`), code blocks (`<pre>`), blockquotes, and tables
- Preserves Markdown formatting: `*bold*`, `_italic_`, `` `code` ``
- Handles code blocks with language detection
- Splits long messages automatically (4096 char Telegram limit)

### Performance Optimizations
- **API Preconnect**: Establishes connection to Telegram API proactively
- **Settings Caching**: Credentials cached in memory for instant access
- **Connection Keep-Alive**: Maintains warm connection to reduce latency
- **Streaming Detection**: Waits for content to finish before adding buttons (detects `animate-gaussian` class)

## Installation

1. **Open Chrome Extensions page:**
   - Navigate to `chrome://extensions/`
   - Or go to Menu → More Tools → Extensions

2. **Enable Developer Mode:**
   - Toggle the "Developer mode" switch in the top-right corner

3. **Load the extension:**
   - Click "Load unpacked"
   - Select the `Persephone` folder

4. **Configure Telegram:**
   - Click the Persephone icon in your toolbar
   - Enter your **Bot Token** (from @BotFather)
   - Enter your **Chat ID** (your user ID or group chat ID)
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

## How It Works

### Detection Strategy

Grok uses a unique streaming approach:
1. While typing, words are wrapped in `<span class="animate-gaussian">` elements
2. When a block (paragraph, list, etc.) is complete, these spans are removed
3. Persephone detects this transition to know when content is ready to capture

```
STREAMING:   <p>Hello <span class="animate-gaussian">world</span></p>
COMPLETE:    <p>Hello world</p>  ← Ready to capture!
```

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: POLLING (every 1000ms)                                │
│  - Checks for new response containers                           │
│  - Scans all responses and adds buttons to complete elements    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ New streaming response detected
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: MUTATION OBSERVER (reactive)                          │
│  - Watches only the streaming response container                │
│  - Processes elements as they complete (no animate-gaussian)    │
│  - Adds inline send buttons immediately                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ Streaming complete
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 3: COMPLETION                                            │
│  - Final processing pass                                        │
│  - Disconnect observer                                          │
│  - Return to polling mode                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
Persephone/
├── manifest.json      # Extension manifest (V3)
├── popup.html         # Settings popup UI
├── popup.css          # Popup styling
├── popup.js           # Popup logic
├── content.js         # DOM monitor & inline buttons
├── background.js      # Telegram API handler
├── .gitignore         # Git ignore file
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Button States

| State | Appearance | Actions |
|-------|------------|---------|
| Ready | Purple send icon | Click to send |
| Sent | Green checkmark + blue edit + red delete | Edit or delete message |
| Streaming | No button (waiting) | Content still loading |

## Telegram Formatting

Content is converted to Telegram Markdown:

| HTML | Telegram |
|------|----------|
| `<strong>`, `<b>` | `*bold*` |
| `<em>`, `<i>` | `_italic_` |
| `<code>` | `` `code` `` |
| `<pre>` | ` ```code block``` ` |
| `<h1>`-`<h6>` | `*Header*` |
| `<ul>` | `• item` |
| `<ol>` | `1. item` |
| `<blockquote>` | `> quote` |

## Keyboard Shortcuts (Edit Modal)

- `Ctrl/Cmd + Enter` - Save changes
- `Escape` - Cancel and close

## Troubleshooting

**"Extension disconnected" error:**
- The page was open too long. Refresh the page.

**Buttons not appearing:**
- Wait for Grok to finish streaming (buttons appear after content stabilizes)
- Make sure you're on grok.com
- Check the browser console for errors (F12 → Console)

**Edit not working:**
- Multi-part messages (split due to length) cannot be edited
- Telegram only allows editing messages for 48 hours

**Delete not working:**
- Telegram only allows deleting messages for 48 hours
- Bot must have delete permissions in group chats

**Test connection fails:**
- Verify your bot token is correct
- Make sure you've messaged the bot at least once
- Check that the Chat ID is correct

## Privacy

- Your Bot Token and Chat ID are stored locally in Chrome's sync storage
- Messages are sent directly to Telegram's API (no intermediary servers)
- The extension only runs on grok.com domains
- No data is collected or transmitted elsewhere

## Version History

- **v3.3** - Inline send/edit/delete buttons, streaming detection, latency optimizations
- **v3.0** - Floating panel with manual chunk selection
- **v2.0** - Real-time streaming detection with `animate-gaussian`
- **v1.0** - Initial release with polling-based detection

## License

MIT
