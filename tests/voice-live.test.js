import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersephone } from './helpers/load-content.js';

const CHAT_PAGE = `
  <div class="ProseMirror" data-testid="chat-input" contenteditable="true"></div>
  <button aria-label="Send message"></button>
`;

/**
 * Claude page with the voice module in live-text mode and a fake background
 * worker. The fake answers LIVE_TOGGLE the way the real one does: it tells
 * this tab that it is now (or no longer) receiving live text.
 */
const LIVE_OFF = { active: false, activeHere: false, targetHere: false, targetTabId: null };

function setup(t, { hostAvailable = true, boxText = '', liveSetting = true, stateOnLoad = LIVE_OFF } = {}) {
  const sent = [];
  const toasts = [];
  let page;
  let active = false;
  const chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        if (message.type === 'LIVE_TOGGLE') {
          if (!hostAvailable) return Promise.resolve({ success: false, error: 'host_unavailable' });
          active = !active;
          page.P.setLiveActive(active);
          return Promise.resolve({ success: true, active });
        }
        if (message.type === 'LIVE_HERE') {
          if (!hostAvailable) return Promise.resolve({ success: false, error: 'host_unavailable' });
          active = !active;
          page.P.setLiveActive(active);
          page.P.handleLiveState({ active, activeHere: active, targetHere: true, targetTabId: 7 });
          return Promise.resolve({ success: true, active });
        }
        if (message.type === 'LIVE_GET_STATE') return Promise.resolve(stateOnLoad);
        return Promise.resolve({ success: true });
      },
    },
  };

  page = loadPersephone(CHAT_PAGE, { extraFiles: ['content/voice.js'], globals: { chrome } });
  const { window, document, P } = page;
  // The box check runs on a timer; closing the page stops it so the test run can finish.
  t.after(() => window.close());
  // JSDOM does no layout; give elements a size so the chat input counts as visible.
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40 });
  P.isContextValid = () => true;
  P.showToast = (message) => toasts.push(message);
  P.state.voiceLiveCaptions = liveSetting;
  P.state.autoSubmitVoice = true;   // must make no difference: live text never sends
  P.injectMicButton();

  const input = document.querySelector('[data-testid="chat-input"]');
  if (boxText) input.innerHTML = `<p>${boxText}</p>`;
  let sendClicks = 0;
  document.querySelector('button[aria-label="Send message"]').addEventListener('click', () => { sendClicks++; });

  return {
    P, sent, toasts, input,
    types: () => sent.map((m) => m.type),
    count: (type) => sent.filter((m) => m.type === type).length,
    sendClicks: () => sendClicks,
    // What claude.ai does when the user presses Enter: the box empties.
    userPressesEnter: () => { input.innerHTML = ''; },
    micButton: document.querySelector('.persephone-mic-btn'),
    // The live button is added on demand so the other tests see exactly the messages they always did.
    addLiveButton: async () => {
      P.injectLiveButton();
      await new Promise((resolve) => setTimeout(resolve, 0));   // its state request on load
      return document.querySelector('.persephone-live-btn');
    },
  };
}

test('mic button switches live text on instead of starting MacWhisper dictation', async (t) => {
  const { P, types, micButton } = setup(t);
  await P.handleMicClick();

  assert.deepEqual(types(), ['LIVE_TOGGLE']);
  assert.equal(P.state.micRecording, true);
  assert.ok(micButton.classList.contains('recording'));
});

test('mic button again switches live text off', async (t) => {
  const { P, micButton } = setup(t);
  await P.handleMicClick();
  await P.handleMicClick();

  assert.equal(P.state.micRecording, false);
  assert.ok(!micButton.classList.contains('recording'));
});

test('words land in the chat box as they are spoken', async (t) => {
  const { P, input } = setup(t);
  await P.handleMicClick();

  P.handleLiveText('What is the');
  assert.equal(input.textContent, 'What is the');
  P.handleLiveText('What is the difference between a left join');
  assert.equal(input.textContent, 'What is the difference between a left join');
});

test('a corrected guess replaces the text instead of being added to it', async (t) => {
  const { P, input } = setup(t);
  await P.handleMicClick();

  P.handleLiveText('What decide m potent mean');
  P.handleLiveText('What does idempotent mean');
  assert.equal(input.textContent, 'What does idempotent mean');
});

test('nothing is ever sent: the question waits in the box for Enter', async (t) => {
  const { P, input, sendClicks, types } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('How would you roll back a bad deployment on Kubernetes?');
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(sendClicks(), 0);
  assert.equal(input.textContent, 'How would you roll back a bad deployment on Kubernetes?');
  assert.ok(!types().includes('BROADCAST_QUESTION'));
  assert.ok(!types().includes('TOGGLE_WHISPER'));
});

