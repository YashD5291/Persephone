// ============================================
// LIVE TEXT (MacWhisper Live Captions -> chat box)
// ============================================
//
// A native host reads the text MacWhisper shows in its Live Captions panel
// and streams it here. While live text is on, the text is forwarded to one
// chat tab, which keeps its chat box in step with what is being said. Nothing
// is ever sent to the chat by this module: the user presses Enter.
//
// Which tab receives the text:
//   - the tab the user picked as the target in the settings widget, or
//   - if none was picked, the tab where live text was switched on.

const LIVE_HOST = 'com.persephone.live';
const LIVE_TARGET_KEY = 'liveTargetTabId';
const CHAT_TAB_URLS = ['https://grok.com/*', 'https://x.com/i/grok*', 'https://claude.ai/*'];

// The open port keeps this service worker (and the host process) alive, so
// it is closed once live text has been off for this long.
const LIVE_IDLE_DISCONNECT_MS = 5 * 60 * 1000;

// If the helper dies while live text is on it is started again, up to this
// many times within the window. More than that means something is wrong with
// it, and restarting forever would only hide that.
const LIVE_RESTART_LIMIT = 3;
const LIVE_RESTART_WINDOW_MS = 60 * 1000;

// The pill names the audio source and the receiving chat once the helper has
// reported the source. If it never does, the chat alone is named after this long.
const LIVE_ANNOUNCE_FALLBACK_MS = 4000;

// Remembers the receiving tab across a restart of this service worker.
const LIVE_SESSION_KEY = 'liveActiveTabId';

// The captions trail the voice, and they arrive in steps: MacWhisper shows a
// new version of the sentence about every 0.3 s, and a step that changes
// nothing cannot be seen from here. Measured on 2026-10-12, 30 of 33 gaps
// between two changes inside a question were under 0.4 s and the other three
// were 0.64 to 0.83 s (one silent step). A send pressed inside such a gap went
// out without the last words ("...a data pipeline that handles"). So a press
// that comes sooner than two steps after the last change waits until the
// change is this old...
const LIVE_SETTLE_QUIET_MS = 700;
// ...but the question is never held back longer than this after the press.
const LIVE_SETTLE_MAX_MS = 1200;

let livePort = null;
// Tab that is receiving live text right now (null = live text is off).
let liveTabId = null;
// Tab the user chose to receive live text (null = whichever tab switches it on).
let liveTargetTabId = null;
let liveIdleTimer = null;
// When the helper last reported new words (ms since epoch).
let liveLastTextAt = 0;
// Audio source MacWhisper's captions are listening to, as reported by the helper.
let liveSource = null;
let liveAnnounceTimer = null;
// Times (ms since epoch) at which the helper was restarted after dying.
let liveRestarts = [];

async function loadLiveTarget() {
  try {
    const data = await chrome.storage.local.get(LIVE_TARGET_KEY);
    liveTargetTabId = data[LIVE_TARGET_KEY] ?? null;
  } catch (e) {
    liveTargetTabId = null;
  }
}

function sendToLiveTab(message) {
  if (liveTabId == null) return;
  chrome.tabs.sendMessage(liveTabId, message).catch(() => {});
}

/**
 * Tell every chat tab whether live text is on and where it is going, so each
 * mic button and settings widget shows the same thing.
 */
function broadcastLiveState() {
  chrome.tabs.query({ url: CHAT_TAB_URLS }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: MSG.LIVE_STATE, ...liveStateFor(tab.id) }).catch(() => {});
    });
  });
}

/**
 * Live text state as one tab sees it. A page asks for this when it loads, so
 * a chat that is refreshed while it is receiving carries on receiving.
 */
function liveStateFor(tabId) {
  return {
    active: liveTabId != null,
    activeHere: tabId != null && tabId === liveTabId,
    targetHere: tabId != null && tabId === liveTargetTabId,
    targetTabId: liveTargetTabId,
  };
}

function connectLiveHost() {
  if (livePort) return livePort;

  livePort = chrome.runtime.connectNative(LIVE_HOST);
  livePort.onMessage.addListener((message) => {
    if (message.type === 'text') {
      // An empty text is the helper confirming a fresh question, not someone talking.
      if (message.text) liveLastTextAt = Date.now();
      sendToLiveTab({ type: MSG.LIVE_TEXT, text: message.text });
    } else if (message.type === 'status' && message.source) {
      // Follow-up to "ready": which audio source the captions are listening to.
      liveSource = message.source;
      clearTimeout(liveAnnounceTimer);
      announceLiveChat(liveTabId);
    } else if (message.type === 'status') {
      sendToLiveTab({ type: MSG.LIVE_STATUS, state: message.state });
    }
  });
  livePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'host exited';
    log.native.warn('Live text host disconnected:', error);
    livePort = null;
    if (liveTabId == null) return;

    // The helper died while live text was on. Start it again rather than
    // leave the user mid-call with a dead mic button.
    const now = Date.now();
    liveRestarts = liveRestarts.filter((at) => now - at < LIVE_RESTART_WINDOW_MS);
    if (liveRestarts.length < LIVE_RESTART_LIMIT) {
      liveRestarts.push(now);
      if (markLiveQuestion()) {
        log.native.warn(`Live text host restarted (${liveRestarts.length}/${LIVE_RESTART_LIMIT})`);
        return;
      }
    }
    sendToLiveTab({ type: MSG.LIVE_STATUS, state: 'host_unavailable', error });
    sendToLiveTab({ type: MSG.LIVE_SET_ACTIVE, active: false });
    liveTabId = null;
    rememberLiveTab();
    broadcastLiveState();
  });
  return livePort;
}

