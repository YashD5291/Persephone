import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersephone } from './helpers/load-content.js';

const STREAMING_ANSWER = `
  <div data-is-streaming="true">
    <div class="font-claude-response"><div class="standard-markdown"></div></div>
  </div>
`;

/**
 * A Claude answer that is still being written, with the Telegram calls
 * recorded instead of sent. Each recorded call carries the time since the
 * stream was started.
 */
function setup(t, { streamEditReply = { success: true } } = {}) {
  const calls = [];
  const toBackground = [];
  const chrome = { runtime: { sendMessage: (message) => { toBackground.push(message); return Promise.resolve({ success: true }); } } };
  let startedAt = 0;
  const record = (kind, text) => calls.push({ kind, text, at: Math.round(performance.now() - startedAt) });

  const { window, document, P } = loadPersephone(STREAMING_ANSWER, {
    extraFiles: ['content/pacer.js', 'content/streaming.js'],
    globals: { chrome },
    prepare: (page) => Object.assign(page, {
      isContextValid: () => true,
      showToast: () => {},
      triggerPreconnect: () => {},
      processContainer: () => {},
      createActionButtonGroup: () => document.createElement('span'),
      sendToTelegram: async (text) => { record('send', text); return { success: true, messageId: 101, isMultiPart: false }; },
      // What the background answers to a progress edit: taken, or held back / refused.
      streamEditTelegram: async (id, text) => { record('stream-edit', text); return streamEditReply; },
      editInTelegram: async (id, text) => { record('final-edit', text); return true; },
    }),
  });
  t.after(() => window.close());

  const container = document.querySelector('[data-is-streaming]');
  const body = container.querySelector('.standard-markdown');
  const paragraph = document.createElement('p');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    P, calls, container, wait, toBackground,
    start: () => { startedAt = performance.now(); P.startLiveStream(container); },
    /** Claude writes (more of) the first paragraph. */
    write: (text) => { paragraph.textContent = text; if (!paragraph.isConnected) body.appendChild(paragraph); },
    /** Claude starts a second paragraph, which completes the first. */
    nextParagraph: (text) => { const p = document.createElement('p'); p.textContent = text; body.appendChild(p); },
    finishAnswer: () => container.setAttribute('data-is-streaming', 'false'),
    texts: (kind) => calls.filter((c) => c.kind === kind).map((c) => c.text),
  };
}

test('the first words go to Telegram even when they are only a few characters', async (t) => {
  const { start, write, wait, calls } = setup(t);
  start();
  await wait(30);
  write('GROUP');          // Claude often opens with a piece this short, then pauses
  await wait(60);

  assert.deepEqual(calls.map((c) => [c.kind, c.text]), [['send', 'GROUP']]);
  assert.ok(calls[0].at < 90, `sent ${calls[0].at} ms in, without waiting for more text`);
});

test('more text is pushed as soon as it appears', async (t) => {
  const { start, write, wait, calls, texts } = setup(t);
  start();
  write('GROUP');
  await wait(40);
  write('GROUP BY collapses rows into one per group');
  await wait(40);

  assert.deepEqual(texts('stream-edit'), ['GROUP BY collapses rows into one per group']);
  const edit = calls.find((c) => c.kind === 'stream-edit');
  assert.ok(edit.at < 120, `edit went out ${edit.at} ms in, not on a half-second clock`);
});

test('a burst of small changes becomes few edits, ending on the latest text', async (t) => {
  const { start, write, wait, texts } = setup(t);
  start();
  write('One');
  await wait(40);
  for (const text of ['One two', 'One two three', 'One two three four', 'One two three four five']) {
    write(text);
    await wait(40);
  }
  await wait(400);

  const edits = texts('stream-edit');
  assert.ok(edits.length <= 3, `${edits.length} edits for 4 quick changes`);
  assert.equal(edits.at(-1), 'One two three four five');
});

test('the paragraph is finalised the moment the next one starts', async (t) => {
  const { start, write, nextParagraph, wait, calls } = setup(t);
  start();
  write('First paragraph');
  await wait(40);
  write('First paragraph is complete.');
  nextParagraph('Second');
  await wait(60);

  const last = calls.at(-1);
  assert.equal(last.text, 'First paragraph is complete.');
  assert.ok(calls.some((c) => c.kind === 'final-edit' || c.text === 'First paragraph is complete.'));
});