test('after the user presses Enter the next words start a fresh question', async (t) => {
  const { P, input, count, userPressesEnter } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What does idempotent mean?');

  userPressesEnter();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(count('LIVE_MARK'), 1, 'the helper is told to forget the question that was sent');

  // The helper answers the mark with an empty question, then streams the new one.
  P.handleLiveText('');
  P.handleLiveText('Why would you');
  assert.equal(input.textContent, 'Why would you');
  assert.equal(count('LIVE_MARK'), 1);
});

test('a word the user fixes stays fixed, and what is said next is added after it', async (t) => {
  const { P, input, count } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What does it impotent mean');

  input.innerHTML = '<p>What does idempotent mean</p>';   // the user fixes a word
  P.handleLiveText('What does it impotent mean and why');   // the helper has not heard about the fix yet
  assert.equal(input.textContent, 'What does idempotent mean');
  assert.equal(count('LIVE_MARK'), 1, 'the helper is told to count only what is said from now on');

  P.handleLiveText('');                                      // the helper confirms
  P.handleLiveText('and why does it matter');
  assert.equal(input.textContent, 'What does idempotent mean and why does it matter');
  P.handleLiveText('and why does it matter for retries?');
  assert.equal(input.textContent, 'What does idempotent mean and why does it matter for retries?');
});

test('the user can type in front of the live words while they keep coming', async (t) => {
  const { P, input, count } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What is the');

  const typeAtStart = (text) => { const node = input.querySelector('p').firstChild; node.data = text + node.data; };
  typeAtStart('Answer briefly: ');
  P.handleLiveText('What is the difference between');
  assert.equal(input.textContent, 'Answer briefly: What is the difference between');
  P.handleLiveText('What is the difference between a left join and an inner join?');
  assert.equal(input.textContent, 'Answer briefly: What is the difference between a left join and an inner join?');
  assert.equal(count('LIVE_MARK'), 0, 'typing in front of the live words is not a new question');
});

test('the caret stays where the user put it while words keep arriving', async (t) => {
  const { P, input } = setup(t);
  const window = input.ownerDocument.defaultView;
  await P.handleMicClick();
  P.handleLiveText('What is the difference');

  const selection = window.getSelection();
  selection.collapse(input.querySelector('p').firstChild, 4);   // the user clicks after "What"
  P.handleLiveText('What is the difference between a left join');
  P.handleLiveText('What is the difference between a left join and an inner join?');

  assert.equal(input.textContent, 'What is the difference between a left join and an inner join?');
  assert.ok(input.contains(selection.anchorNode));
  assert.equal(selection.anchorOffset, 4);
  assert.equal(selection.isCollapsed, true);
});

test('a caret resting at the end keeps following the end', async (t) => {
  const { P, input } = setup(t);
  const window = input.ownerDocument.defaultView;
  await P.handleMicClick();
  P.handleLiveText('What is the');

  const selection = window.getSelection();
  selection.collapse(input.querySelector('p').firstChild, 'What is the'.length);
  P.handleLiveText('What is the difference');

  assert.equal(selection.anchorOffset, 'What is the difference'.length);
});

test('text the user has selected elsewhere on the page stays selected', async (t) => {
  const { P, input } = setup(t);
  const document = input.ownerDocument;
  const window = document.defaultView;
  const answer = document.createElement('p');
  answer.textContent = 'An earlier answer the user is copying from.';
  document.body.appendChild(answer);
  await P.handleMicClick();
  P.handleLiveText('What is the');

  const selection = window.getSelection();
  selection.selectAllChildren(answer);
  P.handleLiveText('What is the difference');

  assert.equal(input.textContent, 'What is the difference');
  assert.equal(selection.toString(), 'An earlier answer the user is copying from.');
});

test('the helper starting over never deletes what is in the box', async (t) => {
  const { P, input } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What is overfitting');

  P.handleLiveText('');                       // e.g. the helper was restarted
  assert.equal(input.textContent, 'What is overfitting');
  P.handleLiveText('and how do you prevent it?');
  assert.equal(input.textContent, 'What is overfitting and how do you prevent it?');
});

test('live text resumes after an edited question is sent', async (t) => {
  const { P, input, count, userPressesEnter } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What does it impotent mean');
  input.innerHTML = '<p>What does idempotent mean</p>';
  P.handleLiveText('What does it impotent mean and');

  userPressesEnter();
  P.handleLiveText('What does it impotent mean and why');   // still the old question, until the mark lands
  assert.equal(count('LIVE_MARK'), 2, 'one fresh start when the word was fixed, one when it was sent');
  P.handleLiveText('');
  P.handleLiveText('Next question');
  assert.equal(input.textContent, 'Next question');
});

