import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersephone } from './helpers/load-content.js';

/**
 * A pacer on a hand-driven clock. `sends` records when each send started;
 * a send stays "in flight" until the test finishes it.
 */
function harness(t) {
  const { window, P } = loadPersephone('', { extraFiles: ['content/pacer.js'] });
  t.after(() => window.close());

  let now = 0;
  let nothingToSend = false;
  const timers = [];
  const sends = [];
  const pacer = P.createEditPacer({
    // Like the real sender: resolves null when the text has not changed.
    send: () => (nothingToSend ? Promise.resolve(null) : new Promise((resolve, reject) => sends.push({ at: now, resolve, reject }))),
    minGapMs: 300,
    slowGapMs: 1000,
    now: () => now,
    setTimer: (fn, ms) => { const timer = { fn, at: now + ms, state: 'waiting' }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.state = 'cancelled'; },
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    pacer, sends, timers,
    startedAt: () => sends.map((s) => s.at),
    setNothingToSend: (value) => { nothingToSend = value; },
    settle,
    /** Move the clock and fire timers that came due, like a tab that is in front. */
    advanceTo: async (time) => {
      now = time;
      for (const timer of timers.filter((x) => x.state === 'waiting' && x.at <= now)) { timer.state = 'fired'; timer.fn(); }
      await settle();
    },
    /** Move the clock WITHOUT firing timers, like a background tab whose timers Chrome is holding back. */
    clockOnly: (time) => { now = time; },
    finish: async (index, result = { success: true }) => { sends[index].resolve(result); await settle(); },
    fail: async (index) => { sends[index].reject(new Error('network')); await settle(); },
  };
}

test('the first change is sent at once, with no timer in between', (t) => {
  const { pacer, startedAt, timers } = harness(t);
  pacer.request();

  assert.deepEqual(startedAt(), [0]);
  assert.equal(timers.length, 0);
});

test('a change after a quiet spell is sent at once', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0);
  await advanceTo(1200);
  pacer.request();

  assert.deepEqual(startedAt(), [0, 1200]);
});

test('a change inside the gap waits only for the rest of the gap', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0);
  await advanceTo(100);
  pacer.request();

  await advanceTo(299);
  assert.deepEqual(startedAt(), [0]);
  await advanceTo(300);
  assert.deepEqual(startedAt(), [0, 300]);
});

test('several changes inside the gap become one send', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0);
  for (const time of [50, 100, 150, 200]) { await advanceTo(time); pacer.request(); }
  await advanceTo(300);

  assert.deepEqual(startedAt(), [0, 300]);
});

test('changes during a send become one follow-up after it', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  pacer.request();
  pacer.request();
  assert.deepEqual(startedAt(), [0], 'only one send in flight at a time');

  await advanceTo(120);
  await finish(0);
  await advanceTo(300);
  assert.deepEqual(startedAt(), [0, 300]);
});

test('a slow send is followed immediately, the gap having already passed', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  pacer.request();
  await advanceTo(450);
  await finish(0);

  assert.deepEqual(startedAt(), [0, 450]);
});

test('nothing more is sent when nothing changed', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0);
  await advanceTo(5000);

  assert.deepEqual(startedAt(), [0]);
});

test('a check that finds nothing new does not delay the next real change', async (t) => {
  // The stream re-checks the page a few times a second as a safety net.
  // Those empty checks must not use up the gap.
  const { pacer, startedAt, finish, advanceTo, setNothingToSend, settle } = harness(t);
  pacer.request();
  await finish(0);
  await advanceTo(1000);

  setNothingToSend(true);
  pacer.request();
  await settle();
  setNothingToSend(false);

  await advanceTo(1010);
  pacer.request();
  assert.deepEqual(startedAt(), [0, 1010]);
});

test('held-back timers do not hold back text: the next change sends it', async (t) => {
  // Chrome delays timers in a tab that is not in front. The gap has long
  // passed on the clock, but the timer that was meant to fire never did.
  const { pacer, startedAt, finish, clockOnly, timers } = harness(t);
  pacer.request();
  await finish(0);
  clockOnly(100);
  pacer.request();            // arms a timer for 300 that will not fire
  clockOnly(2000);
  pacer.request();            // another change arrives

  assert.deepEqual(startedAt(), [0, 2000]);
  assert.equal(timers[0].state, 'cancelled', 'the stale timer cannot cause a duplicate send later');
});

test('when Telegram says slow down, sending pauses and then keeps a wider gap', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0, { success: false, retryAfterMs: 2000 });

  await advanceTo(1999);
  assert.deepEqual(startedAt(), [0], 'paused for as long as Telegram asked');
  await advanceTo(2000);
  assert.deepEqual(startedAt(), [0, 2000], 'the refused text is sent once the pause is over');
  assert.equal(pacer.gapMs, 1000);

  await finish(1);
  pacer.request();
  await advanceTo(2999);
  assert.deepEqual(startedAt(), [0, 2000]);
  await advanceTo(3000);
  assert.deepEqual(startedAt(), [0, 2000, 3000]);
});

test('text the background holds back is sent after the wait, at the usual pace afterwards', async (t) => {
  // Not Telegram saying "slow down": the background worker keeping inside
  // Telegram's limit. The stream must not stay slow because of it.
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0, { success: false, waitMs: 800 });

  await advanceTo(799);
  assert.deepEqual(startedAt(), [0]);
  await advanceTo(800);
  assert.deepEqual(startedAt(), [0, 800], 'the held text goes out once the wait is over');
  assert.equal(pacer.gapMs, 300, 'the gap stays as it was');

  await finish(1);
  pacer.request();
  await advanceTo(1100);
  assert.deepEqual(startedAt(), [0, 800, 1100]);
});

test('a failed send does not stop later changes from going out', async (t) => {
  const { pacer, startedAt, fail, advanceTo } = harness(t);
  pacer.request();
  await fail(0);
  await advanceTo(400);
  pacer.request();

  assert.deepEqual(startedAt(), [0, 400]);
});

test('stopping cancels a waiting follow-up', async (t) => {
  const { pacer, startedAt, finish, advanceTo } = harness(t);
  pacer.request();
  await finish(0);
  await advanceTo(100);
  pacer.request();
  pacer.stop();
  await advanceTo(1000);
  pacer.request();

  assert.deepEqual(startedAt(), [0]);
});
