// ============================================
// TELEGRAM RATE BUDGET
// ============================================
//
// Telegram lets a bot send about 20 messages a minute to one group, edits
// included. A bot that goes over is answered with "Too Many Requests: retry
// after N" (27 seconds was seen), and until then nothing gets through: the
// reader is left looking at half an answer. So every call is counted here, in
// the one place all tabs go through, and the minute's worth is spent by
// importance:
//
//   essential   the first text of an answer, a new chunk, the final edit.
//               Always sent. If Telegram still says wait, the call waits that
//               long and is tried again, so the text arrives late, not never.
//   progress    edits that only show the answer growing. Quick at first so
//               the first sentence appears at once, then further and further
//               apart, and none once the minute is three quarters used. What
//               is left is kept for essential calls.

const TELEGRAM_WINDOW_MS = 60 * 1000;
const TELEGRAM_WINDOW_CALLS = 20;
const TELEGRAM_PROGRESS_CALLS = 15;
// Wait before the first progress edit after the first text of an answer...
const TELEGRAM_PROGRESS_FIRST_GAP_MS = 300;
// ...and how much longer each next wait is. With 1.25, the fourteen progress
// edits of an empty minute are spread over about 26 s instead of 4.
const TELEGRAM_PROGRESS_GAP_GROWTH = 1.25;
// Longest one essential call may be held back in total.
const TELEGRAM_ESSENTIAL_MAX_WAIT_MS = 45 * 1000;
const TELEGRAM_ESSENTIAL_RETRIES = 2;

// When each call of the last minute was made (ms since epoch), oldest first.
let telegramCallTimes = [];
// Telegram said "retry after": nothing is sent before this moment.
let telegramBlockedUntil = 0;

function telegramCallsInWindow(now = Date.now()) {
  telegramCallTimes = telegramCallTimes.filter((at) => now - at < TELEGRAM_WINDOW_MS);
  return telegramCallTimes.length;
}

function noteTelegramCall(now = Date.now()) {
  telegramCallTimes.push(now);
}

function noteTelegramRefusal(retryAfterSeconds, now = Date.now()) {
  telegramBlockedUntil = Math.max(telegramBlockedUntil, now + retryAfterSeconds * 1000);
}

/** How long a progress edit has to wait before it may be sent (0 = now). */
function progressEditWaitMs(now = Date.now()) {
  if (now < telegramBlockedUntil) return telegramBlockedUntil - now;
  const used = telegramCallsInWindow(now);
  if (used === 0) return 0;
  if (used >= TELEGRAM_PROGRESS_CALLS) {
    // Wait until enough of the minute's calls have aged out.
    return telegramCallTimes[used - TELEGRAM_PROGRESS_CALLS] + TELEGRAM_WINDOW_MS - now;
  }
  const gap = TELEGRAM_PROGRESS_FIRST_GAP_MS * TELEGRAM_PROGRESS_GAP_GROWTH ** (used - 1);
  return Math.max(0, Math.ceil(telegramCallTimes[used - 1] + gap - now));
}

/** How long an essential call has to wait before it may be sent (0 = now). */
function essentialCallWaitMs(now = Date.now()) {
  if (now < telegramBlockedUntil) return telegramBlockedUntil - now;
  const used = telegramCallsInWindow(now);
  if (used < TELEGRAM_WINDOW_CALLS) return 0;
  return telegramCallTimes[used - TELEGRAM_WINDOW_CALLS] + TELEGRAM_WINDOW_MS - now;
}

/**
 * Make one essential call. `request()` performs it and resolves with
 * Telegram's parsed reply. Waits for room in the minute first; if Telegram
 * answers "retry after", waits that long and tries again.
 */
async function telegramEssentialCall(request) {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const wait = essentialCallWaitMs();
    if (wait > 0) {
      if (waited + wait > TELEGRAM_ESSENTIAL_MAX_WAIT_MS) {
        return { ok: false, error_code: 429, description: `Too Many Requests: still blocked after waiting ${Math.round(waited / 1000)} s` };
      }
      await sleep(wait);
      waited += wait;
    }
    noteTelegramCall();
    const data = await request();
    if (data.ok || data.error_code !== 429 || attempt >= TELEGRAM_ESSENTIAL_RETRIES) return data;
    const retryAfter = data.parameters?.retry_after || 1;
    noteTelegramRefusal(retryAfter);
    log.telegram.warn(`Telegram asked to wait ${retryAfter} s; holding the message and sending it then`);
  }
}