test('text already typed in the box is kept, and the live words go after it', async (t) => {
  const { P, input } = setup(t, { boxText: 'my own draft' });
  await P.handleMicClick();

  P.handleLiveText('someone talking');
  assert.equal(input.textContent, 'my own draft someone talking');
  P.handleLiveText('someone talking about joins');
  assert.equal(input.textContent, 'my own draft someone talking about joins');
});

test('words arriving while live text is off do not touch the chat box', (t) => {
  const { P, input } = setup(t);
  P.handleLiveText('someone talking between questions');
  assert.equal(input.textContent, '');
});

test('missing helper leaves the button idle and says how to fix it', async (t) => {
  const { P, toasts, micButton } = setup(t, { hostAvailable: false });
  await P.handleMicClick();

  assert.equal(P.state.micRecording, false);
  assert.ok(!micButton.classList.contains('recording'));
  assert.match(toasts.at(-1), /install/i);
});

test('the helper starting Live Captions by itself is not reported as a problem', async (t) => {
  const { P, toasts } = setup(t);
  await P.handleMicClick();
  P.handleLiveStatus('captions_starting');
  P.handleLiveStatus('ready');

  assert.equal(toasts.length, 0);
});

test('Live Captions that could not be started is reported while live text is on', async (t) => {
  const { P, toasts } = setup(t);
  await P.handleMicClick();
  P.handleLiveStatus('captions_off');

  assert.match(toasts.at(-1), /Could not start Live Captions/);
});

test('mic button lights up in other tabs while live text runs elsewhere', (t) => {
  const { P, micButton } = setup(t);
  P.handleLiveState({ active: true, activeHere: false, targetTabId: 7 });
  assert.ok(micButton.classList.contains('recording'));
  assert.equal(P.state.micRecording, false, 'this tab is not the one receiving text');

  P.handleLiveState({ active: false, activeHere: false, targetTabId: 7 });
  assert.ok(!micButton.classList.contains('recording'));
});

test('the send shortcut presses send on the question in the box', async (t) => {
  const { P, sendClicks } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What is overfitting and how do you prevent it?');

  const result = P.submitLiveQuestion();

  assert.equal(result.success, true);
  assert.equal(sendClicks(), 1);
});

test('the send shortcut does nothing when the box is empty', async (t) => {
  const { P, sendClicks, toasts } = setup(t);
  await P.handleMicClick();

  const result = P.submitLiveQuestion();

  assert.equal(result.success, false);
  assert.equal(sendClicks(), 0);
  assert.match(toasts.at(-1), /nothing/i);
});

test('a send is noticed the moment the box empties, without waiting for a timer', async (t) => {
  // In a tab that is not in front Chrome holds timers back, so the fresh
  // question must not depend on one.
  const { P, count, userPressesEnter } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('Why would you choose Kafka?');

  userPressesEnter();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(count('LIVE_MARK'), 1);
});

test('live text started by the shortcut fills the box even with the Live text setting off', (t) => {
  // The global shortcut does not go through the settings switch. Words the
  // user explicitly asked for must not be thrown away because of it.
  const { P, input } = setup(t, { liveSetting: false });
  P.setLiveActive(true);            // what the background sends when the shortcut is pressed
  P.handleLiveText('and switching in the thread for larger more complex tasks.');

  assert.equal(input.textContent, 'and switching in the thread for larger more complex tasks.');
});

test('while live text is running, the mic button controls it whatever the setting says', async (t) => {
  const { P, types } = setup(t, { liveSetting: false });
  P.setLiveActive(true);
  P.handleLiveState({ active: true, activeHere: true, targetTabId: null });

  await P.handleMicClick();

  assert.deepEqual(types(), ['LIVE_TOGGLE']);
  assert.ok(!types().includes('TOGGLE_WHISPER'), 'it must not start a MacWhisper dictation on top of live text');
});

test('with live text off and the setting off, the mic button still starts dictation', async (t) => {
  const { P, types } = setup(t, { liveSetting: false });
  await P.handleMicClick();

  assert.deepEqual(types(), ['TOGGLE_WHISPER']);
});

test('being told twice that this tab is receiving does not disturb a question in progress', (t) => {
  // Happens when the background worker restarts and picks live text up again.
  const { P, input } = setup(t);
  P.setLiveActive(true);
  P.handleLiveText('What is the difference');
  P.setLiveActive(true);
  P.handleLiveText('What is the difference between a left join');

  assert.equal(input.textContent, 'What is the difference between a left join');
});