/**
 * Keep the receiving tab where a restarted service worker can find it.
 */
function rememberLiveTab() {
  const session = chrome.storage?.session;
  if (!session) return;
  if (liveTabId == null) session.remove(LIVE_SESSION_KEY); else session.set({ [LIVE_SESSION_KEY]: liveTabId });
}

/**
 * Called when the service worker starts: if live text was on when it was
 * stopped, pick it up again for the same tab.
 */
async function restoreLiveText() {
  const session = chrome.storage?.session;
  if (!session || liveTabId != null) return;
  try {
    const data = await session.get(LIVE_SESSION_KEY);
    const tabId = data?.[LIVE_SESSION_KEY];
    if (tabId != null) {
      log.native.warn('Restoring live text after a service worker restart, tab:', tabId);
      await startLiveText(tabId);
    }
  } catch (error) {
    log.native.warn('Could not restore live text:', error.message);
  }
}

function disconnectLiveHost() {
  clearTimeout(liveIdleTimer);
  if (livePort) livePort.disconnect();
  livePort = null;
}

/**
 * Start a fresh question: the host forgets what was said before now.
 */
function markLiveQuestion() {
  try {
    connectLiveHost().postMessage({ cmd: 'mark' });
    return true;
  } catch (error) {
    log.native.error('Live text host error:', error.message);
    livePort = null;
    return false;
  }
}

/**
 * Switch live text on for one tab. Returns false if that tab cannot be reached.
 */
async function activateLiveTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.LIVE_SET_ACTIVE, active: true });
  } catch (error) {
    log.native.warn('Live text tab unreachable:', tabId, error.message);
    return false;
  }
  liveTabId = tabId;
  return true;
}

async function startLiveText(requestingTabId) {
  clearTimeout(liveIdleTimer);

  let started = false;
  if (liveTargetTabId != null) {
    started = await activateLiveTab(liveTargetTabId);
    // The chosen chat was closed or needs a reload: forget it and use the asking tab.
    if (!started) setLiveTarget(null);
  }
  if (!started && requestingTabId != null) started = await activateLiveTab(requestingTabId);
  if (!started) return { success: false, error: 'No chat tab to send live text to' };

  if (!markLiveQuestion()) {
    sendToLiveTab({ type: MSG.LIVE_SET_ACTIVE, active: false });
    liveTabId = null;
    return { success: false, error: 'host_unavailable' };
  }
  rememberLiveTab();
  broadcastLiveState();
  clearTimeout(liveAnnounceTimer);
  liveAnnounceTimer = setTimeout(() => announceLiveChat(liveTabId), LIVE_ANNOUNCE_FALLBACK_MS);
  return { success: true, active: true, tabId: liveTabId };
}

function stopLiveText() {
  sendToLiveTab({ type: MSG.LIVE_SET_ACTIVE, active: false });
  liveTabId = null;
  liveSource = null;
  liveRestarts = [];
  clearTimeout(liveAnnounceTimer);
  rememberLiveTab();
  try {
    livePort?.postMessage({ cmd: 'pause' });
  } catch (error) {
    log.native.warn('Live text host pause failed:', error.message);
  }
  clearTimeout(liveIdleTimer);
  liveIdleTimer = setTimeout(disconnectLiveHost, LIVE_IDLE_DISCONNECT_MS);
  broadcastLiveState();
  return { success: true, active: false };
}

/**
 * Mic button / shortcut: switch live text on or off.
 */
async function toggleLiveText(requestingTabId) {
  return liveTabId != null ? stopLiveText() : startLiveText(requestingTabId);
}

/**
 * The live button on a chat page: one click means "live text into this chat".
 *   off                  this chat becomes the target and live text starts
 *   on, in this chat     off (the chat stays the target)
 *   on, in another chat  it moves here
 */
async function liveTextHere(tabId) {
  if (tabId == null) return { success: false, error: 'No chat tab to send live text to' };
  if (liveTabId === tabId) return stopLiveText();
  setLiveTarget(tabId);   // moves a running stream to this chat by itself
  if (liveTabId != null) return { success: true, active: true, tabId };
  return startLiveText(tabId);
}

/**
 * Choose the chat that receives live text (null = whichever tab switches it
 * on). If live text is running, it moves to the new chat straight away.
 */
