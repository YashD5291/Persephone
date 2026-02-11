# Persephone

A Chrome extension that monitors [grok.com](https://grok.com) and [claude.ai](https://claude.ai) and lets you send AI responses to Telegram with inline controls.

## Features

### Live Streaming to Telegram
- The first paragraph of each new response is **live-streamed** to Telegram word-by-word as it appears on screen
- Initial text is sent immediately, then the Telegram message is edited every 500ms as more words appear
- Final edit applies full Markdown formatting once the paragraph is complete
- Blue pulsing indicator shows which paragraph is actively streaming
- First chunk is always sent in full regardless of length (no splitting)

### Auto-Send First Chunk
- **Enabled by default** - automatically live-streams the first paragraph/heading when the AI starts responding
- Toggle in extension popup or press `Cmd/Ctrl+Shift+A` on page
- Visual indicator shows when auto-send is ON/OFF
- **Skip keywords** - configurable list of words (e.g., `short`, `shorter`, `shrt`) that prevent auto-send when found in the question. Useful for follow-up prompts where you're asking the AI to shorten/rewrite. Edit keywords in the extension popup (comma-separated). Defaults: `short, shorter, shrt, shrtr, shrter`

### Inline Send Buttons
- **Send button** appears next to each paragraph, list item, code block, and heading
- Click to send individual chunks to Telegram instantly
- Buttons appear in real-time as content streams

### Sub-Chunk Splitting
- Paragraphs longer than the **split threshold** (default 250 chars) get two send buttons (part 1 and part 2)
- Text is split at the nearest sentence boundary around the midpoint
- Split threshold is configurable in the extension popup (50-2000 chars)
- First auto-streamed chunk is exempt from splitting

### Resend, Edit & Delete
- After sending, buttons transform into **resend**, **edit**, and **delete**
- **Resend**: Send the same content again
- **Edit**: Opens a modal to modify the message in Telegram
- **Delete**: Removes the message from Telegram (with confirmation)
- Green checkmark indicates sent status

### Smart Content Detection
- Automatically detects paragraphs (`<p>`), headings (`<h1>`-`<h6>`), lists (`<ul>`, `<ol>`), code blocks (`<pre>`), blockquotes, and tables
- Preserves Markdown formatting: `*bold*`, `_italic_`, `` `code` ``
- Handles code blocks with language detection
- Splits long messages automatically (4096 char Telegram limit)

### Performance Optimizations
- **API Preconnect**: Establishes connection to Telegram API proactively when streaming starts
- **Settings Caching**: Credentials cached in memory for instant access
- **Connection Keep-Alive**: Maintains warm connection to reduce latency
- **Site-aware streaming detection**: Grok (`animate-gaussian` class) and Claude (`data-is-streaming` attribute)

## Supported Sites

| Site | Streaming Detection | Auto-Send | Skip Keywords |
|------|---------------------|-----------|---------------|
| [grok.com](https://grok.com) | `animate-gaussian` spans | Yes | Yes |
| [x.com/i/grok](https://x.com/i/grok) | `animate-gaussian` spans | Yes | Yes |
| [claude.ai](https://claude.ai) | `data-is-streaming` attribute | Yes | Yes (question detection TBD) |

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

The extension uses site-specific DOM observation to detect when AI responses are streaming and when individual content blocks are complete.

**Grok** uses animated spans during streaming:
```
STREAMING:   <p>Hello <span class="animate-gaussian">world</span></p>
COMPLETE:    <p>Hello world</p>  <- Ready to capture!
```

**Claude** uses a `data-is-streaming` attribute on response containers:
```
STREAMING:   <div data-is-streaming="true">
               <div class="progressive-markdown">
                 <div><div class="standard-markdown"><p>Hello world</p></div></div>
               </div>
             </div>

COMPLETE:    <div data-is-streaming="false">
               <div><div class="standard-markdown">
                 <p>Hello world</p>
                 <p>More text...</p>
               </div></div>
             </div>
```

Claude restructures its DOM when streaming completes - Persephone handles this by tracking text anchors and reading from the rebuilt DOM to capture the complete text.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  GLOBAL OBSERVER + POLLING (every 200ms)                         │
│  - Watches for new response containers (site-aware selectors)    │
│  - Scans all responses and adds buttons to complete elements     │
└──────────────────────────────────────────────────────────────────┘
                              │
                              v New streaming response detected
┌──────────────────────────────────────────────────────────────────┐
│  STREAMING OBSERVER (per-container MutationObserver)              │
│  - Watches childList, subtree, characterData changes             │
│  - Claude: also watches data-is-streaming attribute              │
│  - Processes elements as they complete                           │
│  - Adds inline send buttons immediately                          │
└──────────────────────────────────────────────────────────────────┘
          │                                        │
          v Auto-send enabled                      v Manual send
┌──────────────────────────┐    ┌──────────────────────────────────┐
│  LIVE STREAM              │    │  BUTTON CLICK                    │
│  - sendMessage (initial)  │    │  - sendMessage (full text)       │
│  - editMessageText @500ms │    │  - Replace with action buttons   │
│  - Final edit w/ markdown │    └──────────────────────────────────┘
│  - Track via text anchor  │
└──────────────────────────┘
```

## Project Structure

```
Persephone/
├── manifest.json      # Extension manifest (V3)
├── popup.html         # Settings popup UI
├── popup.css          # Popup styling
├── popup.js           # Popup logic
├── content.js         # DOM monitor & inline buttons (site-aware)
├── background.js      # Telegram API handler
├── .gitignore         # Git ignore file
└── icons/
    ├── icon16.png
    ├── icon48.png
    ├── icon128.png
    └── logo.png       # Popup header logo
```

## Button States

| State | Appearance | Actions |
|-------|------------|---------|
| Ready | White send icon | Click to send |
| Ready (split) | Two send icons with 1/2 badges | Click to send each half |
| Streaming | Blue pulsing indicator | Live-streaming to Telegram |
| Sent | Green checkmark + resend + edit + delete | Resend, edit, or delete |

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

## Keyboard Shortcuts

### On Page
- `Cmd + Shift + E` (Mac) / `Ctrl + Shift + E` (Windows/Linux) - Toggle extension ON/OFF
- `Cmd + Shift + A` (Mac) / `Ctrl + Shift + A` (Windows/Linux) - Toggle auto-send first chunk ON/OFF

### Edit Modal
- `Ctrl/Cmd + Enter` - Save changes
- `Escape` - Cancel and close

## Popup Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Bot Token | — | Telegram bot token from @BotFather |
| Chat ID | — | Telegram chat/user ID |
| Enable Extension | ON | Master toggle (also via Cmd/Ctrl+Shift+E) |
| Auto-send first chunk | ON | Live-stream first paragraph to Telegram |
| Skip keywords | `short, shorter, shrt, shrtr, shrter` | Suppress auto-send when question contains these |
| Split threshold | 250 | Character count above which paragraphs get two sub-chunk buttons |

## Troubleshooting

**"Extension disconnected" error:**
- The page was open too long. Refresh the page.

**Buttons not appearing:**
- Wait for the AI to finish streaming (buttons appear after content stabilizes)
- Make sure you're on grok.com or claude.ai
- Check the browser console for errors (F12 → Console)

**Live stream missing last words:**
- This can happen when Claude restructures its DOM after streaming completes. The extension reads from the rebuilt DOM to capture the full text. If it persists, the final edit should contain the complete paragraph.

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
- The extension only runs on grok.com, x.com/i/grok, and claude.ai domains
- No data is collected or transmitted elsewhere

## Version History

- **v4.0** - Claude.ai support, live streaming to Telegram, configurable split threshold, DOM rebuild handling
- **v3.6** - Skip keywords for auto-send (configurable via popup, skips auto-send when question contains keywords like "shorter")
- **v3.5** - Master toggle to enable/disable extension, keyboard shortcuts (Cmd/Ctrl+Shift+E/A)
- **v3.4** - Auto-send first chunk (enabled by default), resend button, individual list item buttons
- **v3.3** - Inline send/edit/delete buttons, streaming detection, latency optimizations
- **v3.0** - Floating panel with manual chunk selection
- **v2.0** - Real-time streaming detection with `animate-gaussian`
- **v1.0** - Initial release with polling-based detection

## License

MIT
