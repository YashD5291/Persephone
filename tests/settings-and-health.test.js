import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersephone } from './helpers/load-content.js';

/**
 * Page with the settings module loaded; `stored` is what chrome.storage.sync
 * holds. `saved` collects what the page writes back, `calls` counts how often
 * the send buttons were put on the page or taken off it.
 */
function loadWidgetPage(t, stored) {
  const saved = [];
  const calls = { scanAllResponses: 0, removeAllButtons: 0 };
  const chrome = {
    storage: { sync: { get: async () => ({ ...stored }), set: (values) => { saved.push(values); } } },
    runtime: { sendMessage: async () => ({ hasOverride: false, tabs: [] }) },
  };
  const { window, document, P } = loadPersephone('', {
    extraFiles: ['content/widget.js'],
    globals: { chrome },
    prepare: (page) => Object.assign(page, {
      isContextValid: () => true,
      showToast: () => {},
      scanAllResponses: () => { calls.scanAllResponses++; },
      removeAllButtons: () => { calls.removeAllButtons++; },
    }),
  });
  t.after(() => window.close());
  return { window, document, P, saved, calls };
}

const loadSettingsPage = (t, stored) => loadWidgetPage(t, stored).P;

test('settings load when the skip keywords were never changed', async (t) => {
  // The usual case: nothing saved for skip keywords. This used to throw on the
  // default keywords and leave every later setting at its default.
  const P = loadSettingsPage(t, { autoSubmitVoice: true, voiceAutoRestart: true, voiceLiveCaptions: true, firstChunkWordLimit: 30 });
  await P.loadSettings();

  assert.deepEqual([...P.state.autoSendSkipKeywords], ['short', 'shorter', 'shrt', 'shrtr', 'shrter']);
  assert.equal(P.state.autoSubmitVoice, true);
  assert.equal(P.state.voiceAutoRestart, true);
  assert.equal(P.state.voiceLiveCaptions, true);
  assert.equal(P.state.firstChunkWordLimit, 30);
});

test('saved skip keywords are used as saved', async (t) => {
  const P = loadSettingsPage(t, { autoSendSkipKeywords: ['brief'] });
  await P.loadSettings();

  assert.deepEqual([...P.state.autoSendSkipKeywords], ['brief']);
});

// --- The extension's on/off switch on the page itself ---

/** What a click on a switch does: flip it and tell its listeners. */
function click(window, checkbox) {
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('the outside switch shows the saved state and switches the extension off with one click', async (t) => {
  const { window, document, P, saved, calls } = loadWidgetPage(t, { extensionEnabled: true });
  P.injectExtensionSwitch();
  await P.loadSettings();
  const control = document.querySelector('.persephone-ext-switch');
  const checkbox = control.querySelector('input');
  assert.equal(checkbox.checked, true);
  assert.match(control.title, /is on/);

  click(window, checkbox);

  assert.equal(P.state.extensionEnabled, false);
  assert.deepEqual(saved.map((values) => ({ ...values })), [{ extensionEnabled: false }]);
  assert.equal(calls.removeAllButtons, 1, 'the send buttons leave the page');
  assert.match(control.title, /is off/);
});

test('the outside switch switches the extension back on', async (t) => {
  const { window, document, P, saved, calls } = loadWidgetPage(t, { extensionEnabled: false });
  P.injectExtensionSwitch();
  await P.loadSettings();
  const checkbox = document.querySelector('.persephone-ext-switch input');
  assert.equal(checkbox.checked, false, 'a saved "off" is shown as off');

  click(window, checkbox);

  assert.equal(P.state.extensionEnabled, true);
  assert.deepEqual(saved.map((values) => ({ ...values })), [{ extensionEnabled: true }]);
  assert.equal(calls.scanAllResponses, 1, 'the send buttons come back');
});

test('the outside switch follows a change made in the popup, another tab or by the shortcut', async (t) => {
  const { document, P } = loadWidgetPage(t, { extensionEnabled: true });
  P.injectExtensionSwitch();
  await P.loadSettings();
  const checkbox = document.querySelector('.persephone-ext-switch input');

  P.state.extensionEnabled = false;   // what the storage listener does when another context changes it
  P.updateWidgetStates();
  assert.equal(checkbox.checked, false);

  P.toggleExtensionEnabled();         // Cmd+Shift+E
  assert.equal(checkbox.checked, true);
});

test('the outside switch and the switch in the panel never disagree', async (t) => {
  const { window, document, P } = loadWidgetPage(t, { extensionEnabled: true });
  P.injectSettingsWidget();
  P.injectExtensionSwitch();
  await P.loadSettings();
  document.querySelector('.persephone-gear-btn').click();   // open the panel
  const outside = document.querySelector('.persephone-ext-switch input');
  const inPanel = document.querySelector('.persephone-settings-panel [data-key="extensionEnabled"]');

  click(window, inPanel);
  assert.equal(outside.checked, false);
  assert.equal(P.state.extensionEnabled, false);

  click(window, outside);
  assert.equal(inPanel.checked, true);
  assert.equal(P.state.extensionEnabled, true);
});

const ANSWER_WITHOUT_STREAMING_ATTRIBUTE = '<div data-testid="assistant-message"><div class="standard-markdown"><p>An answer</p></div></div>';
const ANSWER_AS_CLAUDE_RENDERS_IT = '<div data-is-streaming="false" data-testid="assistant-message"><div class="standard-markdown"><p>An answer</p></div></div>';
const MARKDOWN_BEFORE_ANY_ANSWER_ROW = '<div><div class="standard-markdown"><p>Text shown while the first answer is still on its way</p></div></div>';

test('health check passes on a Claude page as it is rendered today', (t) => {
  const { window, P } = loadPersephone(ANSWER_AS_CLAUDE_RENDERS_IT);
  t.after(() => window.close());
  const container = P.runSelectorHealthCheck().results.find((c) => c.name === 'responseContainer');

  assert.equal(container.ok, true);
  assert.equal(container.count, 1);
});

test('health check flags answers the extension can no longer find', (t) => {
  // If Claude drops the attribute the extension keys on, answers are on the
  // page but invisible to it. That must be reported as critical.
  const { window, P } = loadPersephone(ANSWER_WITHOUT_STREAMING_ATTRIBUTE);
  t.after(() => window.close());
  const container = P.runSelectorHealthCheck().results.find((c) => c.name === 'responseContainer');

  assert.equal(container.ok, false);
  assert.equal(container.critical, true);
});

test('an empty chat is not reported as a broken page', (t) => {
  const { window, P } = loadPersephone('<div class="ProseMirror" contenteditable="true"></div>');
  t.after(() => window.close());
  const container = P.runSelectorHealthCheck().results.find((c) => c.name === 'responseContainer');

  assert.equal(container.ok, true);
  assert.equal(container.critical, false);
});

test('health check stays quiet when markdown is on the page but no answer row is yet', (t) => {
  // Reported as "Critical selector failures: responseContainer" on pages where nothing was wrong.
  const { window, P } = loadPersephone(MARKDOWN_BEFORE_ANY_ANSWER_ROW);
  t.after(() => window.close());
  const container = P.runSelectorHealthCheck().results.find((c) => c.name === 'responseContainer');

  assert.equal(container.ok, true);
  assert.equal(container.critical, false);
});
