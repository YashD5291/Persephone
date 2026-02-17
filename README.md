# Persephone

A Chrome extension that monitors [grok.com](https://grok.com) and [claude.ai](https://claude.ai) and lets you send AI responses to Telegram with inline controls. Also supports voice-to-chat via MacWhisper integration and screenshot capture from other windows.

## Features

### Live Streaming to Telegram
- The first paragraph of each new response is **live-streamed** to Telegram word-by-word as it appears on screen
- Initial text is sent immediately, then the Telegram message is edited every 500ms as more words appear
- Final edit applies full Markdown formatting once the paragraph is complete
- Blue pulsing indicator shows which paragraph is actively streaming
- First chunk is always sent in full regardless of length (no splitting)

### Auto-Send First Chunk
- **Enabled by default** - automatically live-streams the first paragraph/heading when the AI starts responding
- **Per-tab control** - toggle auto-send independently for each open Grok/Claude tab from the floating settings widget. Settings persist across page refreshes
- Press `Cmd/Ctrl+Shift+A` on page to toggle the current tab's auto-send
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

### MacWhisper Voice Input
- **Floating mic button** on Grok/Claude pages — click to start/stop MacWhisper transcription
- Uses Chrome Native Messaging to trigger MacWhisper's F5 shortcut via a local Python host
- MacWhisper transcribes speech and types directly into the focused chat input
- **Auto-submit**: optionally submits the transcribed text immediately when recording stops (ideal for meetings)
- **Broadcast to all tabs**: when auto-submit is on, the transcribed question is sent to all open Grok/Claude tabs simultaneously without switching your active tab (great for split-view comparison)
- Keyboard shortcut: `Alt+M` to toggle recording
- Mic button turns red and pulses while recording

### Screenshot Capture
- **Floating camera button** on Grok/Claude pages — click to capture a screenshot from another window (e.g., Zoom, slides)
- First click opens Chrome's window/screen picker via `getDisplayMedia()` — select the window you want to capture
- **Stream stays open** — subsequent clicks capture instantly without re-picking
- Screenshot is copied to clipboard and pasted into the chat input automatically (synthetic paste into ProseMirror)
- If synthetic paste doesn't work, image is on clipboard — just `Cmd+V`
- Green dot on camera button indicates an active stream
- **Broadcast to all tabs** — screenshot is queued for all other open Grok/Claude tabs and pasted automatically when you switch to each tab (paste only, no submit, stays on your current tab)
- **Alt+click** the camera button to stop the stream manually (also stops when you click "Stop sharing" in Chrome)
- Button sits above the gear icon in the bottom-right floating stack

### Floating Settings Widget
- **Gear button** in the bottom-right corner of Grok/Claude pages — click to open the settings panel
- **Extension toggle** — enable/disable Persephone without opening the popup
- **Voice auto-submit toggle** — turn auto-submit on/off directly from the page
- **Tab list with per-tab auto-send** — shows all open Grok/Claude tabs with their site badge (C/G), title, and individual auto-send toggles. Per-tab settings persist across page refreshes
- Current tab marked with "(here)" label
- **Split threshold** — adjust the sub-chunk split threshold inline
- Click outside the panel to close it
- Settings sync instantly across the popup, widget, and all tabs via Chrome storage

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
| [claude.ai](https://claude.ai) | `data-is-streaming` attribute | Yes | Yes |

## Installation

1. **Open Chrome Extensions page:**
   - Navigate to `chrome://extensions/`
   - Or go to Menu → More Tools → Extensions

2. **Enable Developer Mode:**
   - Toggle the "Developer mode" switch in the top-right corner

3. **Load the extension:**
   - Click "Load unpacked"
   - Select the `Persephone` folder
   - Note the **Extension ID** shown on the card (you'll need it for step 5)

4. **Configure Telegram:**
   - Click the Persephone icon in your toolbar
   - Enter your **Bot Token** (from @BotFather)
   - Enter your **Chat ID** (your user ID or group chat ID)
   - Click "Save Settings"
   - Use "Test Connection" to verify it works

5. **Set up MacWhisper voice input (optional):**
   - Requires [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) with F5 as the record shortcut
   - Run the install script:
     ```bash
     cd native-host
     chmod +x install.sh
     ./install.sh
     ```
   - Enter your Extension ID when prompted
   - Restart Chrome
   - A floating mic button will appear on Grok/Claude pages

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

┌──────────────────────────────────────────────────────────────────┐
│  SCREENSHOT CAPTURE (getDisplayMedia)                              │
│  - Camera button click → getDisplayMedia() → select window         │
│  - Stream kept open → subsequent clicks capture instantly           │
│  - Frame drawn to canvas → PNG blob → clipboard + synthetic paste   │
│  - Blob → dataURL → BROADCAST_SCREENSHOT → queued per tab            │
│  - Background tabs: deferred paste on visibilitychange               │
│  - Alt+click or Chrome "Stop sharing" → cleanup stream              │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  VOICE INPUT (MacWhisper via Native Messaging)                    │
│  - Mic button click → focus chat input → TOGGLE_WHISPER           │
│  - background.js → sendNativeMessage → persephone_host.py         │
│  - Python host simulates F5 keypress via osascript                │
│  - MacWhisper transcribes and types into focused input            │
│  - Stop recording → poll input for text → auto-submit (optional)  │
│  - BROADCAST_QUESTION → insert + submit in all other tabs          │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  FLOATING SETTINGS WIDGET (gear button)                            │
│  - Extension toggle, voice auto-submit toggle                      │
│  - Tab list: GET_TAB_LIST → background queries all matching tabs   │
│  - Per-tab auto-send toggles (SET_TAB_AUTO_SEND to other tabs)     │
│  - Split threshold input (debounced save)                          │
│  - Syncs with popup and storage changes in real time               │
└──────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
Persephone/
├── manifest.json      # Extension manifest (V3)
├── popup.html         # Settings popup UI
├── popup.css          # Popup styling
├── popup.js           # Popup logic
├── content.js         # DOM monitor, inline buttons, voice input (site-aware)
├── background.js      # Telegram API handler, native messaging bridge
├── .gitignore         # Git ignore file
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── logo.png       # Popup header logo
└── native-host/
    ├── persephone_host.py      # Native messaging host (Python)
    ├── com.persephone.host.json # Native messaging manifest template
    └── install.sh               # One-time setup script
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
- `Cmd + Shift + A` (Mac) / `Ctrl + Shift + A` (Windows/Linux) - Toggle auto-send for current tab ON/OFF
- `Alt + M` - Toggle MacWhisper recording (start/stop)

### Edit Modal
- `Ctrl/Cmd + Enter` - Save changes
- `Escape` - Cancel and close

## Popup Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Bot Token | — | Telegram bot token from @BotFather |
| Chat ID | — | Telegram chat/user ID |
| Enable Extension | ON | Master toggle (also via Cmd/Ctrl+Shift+E) |
| Auto-submit voice input | OFF | Automatically submit transcribed text when recording stops |
| Skip keywords | `short, shorter, shrt, shrtr, shrter` | Suppress auto-send when question contains these |
| Split threshold | 250 | Character count above which paragraphs get two sub-chunk buttons |

## Widget Settings (on-page)

| Setting | Description |
|---------|-------------|
| Extension | Master toggle (same as popup) |
| Voice auto-submit | Toggle auto-submit for voice input |
| Auto-send (per tab) | Toggle auto-send individually for each open Grok/Claude tab |
| Split threshold | Adjust sub-chunk split threshold |

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

**Mic button not appearing:**
- Make sure the native messaging host is installed (`native-host/install.sh`)
- Verify the extension ID in the manifest matches your actual extension ID
- Restart Chrome after installing the native host

**Voice auto-submit not working:**
- Enable "Voice auto-submit" in the extension popup or the floating settings widget
- Make sure the chat input is focused before starting recording (the mic button does this automatically)
- If you switched tabs during recording, click the chat input area before stopping

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

- **v4.6** - Per-tab auto-send persistence across refreshes, deferred screenshot paste for background tabs, voice/screenshot broadcasts no longer switch active tab, color-coded toast notifications (green success, red error)
- **v4.5** - Floating settings widget with gear button, per-tab auto-send management via tab list, inline extension/voice/threshold controls
- **v4.4** - Screenshot broadcast to all tabs, ImageCapture API for higher-resolution frames
- **v4.3** - Screenshot capture from other windows via floating camera button, stream-and-capture workflow
- **v4.2** - Per-site auto-send toggles (Claude/Grok independent), voice broadcast to all open tabs
- **v4.1** - MacWhisper voice input via native messaging, floating mic button, auto-submit, Alt+M shortcut
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
