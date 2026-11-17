import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Loads the background live-text module against a fake Chrome.
 * `openTabs` are chat tabs that answer messages; any other tab id is "closed".
 */
function setup({ openTabs = [1, 2, 3], hostInstalled = true, storedTarget = null, frontTabId, sessionTabId = null } = {}) {
  const tabMessages = [];          // [tabId, message]
  const hostMessages = [];         // commands posted to the native host
  const listeners = {};
  const port = {
    postMessage: (m) => hostMessages.push(m),
    disconnect: () => { port.disconnected = true; },
    onMessage: { addListener: (fn) => { listeners.hostMessage = fn; } },
    onDisconnect: { addListener: (fn) => { listeners.hostDisconnect = fn; } },
  };
  const stored = { liveTargetTabId: storedTarget };
  const session = sessionTabId == null ? {} : { liveActiveTabId: sessionTabId };
  let connects = 0;
  // Tabs may be given as ids or as { id, title, lastAccessed }.
  const tabInfo = new Map(openTabs.map((tab) => (typeof tab === 'number' ? [tab, { id: tab }] : [tab.id, tab])));
  const open = { has: (id) => tabInfo.has(id), delete: (id) => tabInfo.delete(id) };
  // The chat tab in front of the user; null = some other tab or app is in front.
  const front = frontTabId === undefined ? [...tabInfo.keys()][0] : frontTabId;

  const chrome = {
    runtime: {
      lastError: null,
      connectNative: () => {
        if (!hostInstalled) throw new Error('Specified native messaging host not found.');
        connects++;
        return port;
      },
    },
    tabs: {
      sendMessage: (tabId, message) => {
        if (!open.has(tabId)) return Promise.reject(new Error('Receiving end does not exist.'));
        tabMessages.push([tabId, message]);
        return Promise.resolve({ success: true });
      },
      query: (filter, callback) => {
        const tabs = [...tabInfo.values()];
        const result = filter.active ? tabs.filter((tab) => tab.id === front) : tabs;
        if (callback) { callback(result); return undefined; }
        return Promise.resolve(result);
      },
      get: (tabId) => (tabInfo.has(tabId) ? Promise.resolve(tabInfo.get(tabId)) : Promise.reject(new Error('No tab with id'))),
      onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
    },
    storage: {
      local: { get: async () => ({ ...stored }), set: (values) => Object.assign(stored, values) },
      session: {
        get: async () => ({ ...session }),
        set: (values) => Object.assign(session, values),
        remove: (key) => { delete session[key]; },
      },
    },
    commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
  };
  const quiet = () => {};
  const log = { native: Object.assign(quiet, { warn: quiet, error: quiet }) };

  // Long timers (idle disconnect, the announce fallback) are held here and fired by the
  // test when it wants them, so nothing waits seconds or holds the test run open.
  // Short ones (the wait for the last words) run for real.
  const heldTimers = [];
  const backgroundTimeout = (fn, ms) => {
    if (ms < 1000) return setTimeout(fn, ms);
    const held = { fn, ms, done: false };
    heldTimers.push(held);
    return held;
  };
  const backgroundClear = (timer) => { if (heldTimers.includes(timer)) timer.done = true; else clearTimeout(timer); };
  const fireTimers = (upToMs) => heldTimers.filter((x) => !x.done && x.ms <= upToMs).forEach((x) => { x.done = true; x.fn(); });
  const context = vm.createContext({ chrome, log, setTimeout: backgroundTimeout, clearTimeout: backgroundClear, console });
  for (const file of ['background/constants.js', 'background/live.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }

  const sentTo = (tabId, type) => tabMessages.filter(([id, m]) => id === tabId && m.type === type).map(([, m]) => m);
  return {
    bg: context, tabMessages, hostMessages, listeners, stored, session, open, port, sentTo, fireTimers,
    connects: () => connects,
    notices: () => hostMessages.filter((m) => m.cmd === 'notify').map((m) => m.text),
    activations: () => tabMessages.filter(([, m]) => m.type === 'LIVE_SET_ACTIVE').map(([id, m]) => [id, m.active]),
    hostSays: (message) => listeners.hostMessage(message),
  };
}

test('with no chosen chat, live text goes to the tab where the mic was pressed', async () => {
  const { bg, activations, hostMessages } = setup();
  const result = await bg.toggleLiveText(2);

  assert.equal(result.success, true);
  assert.deepEqual(activations(), [[2, true]]);
  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark']);
});

test('with a chosen chat, live text goes there whichever tab the mic was pressed in', async () => {
  const { bg, activations } = setup();
  bg.setLiveTarget(3);
  await bg.toggleLiveText(1);

  assert.deepEqual(activations(), [[3, true]]);
});

test('the words are forwarded only to the receiving chat', async () => {
  const { bg, hostSays, sentTo } = setup();
  bg.setLiveTarget(3);
  await bg.toggleLiveText(1);
  hostSays({ type: 'text', text: 'What is the difference' });

  assert.deepEqual(sentTo(3, 'LIVE_TEXT').map((m) => m.text), ['What is the difference']);
  assert.equal(sentTo(1, 'LIVE_TEXT').length, 0);
  assert.equal(sentTo(2, 'LIVE_TEXT').length, 0);
});

test('pressing the mic again switches live text off and pauses the helper', async () => {
  const { bg, activations, hostMessages, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  const result = await bg.toggleLiveText(2);

  assert.equal(result.active, false);
  assert.deepEqual(activations(), [[2, true], [2, false]]);
  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark', 'pause']);

  hostSays({ type: 'text', text: 'late words' });
  assert.equal(sentTo(2, 'LIVE_TEXT').length, 0);
});

test('a chosen chat that was closed falls back to the pressing tab and is forgotten', async () => {
  const { bg, activations, stored } = setup({ openTabs: [1, 2] });
  bg.setLiveTarget(9);
  const result = await bg.toggleLiveText(1);

  assert.equal(result.success, true);
  assert.deepEqual(activations(), [[1, true]]);
  assert.equal(stored.liveTargetTabId, null);
});

test('choosing another chat while live text is on moves the words there', async () => {
  const { bg, activations, hostMessages, hostSays, sentTo } = setup();
  await bg.toggleLiveText(1);
  bg.setLiveTarget(3);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(activations(), [[1, true], [3, true], [1, false]]);
  // The new chat starts with a clean question, not the words meant for the old one.
  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark', 'mark']);
  hostSays({ type: 'text', text: 'for the new chat' });
  assert.equal(sentTo(3, 'LIVE_TEXT').length, 1);
  assert.equal(sentTo(1, 'LIVE_TEXT').length, 0);
});

test('the chosen chat is remembered across a background restart', async () => {
  const { bg, activations } = setup({ storedTarget: 2 });
  await bg.loadLiveTarget();
  await bg.toggleLiveText(1);

  assert.deepEqual(activations(), [[2, true]]);
});

test('closing the receiving chat switches live text off', async () => {
  const { bg, listeners, hostMessages, open } = setup();
  await bg.toggleLiveText(2);
  open.delete(2);
  listeners.tabRemoved(2);

  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark', 'pause']);
  const again = await bg.toggleLiveText(1);
  assert.equal(again.active, true, 'the next press starts it again rather than "stopping" a dead session');
});

test('missing helper reports failure and leaves the tab switched off', async () => {
  const { bg, activations } = setup({ hostInstalled: false });
  const result = await bg.toggleLiveText(1);

  assert.equal(result.success, false);
  assert.equal(result.error, 'host_unavailable');
  assert.deepEqual(activations(), [[1, true], [1, false]]);
});

test('a helper that dies mid-call is started again without the user doing anything', async () => {
  const { bg, listeners, hostMessages, activations, connects, hostSays, sentTo } = setup();
  await bg.toggleLiveText(1);
  listeners.hostDisconnect();

  assert.equal(connects(), 2, 'a new helper was started');
  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark', 'mark']);
  assert.deepEqual(activations(), [[1, true]], 'the chat was never switched off');

  hostSays({ type: 'text', text: 'words after the restart' });
  assert.equal(sentTo(1, 'LIVE_TEXT').at(-1).text, 'words after the restart');
});

test('a helper that keeps dying is given up on, and the chat is told why', async () => {
  const { bg, listeners, sentTo, activations, connects } = setup();
  await bg.toggleLiveText(1);
  for (let i = 0; i < 4; i++) listeners.hostDisconnect();

  assert.equal(connects(), 4, 'one start plus three restarts, then no more');
  assert.equal(sentTo(1, 'LIVE_STATUS').at(-1).state, 'host_unavailable');
  assert.deepEqual(activations().at(-1), [1, false]);
});

test('switching live text off and on again allows restarts afresh', async () => {
  const { bg, listeners, connects } = setup();
  await bg.toggleLiveText(1);
  for (let i = 0; i < 3; i++) listeners.hostDisconnect();
  await bg.toggleLiveText(1);     // off
  await bg.toggleLiveText(1);     // on
  const before = connects();
  listeners.hostDisconnect();

  assert.equal(connects(), before + 1);
});

test('live text survives a restart of the background worker', async () => {
  // Chrome can stop and restart an extension's background worker at any time.
  const { bg, activations, hostMessages, session } = setup({ sessionTabId: 2 });
  await bg.restoreLiveText();

  assert.deepEqual(activations(), [[2, true]]);
  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark']);
  assert.equal(session.liveActiveTabId, 2);
});

test('switching live text off is remembered too, so a restart does not switch it back on', async () => {
  const { bg, session } = setup();
  await bg.toggleLiveText(2);
  assert.equal(session.liveActiveTabId, 2);
  await bg.toggleLiveText(2);
  assert.equal(session.liveActiveTabId, undefined);
});

test('every chat tab is told when live text starts, so all mic buttons agree', async () => {
  const { bg, sentTo } = setup();
  await bg.toggleLiveText(2);

  assert.equal(sentTo(1, 'LIVE_STATE').at(-1).active, true);
  assert.equal(sentTo(1, 'LIVE_STATE').at(-1).activeHere, false);
  assert.equal(sentTo(2, 'LIVE_STATE').at(-1).activeHere, true);
});

test('keyboard shortcut toggles live text for the chat in front', async () => {
  const { listeners, activations } = setup();
  await listeners.command('toggle-live-text');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(activations(), [[1, true]]);
});

test('send shortcut presses send in the chat holding the question, whatever tab is in front', async () => {
  const { bg, listeners, sentTo } = setup();
  bg.setLiveTarget(3);
  await bg.toggleLiveText(1);

  await listeners.command('send-live-question');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sentTo(3, 'LIVE_SUBMIT').length, 1);
  assert.equal(sentTo(1, 'LIVE_SUBMIT').length, 0);
  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 0);
});

test('a send from the shortcut is confirmed on the on-screen pill', async () => {
  const { bg, hostMessages } = setup();
  await bg.toggleLiveText(2);
  await bg.sendLiveQuestion();

  const notice = hostMessages.filter((m) => m.cmd === 'notify').at(-1);
  assert.equal(notice.text, 'Sent');
  assert.equal(notice.tone, 'confirmation');
});

test('send waits for the last words when they are still arriving', async () => {
  const { bg, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  hostSays({ type: 'text', text: 'What is the difference between a left join and an inner' });

  const sending = bg.sendLiveQuestion();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 0, 'held back: a word arrived 100 ms ago');
  hostSays({ type: 'text', text: 'What is the difference between a left join and an inner join?' });

  await sending;
  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 1);
  const lastText = sentTo(2, 'LIVE_TEXT').at(-1).text;
  assert.match(lastText, /inner join\?$/, 'the final word reached the chat before send was pressed');
});

