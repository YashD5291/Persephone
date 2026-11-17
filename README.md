# Persephone

A Chrome extension that monitors [grok.com](https://grok.com) and [claude.ai](https://claude.ai) and lets you send AI responses to Telegram with inline controls. Also supports voice-to-chat via MacWhisper integration and screenshot capture from other windows.

## Features

### Live Streaming to Telegram
- The first paragraph of each new response is **live-streamed** to Telegram word-by-word as it appears on screen
- The first text of the answer is sent the moment it appears, however short. After that the Telegram message is edited as the text grows: 0.3 s after the first text, then with each wait a quarter longer than the one before. There is no polling clock, so a chat tab that is not in front streams just as promptly
- **Telegram's limit is respected.** Telegram allows a bot about 20 messages a minute in one group, edits included, and answers a bot that goes over with "Too Many Requests: retry after N" (27 s has been seen), during which nothing gets through. The background worker counts every call of the last minute (`background/telegram-rate.js`). Edits that only show the answer growing stop once 15 calls are used; the rest is kept for the calls that carry the answer itself (first text, a new chunk, the final edit). If Telegram still refuses one of those, it is held for as long as Telegram asks and then sent, so text arrives late rather than never
- Final edit applies full Markdown formatting once the paragraph is complete
- Blue pulsing indicator shows which paragraph is actively streaming
- **First chunk word limit** — configurable word count (default 42) at which the auto-streamed first chunk splits into two Telegram messages. Adjustable in the popup and floating widget

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
- **Thinking filter** — Claude's thinking/reasoning section (reasoning text, web search results, tool timelines) is automatically excluded via `getResponseScope()` positive scoping — only the actual response container is observed, so thinking content is never even seen
- **Screen-reader heading filter** — Claude injects an `h2.sr-only` announcement (`Claude responded: …`) as the first child of each assistant message. Auto-send and inline buttons ignore it and bind to the real markdown paragraph instead
- Preserves Markdown formatting: `*bold*`, `_italic_`, `` `code` ``
- Handles code blocks with language detection
- Splits long messages automatically (4096 char Telegram limit)

### MacWhisper Voice Input
- **Floating mic button** on Grok/Claude pages — click to start/stop MacWhisper transcription
- Uses Chrome Native Messaging to trigger MacWhisper's F5 shortcut via a local Python host
- MacWhisper transcribes speech and types directly into the focused chat input
- **Auto-submit**: optionally submits the transcribed text immediately when recording stops (ideal for meetings)
- **Auto-restart mic**: optionally re-activates the mic after a configurable delay (default 3s) following auto-submit, enabling continuous hands-free dictation across multiple questions
- **Broadcast to all tabs**: when auto-submit is on, the transcribed question is sent to all open Grok/Claude tabs simultaneously without switching your active tab (great for split-view comparison)
- **Live text** (optional, off by default): instead of dictating and waiting for the transcript, MacWhisper's Live Captions transcribes while the person is still talking and the words appear in the chat box of the chat you choose as they are spoken. Nothing is sent; you press Enter. See [Live text](#live-text)
- **Latency breakdown**: after each auto-submitted voice question the page console logs one line, `⏱ stop click→key pressed … | key pressed→transcript … | transcript→submitted … | submitted→first words … | first words→Telegram … | total …`, showing where the time went
- **Race condition guard**: rapid mic clicks are safely ignored while a toggle is in-flight, preventing state desync between the button UI and actual MacWhisper recording state
- Keyboard shortcut: `Alt+M` to toggle recording
- Mic button turns red and pulses while recording

### Screenshot Capture
- **Floating camera button** on Grok/Claude pages — click to capture a screenshot from another window (e.g., Zoom, slides)
- First click opens Chrome's window/screen picker via `getDisplayMedia()` — select the window you want to capture
- **Region crop** — right after you pick the window, a snapshot appears and you drag a rectangle to capture only that portion. Every later capture reuses that region until you change it. Press **Enter** in the picker to capture the full window, **Esc** to cancel
- **Shift+click** the camera button to re-open the picker and draw a new region (or full-window)
- **Stream stays open** — subsequent clicks capture instantly without re-picking
- **Adjustable quality** — screenshots are saved as JPEG; set the quality (10–100%) with the slider in the popup settings. Lower = smaller files, less detail. Changes apply on the fly to the next capture
- Screenshot is pasted into the chat input automatically (synthetic paste into ProseMirror); a PNG copy is placed on the clipboard as a `Cmd+V` fallback where the browser allows it
- Green dot on camera button indicates an active stream
- **Broadcast to all tabs** — screenshot is queued for all other open Grok/Claude tabs and pasted automatically when you switch to each tab (paste only, no submit, stays on your current tab)
- **Alt+click** the camera button to stop the stream manually (also stops when you click "Stop sharing" in Chrome). Stopping the stream clears the saved region
- Button sits above the gear icon in the bottom-right floating stack

### Floating Settings Widget
- **Gear button** in the bottom-right corner of Grok/Claude pages — click to open the settings panel
- **Extension toggle** — enable/disable Persephone without opening the popup
- **The same switch on the page itself** — a small switch at the very top of the floating stack (green = on, grey = off) turns the whole extension on or off with one click, without opening the panel. It, the panel switch, the popup and `Cmd+Shift+E` all show and change the same setting
- **Voice auto-submit toggle** — turn auto-submit on/off directly from the page
- **Voice auto-restart toggle** — re-activate mic after voice submit, with configurable delay
- **Tab list with per-tab auto-send** — shows all open Grok/Claude tabs with their site badge (C/G), title, and individual auto-send toggles. Per-tab settings persist across page refreshes
- **Tab connectivity indicators** — green dot for reachable tabs, grey dot for stale/unreachable tabs (reload to reconnect)
- Current tab marked with "(here)" label
- **Split threshold** — adjust the sub-chunk split threshold inline
- Click outside the panel to close it
- The panel is never taller than the window: with many chats open it scrolls, and its title bar with the close button stays in view
- Settings sync instantly across the popup, widget, and all tabs via Chrome storage

### Performance Optimizations
- **API Preconnect**: Establishes connection to Telegram API proactively when a voice recording is stopped and when streaming starts
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

On a new Mac (needs Google Chrome; the installer asks for Apple's command line tools if they are missing):

```bash
git clone https://github.com/YashD5291/Persephone.git
cd Persephone
./install.sh
```

The installer:

1. Asks you to load the folder in Chrome if it is not loaded yet (`chrome://extensions` → Developer mode → **Load unpacked** → choose the `Persephone` folder), and opens that page for you.
2. Finds the extension ID Chrome gave the folder by itself (it differs on every Mac). You can also pass it: `./install.sh <extension-id>`.
3. Builds the live text helper and registers both native helpers (MacWhisper dictation and live text) with Chrome.

Then, once per Mac:

1. `chrome://extensions`: reload Persephone and refresh open claude.ai tabs.
2. Toolbar popup: enter the Telegram **Bot Token** and **Chat ID** (see [Getting Telegram Credentials](#getting-telegram-credentials)) and send a test message. Settings live in Chrome, not in the repo, so they do not carry over between Macs.
3. `chrome://extensions/shortcuts`: Persephone's shortcuts to `Cmd+Shift+1` (send) and `Cmd+Shift+2` (live text), scope **Global**.
4. MacWhisper ([download](https://goodsnooze.gumroad.com/l/macwhisper)): F5 as the dictation shortcut; Settings › Live Captions: Parakeet v3 and a keyboard shortcut (e.g. `Ctrl+Opt+Cmd+L`); in the Live Captions panel, the audio source the call arrives on.
5. The first time live text is switched on, allow **persephone-live** in System Settings › Privacy & Security › Accessibility, then switch it on again.

Run `./install.sh` again after pulling updates or moving the folder. To keep the Accessibility approval across rebuilds, have a code-signing certificate in the keychain (Keychain Access › Certificate Assistant › Create a Certificate, type Code Signing); without one the helper still works, but needs approving again after each rebuild.

## Live text

Normal dictation only starts transcribing after you stop it, then pastes the result: about 1.7 s between stopping and the question being in the chat box. Live text removes that wait. MacWhisper's **Live Captions** (same Parakeet model) transcribes continuously, a small native helper (`native-host/live`, `persephone-live`) reads the caption text, and the extension keeps one chat's box in step with it. The question is already in the box when the person stops talking.

Live text never sends anything. You read the question and press Enter yourself.

**Setup**

1. Run `./install.sh` (builds the helper and registers it with Chrome), then reload the extension.
2. In MacWhisper, open Settings > Live Captions once and set **Language** to your call's language (not Auto Detect), and check that captions listen to the device your call audio arrives on (e.g. `Loopback Audio`). Record a **Keyboard Shortcut** there as well (e.g. Control+Option+Command+L). The helper reads it from MacWhisper and uses it as its first choice for switching captions on and off, because it works whatever MacWhisper's window is showing and is the quickest; the on-screen button is the fallback. After that you do not need to touch MacWhisper: the helper starts Live Captions when live text is switched on and stops it when live text is switched off. It moves the captions panel to the bottom-right edge of the screen, where only a thin strip shows; drag it back if you want to see it.
3. Turn on **Live text (Live Captions)** in the floating settings widget.

**Using it**

- Fastest way: click the **live button** (the speech-lines button at the top of the floating stack). One click types live text into the chat you are looking at: it makes that chat the chosen one and switches live text on, or moves a running stream over from another chat. Click it again to switch live text off. It works whether or not the *Live text* setting is on, and it never sends anything. Colours: grey = off, blue = this is the chosen chat, red = typing here now, grey with a red dot = typing into another chat.
- With the *Live text* setting on, the mic (or `Alt+M`) switches live text on as well. The mic turns red and the chat box fills with what is being said, correcting itself as MacWhisper refines its guess. Click again to switch it off.
- Press Enter in the chat when the question is complete. The box empties, and the next words start a fresh question.
- You can type in the box while live text is running. Live text only rewrites its own words at the end of the box and puts your caret back where you had it, so anything you type in front of them ("Answer briefly: ...") stays, and the spoken words keep arriving behind it.
- If you correct one of the live words yourself, the whole box becomes yours and is not touched again; what is said after that is added at the end.
- Text that is already in the box when live text is switched on is kept, and the live words go after it.
- To throw away what has been heard so far, clear the box.
- MacWhisper's dictation key is not used in this mode.

**Choosing the chat**

By default the text goes to the chat where you switched live text on. To send it to a particular chat instead, open the settings widget and click the small mic next to that chat in the list (blue = chosen, red = receiving right now). The chosen chat receives the text even when its tab is not in front, and pressing the mic in any other chat tab controls the same stream. Click the blue mic again to clear the choice. The live button on a chat page does the choosing and the switching on in one click.

A chat that is refreshed while it is receiving carries on receiving: the page asks the extension for the live text state when it loads.

**Sending without opening the tab**

Two shortcuts work from anywhere, including while another app (the call window) is in front:

| Shortcut (Mac) | What it does |
|---|---|
| `Cmd+Shift+1` | Presses send in the chat that holds the question. Your own key press: live text never sends by itself. If the captions changed less than 0.7 s ago it waits until they have been still that long (1.2 s at most), because MacWhisper shows text in steps about 0.3 s apart and a press between two steps would send the question cut short. A press 0.7 s or more after the last words goes out at once |
| `Cmd+Shift+2` | Live text on / off |

Chrome only lets extensions use `Cmd+Shift+` a digit (`Ctrl+Shift+` a digit on Windows/Linux) for shortcuts that work outside Chrome. After reloading the extension, open `chrome://extensions/shortcuts`, check both are assigned, and make sure their scope is set to **Global**. You can pick other digits there.

**Knowing it is working**

While live text is on, the helper shows a small pill at the top centre of the screen, over whatever app is in front (full-screen apps included). It never takes focus and clicks pass through it.

| Pill | Meaning |
|---|---|
| Red dot, `Listening…` | Live text is on, nothing heard yet for this question |
| Red dot, words | The latest words heard; they are in the chat box too |
| Green dot, `Sent` | Your send shortcut pressed send in the chat |
| Green dot, `Telegram in 1.9 s (Claude 1.5 s)` | The first words of the answer reached Telegram: time from your send, and Claude's share of it |
| Red dot, `Starting Live Captions in MacWhisper…` | The helper is getting Live Captions running (starting MacWhisper too if needed) |
| Green dot, `Loopback Audio → chat name` | Captions are up: the audio source and the chat receiving the words |
| Orange dot, a message | Something is wrong, e.g. Live Captions could not be started, or there was nothing to send |
| No pill | Live text is off |

**What the helper does when MacWhisper is not ready**

MacWhisper has no command, link or script hook for Live Captions, so the helper drives its window through macOS Accessibility. Each state has a defined way back, taken one small step at a time (`native-host/live/Sources/LiveCore/CaptionsRecovery.swift`, covered by tests, and checked against the real app):

| MacWhisper is... | With a shortcut recorded | Without one | Measured time to captions |
|---|---|---|---|
| open on its home screen | sends the shortcut | presses the Live Captions button | about 2 s |
| showing another screen | sends the shortcut | selects Home in the sidebar, then presses the button | 1.2 s / about 3 s |
| running with its window closed | sends the shortcut | reopens the window from the Window menu, then presses the button | 1.2 s / about 2.5 s |
| not running | starts it, then sends the shortcut | starts it, then presses the button | about 7 to 8 s |
| captions closed by hand mid-call | waits 2 s to be sure they are really gone, then starts them again | same | about 3 s in all |

If a shortcut press produces no captions, the next try uses the button, and the other way round.

- MacWhisper brings itself to the front when it launches and whenever captions start. The helper puts the app you were in back in front straight away.
- The Live Captions control is a toggle, so the helper never presses it twice in a row without waiting, and gives up after three presses that produce no captions rather than flip them on and off. The pill then says so; switching live text off and on tries again.
- If MacWhisper does not answer within a second, the helper keeps its last reading rather than act on a guess.
- When captions come up the pill shows the path for a few seconds, e.g. `Loopback Audio → Handoff segment 1`: the audio source MacWhisper reports and the chat receiving the words. If the source is not the one your call arrives on, fix it in MacWhisper.
- If the helper itself dies mid-call, the extension starts it again (up to three times a minute).

**Measuring the delay**

Every live question is timed, with no stopwatch needed. When the first words of the answer reach Telegram:

- the pill shows the headline, e.g. `Telegram in 1.9 s (Claude 1.5 s)`;
- the page console logs each stage: `⏱ live: last word→send … | send→submitted … | submitted→first words … | first words→Telegram … | send→Telegram …`;
- the record is stored (`voiceTimings` in the extension's local storage, last 100) for averaging over a whole call.

"last word→send" is your own decision time and is not part of the headline. "send→submitted" is `n/a` when you pressed Enter in the tab rather than the send shortcut, because the key press itself is not seen. Timing needs auto-send to Telegram to be on for that chat.

MacWhisper does not keep Live Captions in its history: nothing is written to its database while captions run. The only lasting copy of a question is the message you send in the chat.

**Things to know**

- Captions trail the voice by a fraction of a second, and MacWhisper re-transcribes the sentence in progress several times a second, so the last words can still change for a moment after the speaker stops.
- The helper copies what MacWhisper's panel shows; it cannot be more accurate than the panel. Two things the panel does are worth knowing. It sometimes leaves the last word of a sentence unfinished ("your last ro") until a second or more later, or until the next person speaks. And a second or two after a sentence ends it may transcribe the sentence once more, which can change several words. A question sent very quickly goes out as it stood at that moment.
- The panel also redraws itself in ways that are not speech: it drops a sentence for one read and shows it again, flips back to a sentence it had replaced, and takes back first guesses. The helper tells these apart from real changes (`native-host/live/Sources/LiveCore/CaptionStitcher.swift`); recordings of the panel are replayed in its tests (`Tests/LiveCoreTests/Fixtures`).
- The helper reads the caption panel through macOS Accessibility. The first time live text is switched on, macOS asks to allow **persephone-live** (the helper itself, not Chrome) under System Settings > Privacy & Security > Accessibility. The status pill says so until it is allowed.
- macOS ties that approval to the helper's code signature. `native-host/live/build.sh` signs the helper with a certificate from your keychain so the approval survives rebuilds; always build with that script (`npm run build:live`). If the pill keeps asking for Accessibility after you allowed it, the approval belongs to an older build: remove `persephone-live` from the Accessibility list with the minus button and allow it again.
- Captions only keep a few lines on screen. The helper remembers what has scrolled away, so long questions arrive whole.
- To watch the helper without Chrome: `native-host/live/.build/release/persephone-live --print`.

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
CURRENT (completed or streaming):
  div[data-is-streaming]
    ├── h2.sr-only.select-none     ← "Claude responded: …" (ignored)
    └── div.font-claude-response
        └── .standard-markdown / .progressive-markdown
            ├── <p>Hello world</p>  ← first real chunk (captured)
            └── <p>More text...</p>

STREAMING (older thinking-model grid):
  div[data-is-streaming="true"]
    └── div.font-claude-response
        └── div.grid
            ├── div.row-start-1              ← collapsed summary button (ignored)
            └── div.row-start-2              ← contains both:
                ├── div.row-start-1 z-[2]    ← ACTUAL RESPONSE (captured)
                │   └── .standard-markdown / .progressive-markdown
                └── div.row-start-1 z-[3]    ← .font-ui tool timeline (ignored)
                    └── web search, reasoning steps, etc.
```

`getResponseScope(container)` narrows observation to the actual response:
- Prefers `.standard-markdown` / `.progressive-markdown` (or `.font-claude-response`) so the sibling `h2.sr-only` announcement is never seen
- Older thinking grid: finds `.row-start-2`, then the child `.row-start-1` that does NOT contain `.font-ui`
- If `.row-start-2` has no non-`.font-ui` child yet, returns `null` (response not ready)
- `findFirstContentElement()` also skips `.sr-only` nodes as defense in depth
- All element queries (`processContainer`, `isElementStreaming`, `waitForFirstElement`) run against the scoped node, so thinking/tool/announcement content is never captured

Claude restructures its DOM when streaming completes — Persephone handles this by tracking text anchors and reading from the rebuilt DOM to capture the complete text.

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
│  STREAMING OBSERVER (per-container MutationObserver)             │
│  - Watches childList, subtree, characterData changes             │
│  - Claude: also watches data-is-streaming attribute              │
│  - Processes elements as they complete                           │
│  - Adds inline send buttons immediately                          │
└──────────────────────────────────────────────────────────────────┘
          │                                        │
          v Auto-send enabled                      v Manual send
┌───────────────────────────┐    ┌──────────────────────────────────┐
│  LIVE STREAM              │    │  BUTTON CLICK                    │
│  - sendMessage (initial)  │    │  - sendMessage (full text)       │
│  - edit on every change   │    │  - Replace with action buttons   │
│  - Final edit w/ markdown │    └──────────────────────────────────┘
│  - Track via text anchor  │
└───────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  SCREENSHOT CAPTURE (getDisplayMedia)                            │
│  - Camera button click → getDisplayMedia() → select window       │
│  - Stream kept open → subsequent clicks capture instantly        │
│  - Frame drawn to canvas → PNG blob → clipboard + synthetic paste│
│  - Blob → dataURL → BROADCAST_SCREENSHOT → queued per tab        │
│  - Background tabs: deferred paste on visibilitychange           │
│  - Alt+click or Chrome "Stop sharing" → cleanup stream           │
└──────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│  VOICE INPUT (MacWhisper via Native Messaging)                    │
│  - Mic button click → focus chat input → TOGGLE_WHISPER           │
│  - background.js → sendNativeMessage → persephone_host.py         │
│  - Python host simulates F5 keypress via osascript                │
│  - MacWhisper transcribes and types into focused input            │
│  - Stop recording → poll input for text → auto-submit (optional)  │
│  - Auto-restart: setTimeout → handleMicClick() after delay        │
│  - Re-entrancy guard prevents rapid-click state desync            │
│  - BROADCAST_QUESTION → insert + submit in all other tabs         │
└───────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  FLOATING SETTINGS WIDGET (gear button)                            │
│  - Extension toggle, voice auto-submit toggle                      │
│  - Tab list: GET_TAB_LIST → background queries all matching tabs   │
│  - Per-tab auto-send toggles (SET_TAB_AUTO_SEND to other tabs)     │
│  - Split threshold input (debounced save)                          │
│  - Syncs with popup and storage changes in real time               │
└────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
Persephone/
├── manifest.json          # Extension manifest (V3)
├── background.js          # Service worker entry (loads background/*.js via importScripts)
├── background/
│   ├── constants.js       # MSG protocol constants
│   ├── logger.js          # Structured logger
│   ├── settings.js        # Settings cache, tab overrides, ensureSettings
│   ├── native.js          # MacWhisper native messaging
│   ├── live.js            # Live text: helper port, target chat, on/off state
│   ├── telegram-rate.js   # Counts Telegram calls per minute; holds back progress edits, retries essential ones
│   ├── telegram.js        # Telegram API (send, edit, delete, preconnect)
│   ├── messages.js        # Message router, validation, pre-init queue
│   └── init.js            # Lifecycle listeners, initialize()
├── content/
│   ├── constants.js       # MSG constants, shared namespace init
│   ├── logger.js          # Structured logger with categories
│   ├── state.js           # Centralized state, container ID tracking
│   ├── selectors.js       # Site detection, selector registry with fallbacks
│   ├── text.js            # Text extraction, hashing, formatting
│   ├── telegram.js        # Telegram API calls from content script
│   ├── buttons.js         # Button injection, action groups, edit modal
│   ├── pacer.js           # Sends each change as early as Telegram's rate limit allows
│   ├── streaming.js       # MutationObservers, live stream first chunk
│   ├── voice.js           # MacWhisper voice input, chat input helpers
│   ├── screenshot.js      # Screenshot capture and paste
│   ├── widget.js          # Floating settings widget, toggles
│   ├── styles.js          # CSS injection
│   └── init.js            # Entry point, event wiring, diagnostics
├── popup.html             # Settings popup UI
├── popup.css              # Popup styling
├── popup.js               # Popup logic
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── logo.png           # Popup header logo
└── native-host/
    ├── persephone_host.py      # Native messaging host (Python)
    ├── live/                   # persephone-live: reads MacWhisper Live Captions, shows the status pill (Swift package)
    ├── com.persephone.host.json # Native messaging manifest template
    └── install.sh               # Calls ../install.sh (kept for old instructions)
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
- `Alt + M` - Toggle MacWhisper recording (start/stop), or live text on/off when Live text is enabled
- `Cmd/Ctrl + Shift + 1` - Send the question waiting in the target chat, from any app (see [Live text](#live-text))
- `Cmd/Ctrl + Shift + 2` - Live text on/off, from any app

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
| Auto-restart mic | OFF | Re-activate mic after voice submit for continuous dictation |
| Mic restart delay | 3 | Seconds to wait before re-activating mic (1-30) |
| Skip keywords | `short, shorter, shrt, shrtr, shrter` | Suppress auto-send when question contains these |
| First chunk split (words) | 42 | Word count at which the auto-streamed first chunk splits into two messages |
| Split threshold | 250 | Character count above which paragraphs get two sub-chunk buttons |
| Screenshot quality (JPEG) | 85% | Compression quality for captured screenshots (10–100%); lower = smaller files |

## Widget Settings (on-page)

| Setting | Description |
|---------|-------------|
| Extension | Master toggle (same as popup) |
| Voice auto-submit | Toggle auto-submit for voice input |
| Voice auto-restart | Toggle mic auto-restart after voice submit |
| Live text (Live Captions) | Fill the chat box from MacWhisper Live Captions while the question is being asked (default OFF) |
| Auto-send (per tab) | Toggle auto-send individually for each open Grok/Claude tab |
| Split threshold | Adjust sub-chunk split threshold |
| 1st chunk words | Adjust first chunk word limit |
| Restart delay (s) | Adjust mic restart delay |

## Troubleshooting

**"Extension disconnected" error:**
- The page was open too long. Refresh the page.

**Buttons not appearing:**
- Wait for the AI to finish streaming (buttons appear after content stabilizes)
- Make sure you're on grok.com or claude.ai
- Check the browser console for errors (F12 → Console)

**Live stream is just `Claude responded: …`:**
- That string is Claude's screen-reader heading (`h2.sr-only`), not the real answer. Reload the extension after v5.4 so auto-send binds to the first markdown paragraph instead.

**Live stream missing last words:**
- This can happen when Claude restructures its DOM after streaming completes. The extension reads from the rebuilt DOM to capture the full text. If it persists, the final edit should contain the complete paragraph.

**Edit not working:**
- Multi-part messages (split due to length) cannot be edited
- Telegram only allows editing messages for 48 hours

**Delete not working:**
- Telegram only allows deleting messages for 48 hours
- Bot must have delete permissions in group chats

**Mic button not appearing:**
- Make sure the native messaging hosts are installed (`./install.sh`)
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

- **v5.6** - Live text: optional mode that streams MacWhisper Live Captions into the chat box of a chosen chat (never sends; you press Enter). Telegram live stream now sends the first text immediately and pushes every change as it happens instead of every 500 ms
- **v5.5** - Telegram connection warmed when a voice recording is stopped; per-question latency breakdown in the console
- **v5.4** - Ignore Claude's `h2.sr-only` "Claude responded:" announcement so auto-send binds to the real first markdown paragraph
- **v5.3** - Screenshot region crop (drag once after picking a window, reused every capture; Shift+click to re-pick, Enter for full window) and adjustable JPEG quality slider in the popup
- **v5.2** - Voice auto-restart mic (re-activate after voice submit with configurable delay), mic button race condition fix (re-entrancy guard prevents rapid-click state desync)
- **v5.1** - First chunk word limit (configurable split point for auto-streamed first chunk), tab connectivity indicators (green/grey dots for reachable/stale tabs), selector health check improvements
- **v5.0** - Production hardening: modular file split (content.js → 13 modules, background.js → 7 modules), structured logging, centralized state, cyrb53 hashing, selector fallback chains, async init with settings gate, per-container streaming locks, message protocol constants with validation, service worker pre-init queue, stale settings detection
- **v4.7** - Positive-scoping thinking filter via `getResponseScope()` (ignores `.font-ui` tool timelines and thinking UI entirely), fixes for web search "10 results" leaking into auto-stream, auto-stream sent-state preserved across Claude DOM rebuilds
- **v4.6** - Per-tab auto-send persistence across refreshes, deferred screenshot paste for background tabs, voice/screenshot broadcasts no longer switch active tab, color-coded toast notifications, Claude thinking section filter, skip keywords support for Claude
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
