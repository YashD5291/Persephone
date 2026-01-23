# 🌸 Persephone - Grok to Telegram Bridge

A Chrome extension that captures Grok AI responses in real-time and sends them to Telegram.

## Features

- **Real-time streaming detection** using Grok's `animate-gaussian` class
- **Hybrid approach**: Polling for new responses + MutationObserver for chunks
- **Telegram Markdown support**: Bold, italic, code blocks, lists, tables
- **Floating panel UI**: Select and send individual chunks or all at once
- **Inline send buttons**: Quick send buttons appear next to each content block

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
│  - Lightweight: just compares response IDs                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ New response detected
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: MUTATION OBSERVER (reactive)                          │
│  - Watches only the new response container                      │
│  - Debounces mutations (150ms)                                  │
│  - Checks for .animate-gaussian to detect streaming             │
│  - Processes complete elements immediately                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ No .animate-gaussian found
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 3: COMPLETION                                            │
│  - Final processing pass                                        │
│  - Disconnect observer                                          │
│  - Return to polling mode                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the extension folder
5. Click the extension icon and configure your Telegram bot

## Setup Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the instructions
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
4. Get your Chat ID from [@userinfobot](https://t.me/userinfobot)
5. Enter both in the extension popup

## Usage

1. Go to [grok.com](https://grok.com)
2. Start a conversation with Grok
3. The Persephone panel appears in the bottom-right corner
4. As Grok responds, chunks are captured in real-time
5. Click "Send" on individual chunks or "Send All" for everything

## Keyboard Shortcuts

(Coming soon)

## Files

```
persephone-extension/
├── manifest.json      # Extension configuration
├── background.js      # Service worker for Telegram API
├── content.js         # Main content script for grok.com
├── popup.html         # Settings popup UI
├── popup.js           # Settings popup logic
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Telegram Formatting

Content is converted to Telegram Markdown:

| HTML | Telegram |
|------|----------|
| `<strong>` | `*bold*` |
| `<em>` | `_italic_` |
| `<u>` | `__underline__` |
| `<del>` | `~strikethrough~` |
| `<code>` | `` `code` `` |
| `<pre>` | ` ```code block``` ` |
| `<h1>`-`<h6>` | `*Header*` |
| `<ul>` | `• item` |
| `<ol>` | `1. item` |

## Troubleshooting

### Buttons not appearing
- Make sure you're on grok.com (not x.com or other sites)
- Refresh the page
- Check if the extension is enabled

### Messages not sending
- Verify bot token and chat ID in settings
- Test connection using the "Test Connection" button
- Make sure the bot has permission to message you (send it a message first)

### Chunks not being captured
- This version requires the `animate-gaussian` class which Grok uses
- If Grok changes their DOM structure, the extension may need updating

## Version History

### v2.0.0
- Complete rewrite with `animate-gaussian` detection
- Hybrid polling + MutationObserver approach
- Improved UI with animations
- Better Telegram Markdown formatting

### v1.0.0
- Initial release with polling-based detection

## License

MIT License - feel free to modify and share!

## Credits

Built with ❤️ for the Grok community.