test('send waits out a caption step that brought no change', async () => {
  // Seen on a real run: the captions stood still for 0.6 s in the middle of a
  // sentence, send was pressed in that gap, and the question went out cut short.
  const { bg, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  hostSays({ type: 'text', text: 'How would you design a data pipeline that handles' });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const sending = bg.sendLiveQuestion();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 0, 'held back: the captions may only have skipped a step');
  hostSays({ type: 'text', text: 'How would you design a data pipeline that handles late arriving events?' });

  await sending;
  assert.match(sentTo(2, 'LIVE_TEXT').at(-1).text, /late arriving events\?$/);
  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 1);
});

test('send goes at once when the captions have been still for a while', async () => {
  const { bg, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  hostSays({ type: 'text', text: 'What is overfitting?' });
  await new Promise((resolve) => setTimeout(resolve, 750));

  const started = Date.now();
  await bg.sendLiveQuestion();

  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 1);
  assert.ok(Date.now() - started < 100, `sent after ${Date.now() - started} ms`);
});

test('the helper confirming a fresh question is not taken for someone talking', async () => {
  // The user fixes a word (the helper answers the fresh start with an empty
  // text) and presses send straight away: there is nothing to wait for.
  const { bg, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  hostSays({ type: 'text', text: 'What is overfitting?' });
  await new Promise((resolve) => setTimeout(resolve, 750));
  hostSays({ type: 'text', text: '' });

  const started = Date.now();
  await bg.sendLiveQuestion();

  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 1);
  assert.ok(Date.now() - started < 100, `sent after ${Date.now() - started} ms`);
});

