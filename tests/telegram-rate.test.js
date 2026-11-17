import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The background's Telegram code on a hand-driven clock, with Telegram itself
 * replaced by a script of replies. Waiting (the code's `sleep`) moves the
 * clock forward instead of taking real time.
 */
function setup() {
  let now = 1_000_000;
  const calls = [];            // every request that reached "Telegram": { method, text, at }
  const replies = [];          // scripted replies, used in order; default is success
  const warnings = [];
  const quiet = () => {};
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console,
    Promise,
    JSON,
    Math,
    setTimeout,
    sleep: async (ms) => { now += ms; },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ method: url.split('/').pop(), text: body.text, at: now });
      const reply = replies.shift() || { ok: true, result: { message_id: 500 + calls.length } };
      return { json: async () => reply };
    },
    settingsCache: { botToken: 'TOKEN', chatId: '-1001234567890', messageCount: 0 },
    ensureSettings: async () => true,
    TELEGRAM_MAX_LENGTH: 4096,
    log: { telegram: Object.assign(quiet, { warn: (...args) => warnings.push(args.join(' ')), error: quiet }) },
    chrome: { alarms: { create: quiet, onAlarm: { addListener: quiet } }, storage: { sync: { set: quiet } } },
  });
  for (const file of ['background/telegram-rate.js', 'background/telegram.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return {
    bg: context, calls, warnings,
    advance: (ms) => { now += ms; },
    elapsedSince: (start) => now - start,
    clock: () => now,
    telegramWillSay: (...scripted) => replies.push(...scripted),
    tooManyRequests: (seconds) => ({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${seconds}`, parameters: { retry_after: seconds } }),
  };
}

test('the first progress edit may follow the first text after 0.3 s, each later one a little later', async () => {
  const { bg, advance } = setup();
  await bg.handleSendToTelegram('What');

  assert.equal(bg.progressEditWaitMs(), 300);
  advance(300);
  assert.equal((await bg.handleStreamEdit(501, 'What is')).success, true);
  assert.equal(bg.progressEditWaitMs(), 375, 'a quarter longer than the wait before');
  advance(375);
  assert.equal((await bg.handleStreamEdit(501, 'What is the')).success, true);
  assert.equal(bg.progressEditWaitMs(), 469);
});

test('a progress edit that comes too early is held back without contacting Telegram', async () => {
  const { bg, calls, advance } = setup();
  await bg.handleSendToTelegram('What');
  advance(100);

  const result = await bg.handleStreamEdit(501, 'What is');

  assert.equal(result.success, false);
  assert.equal(result.waitMs, 200, 'the page is told when to try again');
  assert.equal(calls.length, 1, 'only the first text reached Telegram');
});

test('a long answer cannot use up the minute: progress edits stop at 15 calls, the final edit still goes', async () => {
  const { bg, calls, advance } = setup();
  await bg.handleSendToTelegram('first words');
  let sent = 0;
  // An answer that keeps growing for half a minute, the page asking four times a second.
  for (let i = 0; i < 120; i++) {
    advance(250);
    if ((await bg.handleStreamEdit(501, `text ${i}`)).success) sent += 1;
  }
  assert.equal(sent, 14, 'fourteen progress edits, spread over the answer');
  assert.equal(calls.length, 15);

  const final = await bg.handleEditMessage(501, 'the whole answer');
  assert.equal(final.success, true);
  assert.equal(calls.at(-1).text, 'the whole answer');
  assert.ok(calls.length <= 20, 'still inside what Telegram allows in a minute');
});

test('the early edits come fast and the late ones slow', async () => {
  const { bg, calls, advance } = setup();
  const start = (await bg.handleSendToTelegram('first words'), calls[0].at);
  for (let i = 0; i < 400; i++) {
    advance(50);
    await bg.handleStreamEdit(501, `text ${i}`);
  }
  const times = calls.slice(1).map((c) => c.at - start);
  assert.ok(times[3] <= 2000, `four edits within the first two seconds (fourth at ${times[3]} ms)`);
  assert.ok(times.at(-1) >= 15000, `the last edits reach into a long answer (last at ${times.at(-1)} ms)`);
});

test('calls older than a minute no longer count', async () => {
  const { bg, advance } = setup();
  for (let i = 0; i < 15; i++) { await bg.handleSendToTelegram(`message ${i}`); advance(1000); }
  assert.ok(bg.progressEditWaitMs() > 0, 'the minute is three quarters used: progress edits wait');

  advance(60_000);
  assert.equal(bg.progressEditWaitMs(), 0);
});

test('a new chunk that Telegram refuses is held and sent when Telegram allows it', async () => {
  // Seen live: "Too Many Requests: retry after 27", and the chunk was simply dropped.
  const { bg, calls, warnings, clock, telegramWillSay, tooManyRequests } = setup();
  const start = clock();
  telegramWillSay(tooManyRequests(27));

  const result = await bg.handleSendToTelegram('the second chunk of the answer');

  assert.equal(result.success, true);
  assert.deepEqual(calls.map((c) => c.at - start), [0, 27_000], 'tried, waited the 27 s asked for, sent');
  assert.equal(calls[1].text, 'the second chunk of the answer');
  assert.equal(warnings.length, 1);
});

test('a final edit that Telegram refuses is held and sent too', async () => {
  const { bg, calls, telegramWillSay, tooManyRequests } = setup();
  telegramWillSay(tooManyRequests(5));

  const result = await bg.handleEditMessage(501, 'the finished answer');

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
});

test('while Telegram has asked to wait, progress edits are not even tried', async () => {
  const { bg, calls, advance, telegramWillSay, tooManyRequests } = setup();
  await bg.handleSendToTelegram('first words');
  advance(300);
  telegramWillSay(tooManyRequests(27));
  const refused = await bg.handleStreamEdit(501, 'first words and more');
  assert.equal(refused.retryAfterMs, 27_000);

  advance(5000);
  const held = await bg.handleStreamEdit(501, 'first words and more still');
  assert.equal(held.success, false);
  assert.equal(held.waitMs, 22_000);
  assert.equal(calls.length, 2, 'nothing more was sent into the block');
});

test('Telegram refusing again and again is given up on, with the reason', async () => {
  const { bg, calls, telegramWillSay, tooManyRequests } = setup();
  telegramWillSay(tooManyRequests(10), tooManyRequests(10), tooManyRequests(10));

  const result = await bg.handleSendToTelegram('text');

  assert.equal(result.success, false);
  assert.match(result.error, /Too Many Requests/);
  assert.equal(calls.length, 3, 'the first try and two more');
});

test('an edit that changes nothing counts as done', async () => {
  // Telegram answers "message is not modified" when the text is already what
  // the message says. That stopped an answer from being split into chunks.
  const { bg, telegramWillSay } = setup();
  telegramWillSay({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' });

  const result = await bg.handleEditMessage(501, 'same text as before');

  assert.equal(result.success, true);
});

test('any other refusal of an edit is still reported', async () => {
  const { bg, telegramWillSay } = setup();
  telegramWillSay({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });

  const result = await bg.handleEditMessage(501, 'text');

  assert.equal(result.success, false);
  assert.match(result.error, /not found/);
});