test('the send shortcut starts the latency record with the clock readings it was given', async (t) => {
  const { P } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What is overfitting?');
  const pressedAt = Date.now() - 40;

  P.submitLiveQuestion({ pressedAt, lastTextAt: pressedAt - 1200 });

  assert.equal(P.state.voiceTiming.mode, 'live');
  assert.equal(P.state.voiceTiming.pressedAt, pressedAt);
  assert.equal(P.state.voiceTiming.lastTextAt, pressedAt - 1200);
  assert.ok(P.state.voiceTiming.submittedAt >= pressedAt);
});

test('the box emptying after a shortcut send is not counted as a second send', async (t) => {
  const { P, userPressesEnter } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('What is overfitting?');
  const pressedAt = Date.now() - 40;
  P.submitLiveQuestion({ pressedAt, lastTextAt: pressedAt - 1200 });

  userPressesEnter();                       // claude.ai empties the box after the send
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(P.state.voiceTiming.pressedAt, pressedAt, 'the record from the key press is kept');
});

test('pressing Enter in the tab starts a latency record too', async (t) => {
  const { P, userPressesEnter } = setup(t);
  await P.handleMicClick();
  P.handleLiveText('Why would you choose Kafka?');

  userPressesEnter();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(P.state.voiceTiming.mode, 'live');
  assert.equal(P.state.voiceTiming.pressedAt, null);
  assert.equal(typeof P.state.voiceTiming.lastTextAt, 'number');
});

// --- The live button on the page ---

test('one click on the live button puts live text into this chat, without the Live text setting', async (t) => {
  const { P, count, addLiveButton } = setup(t, { liveSetting: false });
  const button = await addLiveButton();
  await P.liveTextHere();

  assert.equal(count('LIVE_HERE'), 1);
  assert.equal(count('TOGGLE_WHISPER'), 0, 'it never starts MacWhisper dictation');
  assert.ok(button.classList.contains('live'));
  P.handleLiveText('What is overfitting?');
  assert.equal(P.getInputValue(P.findChatInput()).trim(), 'What is overfitting?');
});

test('a second click on the live button switches live text off', async (t) => {
  const { P, addLiveButton } = setup(t);
  const button = await addLiveButton();
  await P.liveTextHere();
  await P.liveTextHere();

  assert.ok(!button.classList.contains('live'));
  assert.ok(button.classList.contains('target'), 'still the chosen chat');
});

test('the live button never sends: the question waits for the user', async (t) => {
  const { P, sendClicks, addLiveButton } = setup(t);
  await addLiveButton();
  await P.liveTextHere();
  P.handleLiveText('What is overfitting?');
  await P.liveTextHere();

  assert.equal(sendClicks(), 0);
});

test('the live button shows when live text is typing into another chat', async (t) => {
  const { P, addLiveButton } = setup(t);
  const button = await addLiveButton();
  P.handleLiveState({ active: true, activeHere: false, targetHere: false, targetTabId: 9 });

  assert.ok(button.classList.contains('elsewhere'));
  assert.ok(!button.classList.contains('live'));
  assert.match(button.title, /another chat/);
});

test('the live button shows that this is the chosen chat while live text is off', async (t) => {
  const { addLiveButton } = setup(t, { stateOnLoad: { active: false, activeHere: false, targetHere: true, targetTabId: 7 } });
  const button = await addLiveButton();

  assert.ok(button.classList.contains('target'));
  assert.ok(!button.classList.contains('live'));
});

test('a chat refreshed while it is receiving carries on receiving', async (t) => {
  const { P, addLiveButton } = setup(t, { stateOnLoad: { active: true, activeHere: true, targetHere: true, targetTabId: 7 } });
  const button = await addLiveButton();

  assert.ok(button.classList.contains('live'));
  P.handleLiveText('How would you roll back a bad deployment?');
  assert.equal(P.getInputValue(P.findChatInput()).trim(), 'How would you roll back a bad deployment?');
});

test('a missing helper leaves the live button idle and says how to fix it', async (t) => {
  const { P, toasts, addLiveButton } = setup(t, { hostAvailable: false });
  const button = await addLiveButton();
  await P.liveTextHere();

  assert.ok(!button.classList.contains('live'));
  assert.equal(toasts.length, 1);
});

test('a caret at the end of the user\'s own text stays there when live words are added after it', async (t) => {
  const { P, input } = setup(t, { boxText: 'Answer in one line:' });
  const window = input.ownerDocument.defaultView;
  await P.handleMicClick();

  const selection = window.getSelection();
  selection.collapse(input.querySelector('p').firstChild, 'Answer in one line:'.length);   // still typing here
  P.handleLiveText('What is overfitting?');

  assert.equal(input.textContent, 'Answer in one line: What is overfitting?');
  assert.equal(selection.anchorOffset, 'Answer in one line:'.length);
});