test('send never waits long, even if someone keeps talking', async () => {
  const { bg, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  const talking = setInterval(() => hostSays({ type: 'text', text: 'still talking ' + Date.now() }), 50);

  const started = Date.now();
  await bg.sendLiveQuestion();
  clearInterval(talking);

  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 1);
  assert.ok(Date.now() - started < 1500, `sent after ${Date.now() - started} ms`);
});

test('with live text off, send goes to the chosen chat straight away', async () => {
  const { bg, sentTo } = setup();
  bg.setLiveTarget(2);

  const started = Date.now();
  await bg.sendLiveQuestion();

  assert.equal(sentTo(2, 'LIVE_SUBMIT').length, 1);
  assert.ok(Date.now() - started < 100);
});

test('with no chat in front, the shortcut uses the chat that was looked at last', async () => {
  // Many chats open, shortcut pressed from another app: not simply the first tab found.
  const { listeners, activations } = setup({
    openTabs: [{ id: 1, lastAccessed: 100 }, { id: 2, lastAccessed: 300 }, { id: 3, lastAccessed: 200 }],
    frontTabId: null,
  });
  await listeners.command('toggle-live-text');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(activations(), [[2, true]]);
});

test('the chat in front wins over a more recently used one in the background', async () => {
  const { listeners, activations } = setup({
    openTabs: [{ id: 1, lastAccessed: 100 }, { id: 2, lastAccessed: 300 }],
    frontTabId: 1,
  });
  await listeners.command('toggle-live-text');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(activations(), [[1, true]]);
});