test('the last words are delivered when the answer ends', async (t) => {
  const { start, write, finishAnswer, wait, calls } = setup(t);
  start();
  write('Short answer');
  await wait(40);
  write('Short answer, now finished.');
  finishAnswer();
  await wait(80);

  assert.equal(calls.at(-1).text, 'Short answer, now finished.');
});

test('text whose progress edit was held back still reaches Telegram with the final edit', async (t) => {
  // The last progress edit of an answer is held back (Telegram's limit). The
  // text used to be marked as sent anyway, so the final edit was skipped and
  // the Telegram message stayed on the older text.
  const { start, write, wait, finishAnswer, texts } = setup(t, { streamEditReply: { success: false, waitMs: 60_000 } });
  start();
  write('GROUP BY collapses');
  await wait(40);
  write('GROUP BY collapses each group into a single row.');
  await wait(40);
  finishAnswer();
  await wait(60);

  assert.deepEqual(texts('final-edit'), ['GROUP BY collapses each group into a single row.']);
});

test('a bold word still being typed does not break later updates', async (t) => {
  // Telegram-formatted text for <strong>Kaf</strong> is "*Kaf*", which is not
  // a prefix of "*Kafka* is fast". The paragraph must still be recognised.
  const { start, wait, container, texts } = setup(t);
  const body = container.querySelector('.standard-markdown');
  const p = container.ownerDocument.createElement('p');
  p.innerHTML = '<strong>Kaf</strong>';
  start();
  body.appendChild(p);
  await wait(40);
  p.innerHTML = '<strong>Kafka</strong> is fast';
  await wait(60);

  assert.deepEqual(texts('send'), ['*Kaf*']);
  assert.deepEqual(texts('stream-edit'), ['*Kafka* is fast']);
});

test('a live question is timed stage by stage once its first words reach Telegram', async (t) => {
  const { P, start, write, wait, toBackground } = setup(t);
  // As left by the send shortcut: last word heard 1.5 s ago, key pressed 0.3 s ago, question handed over 0.25 s ago.
  const now = Date.now();
  P.state.voiceTiming = { mode: 'live', lastTextAt: now - 1500, pressedAt: now - 300, submittedAt: now - 250 };
  start();
  await wait(30);
  write('Kafka keeps a durable, replayable log');
  await wait(60);

  const report = toBackground.find((m) => m.type === 'VOICE_TIMING');
  assert.ok(report, 'the timing was reported to the background');
  const r = report.record;
  assert.ok(Math.abs(r.lastWordToSendMs - 1200) <= 5, `your own decision time: ${r.lastWordToSendMs} ms`);
  assert.ok(Math.abs(r.sendToSubmittedMs - 50) <= 5, `hand-over: ${r.sendToSubmittedMs} ms`);
  assert.ok(r.submittedToFirstWordsMs >= 250 && r.submittedToFirstWordsMs < 600, `Claude: ${r.submittedToFirstWordsMs} ms`);
  assert.ok(r.firstWordsToTelegramMs >= 0 && r.firstWordsToTelegramMs < 100, `Telegram: ${r.firstWordsToTelegramMs} ms`);
  // The stages after the key press add up to the headline number.
  assert.equal(r.sendToTelegramMs, r.sendToSubmittedMs + r.submittedToFirstWordsMs + r.firstWordsToTelegramMs);
  assert.match(report.summary, /^Telegram in \d\.\d s \(Claude \d\.\d s\)$/);
  assert.equal(P.state.voiceTiming, null, 'one report per question');
});

test('a question sent with Enter in the tab is timed from the moment it was sent', async (t) => {
  const { P, start, write, wait, toBackground } = setup(t);
  const now = Date.now();
  P.state.voiceTiming = { mode: 'live', lastTextAt: now - 900, pressedAt: null, submittedAt: now - 200 };
  start();
  write('Short answer');
  await wait(60);

  const r = toBackground.find((m) => m.type === 'VOICE_TIMING').record;
  assert.equal(r.sendToSubmittedMs, null, 'the key press itself is not seen in this case');
  assert.ok(r.sendToTelegramMs >= 200 && r.sendToTelegramMs < 500);
});

test('an answer that is not for a voice question is not timed', async (t) => {
  const { start, write, wait, toBackground } = setup(t);
  start();
  write('Typed question, typed answer');
  await wait(60);

  assert.equal(toBackground.filter((m) => m.type === 'VOICE_TIMING').length, 0);
});