function setLiveTarget(tabId) {
  liveTargetTabId = tabId ?? null;
  chrome.storage.local.set({ [LIVE_TARGET_KEY]: liveTargetTabId });

  if (liveTabId != null && liveTargetTabId != null && liveTargetTabId !== liveTabId) {
    const previous = liveTabId;
    activateLiveTab(liveTargetTabId).then((moved) => {
      if (moved) {
        chrome.tabs.sendMessage(previous, { type: MSG.LIVE_SET_ACTIVE, active: false }).catch(() => {});
        markLiveQuestion();
        rememberLiveTab();
        announceLiveChat(liveTabId);
      }
      broadcastLiveState();
    });
  } else {
    broadcastLiveState();
  }
  return { success: true, targetTabId: liveTargetTabId };
}

/**
 * Send shortcut: press send in the chat that holds the question, without the
 * user having to bring that tab to the front. It is the user's own key press;
 * nothing here sends on its own.
 *
 * The wait for the last words happens here rather than in the page because
 * Chrome slows timers in a tab that is not in front, and that is exactly the
 * tab this is for.
 */
async function sendLiveQuestion() {
  const pressedAt = Date.now();
  const tabId = liveTabId ?? liveTargetTabId ?? await activeChatTabId();
  if (tabId == null) return { success: false, error: 'No chat tab to send in' };

  if (liveTabId != null) {
    const deadline = Date.now() + LIVE_SETTLE_MAX_MS;
    while (Date.now() - liveLastTextAt < LIVE_SETTLE_QUIET_MS && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  let result;
  try {
    // Clock readings for the latency record: when the key was pressed (taken
    // on entry, before the wait for the last words) and when the last words arrived.
    result = await chrome.tabs.sendMessage(tabId, { type: MSG.LIVE_SUBMIT, pressedAt, lastTextAt: liveLastTextAt || null });
  } catch (error) {
    log.native.warn('Send shortcut: chat tab unreachable:', tabId, error.message);
    result = { success: false, error: error.message };
  }
  // The chat tab is usually not in front when this shortcut is used, so the
  // helper's on-screen status pill is where the user sees that it worked.
  flashLivePill(result?.success ? 'Sent' : 'Nothing to send', result?.success ? 'confirmation' : 'problem');
  return result;
}

// How many per-question latency records are kept for later averaging.
const VOICE_TIMING_KEEP = 100;
const VOICE_TIMING_KEY = 'voiceTimings';

/**
 * A question has reached Telegram: keep its stage-by-stage timing, and show
 * the headline number on the pill so the delay is visible on every question.
 */
async function recordVoiceTiming(record, summary) {
  if (summary) flashLivePill(summary, 'confirmation', 3);
  try {
    const data = await chrome.storage.local.get(VOICE_TIMING_KEY);
    const all = [...(data[VOICE_TIMING_KEY] || []), record].slice(-VOICE_TIMING_KEEP);
    await chrome.storage.local.set({ [VOICE_TIMING_KEY]: all });
  } catch (error) {
    log.native.warn('Could not store voice timing:', error.message);
  }
}

/**
 * Show a short message on the helper's status pill, if the helper is running.
 */
function flashLivePill(text, tone, seconds) {
  try {
    livePort?.postMessage({ cmd: 'notify', text, tone, ...(seconds ? { seconds } : {}) });
  } catch (error) {
    log.native.warn('Live text host notify failed:', error.message);
  }
}

/**
 * The chat tab the user is looking at, for shortcuts pressed outside any chat page.
 */
async function activeChatTabId() {
  const focused = await chrome.tabs.query({ url: CHAT_TAB_URLS, active: true, lastFocusedWindow: true });
  if (focused.length) return focused[0].id;
  // No chat in front (the shortcut was pressed from another app, or another
  // tab is showing). With many chats open, the right one is the chat that was
  // looked at last, not whichever happens to be listed first.
  const all = await chrome.tabs.query({ url: CHAT_TAB_URLS });
  if (!all.length) return null;
  return all.reduce((latest, tab) => ((tab.lastAccessed || 0) > (latest.lastAccessed || 0) ? tab : latest)).id;
}

/**
 * Say on the status pill which chat the words are going into. The receiving
 * chat is often not the tab in front, and the wrong chat filling up silently
 * is the failure the user cannot otherwise see.
 */
async function announceLiveChat(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const title = (tab.title || '').replace(/\s[-–|]\s*(Claude|Grok)\b.*$/i, '').trim() || 'chat';
    // With the source known, show the whole path: where the words come from and where they go.
    flashLivePill(liveSource ? `${liveSource} → ${title}` : `Typing into: ${title}`, 'confirmation', 3);
  } catch (error) {
    log.native.warn('Could not read live chat title:', error.message);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === liveTargetTabId) setLiveTarget(null);
  if (tabId === liveTabId) {
    liveTabId = null;
    stopLiveText();
  }
});

// Keyboard shortcut set in chrome://extensions/shortcuts (can be made global there).
chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'toggle-live-text') {
    toggleLiveText(await activeChatTabId());
  } else if (command === 'send-live-question') {
    sendLiveQuestion();
  }
});