test('once captions are up the pill shows where the words come from and where they go', async () => {
  const { bg, hostSays, notices, sentTo } = setup({ openTabs: [{ id: 5, title: 'Handoff segment 1 - Claude' }] });
  await bg.toggleLiveText(5);
  hostSays({ type: 'status', state: 'ready' });
  hostSays({ type: 'status', state: 'ready', source: 'Loopback Audio' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(notices(), ['Loopback Audio → Handoff segment 1']);
  // The source report is extra information, not a second "ready" for the page.
  assert.equal(sentTo(5, 'LIVE_STATUS').length, 1);
});

test('if the source is never reported, the pill still names the receiving chat', async () => {
  const { bg, notices, fireTimers } = setup({ openTabs: [{ id: 5, title: 'Handoff segment 1 - Claude' }] });
  await bg.toggleLiveText(5);
  assert.deepEqual(notices(), []);
  fireTimers(4000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(notices(), ['Typing into: Handoff segment 1']);
});

test('the send shortcut passes on when it was pressed and when the last words arrived', async () => {
  const { bg, hostSays, sentTo } = setup();
  await bg.toggleLiveText(2);
  hostSays({ type: 'text', text: 'What is overfitting?' });
  await new Promise((resolve) => setTimeout(resolve, 300));   // the user reads, then presses

  const before = Date.now();
  await bg.sendLiveQuestion();
  const message = sentTo(2, 'LIVE_SUBMIT')[0];

  assert.ok(message.pressedAt >= before && message.pressedAt <= Date.now());
  assert.ok(before - message.lastTextAt >= 290, 'last words arrived about 300 ms before the press');
});

test('each question timing is kept, newest last, and its headline is shown on the pill', async () => {
  const { bg, stored, notices } = setup();
  await bg.toggleLiveText(1);
  await bg.recordVoiceTiming({ sendToTelegramMs: 2100 }, 'Telegram in 2.1 s (Claude 1.6 s)');
  await bg.recordVoiceTiming({ sendToTelegramMs: 1900 }, 'Telegram in 1.9 s (Claude 1.5 s)');

  assert.deepEqual(Array.from(stored.voiceTimings, (r) => r.sendToTelegramMs), [2100, 1900]);
  assert.equal(notices().at(-1), 'Telegram in 1.9 s (Claude 1.5 s)');
});

test('only the most recent timings are kept', async () => {
  const { bg, stored } = setup();
  for (let i = 0; i < 105; i++) await bg.recordVoiceTiming({ sendToTelegramMs: i }, null);

  assert.equal(stored.voiceTimings.length, 100);
  assert.equal(stored.voiceTimings.at(-1).sendToTelegramMs, 104);
  assert.equal(stored.voiceTimings[0].sendToTelegramMs, 5);
});

// --- The live button on a chat page ("live text into this chat") ---

test('the live button starts live text in its own chat and makes that chat the target', async () => {
  const { bg, activations, stored } = setup();
  bg.setLiveTarget(3);                       // another chat had been chosen before
  const result = await bg.liveTextHere(1);

  assert.equal(result.success, true);
  assert.deepEqual(activations(), [[1, true]]);
  assert.equal(stored.liveTargetTabId, 1);
});

test('the live button in the chat that is receiving switches live text off', async () => {
  const { bg, activations, hostMessages, stored } = setup();
  await bg.liveTextHere(2);
  const result = await bg.liveTextHere(2);

  assert.equal(result.active, false);
  assert.deepEqual(activations(), [[2, true], [2, false]]);
  assert.deepEqual(hostMessages.map((m) => m.cmd).filter((cmd) => cmd !== 'notify'), ['mark', 'pause']);
  assert.equal(stored.liveTargetTabId, 2, 'the chat stays the chosen one for next time');
});

test('the live button in another chat moves running live text there', async () => {
  const { bg, activations, hostSays, sentTo } = setup();
  await bg.liveTextHere(1);
  const result = await bg.liveTextHere(3);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.success, true);
  assert.deepEqual(activations(), [[1, true], [3, true], [1, false]]);
  hostSays({ type: 'text', text: 'What is overfitting?' });
  assert.equal(sentTo(3, 'LIVE_TEXT').length, 1);
  assert.equal(sentTo(1, 'LIVE_TEXT').length, 0);
});

test('each tab is told whether live text is typing into it and whether it is the chosen chat', async () => {
  const { bg } = setup();
  bg.setLiveTarget(3);
  assert.deepEqual({ ...bg.liveStateFor(3) }, { active: false, activeHere: false, targetHere: true, targetTabId: 3 });

  await bg.toggleLiveText(1);                // shortcut pressed elsewhere: words go to the chosen chat
  assert.deepEqual({ ...bg.liveStateFor(3) }, { active: true, activeHere: true, targetHere: true, targetTabId: 3 });
  assert.deepEqual({ ...bg.liveStateFor(1) }, { active: true, activeHere: false, targetHere: false, targetTabId: 3 });
});
