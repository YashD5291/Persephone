(function() {
  'use strict';
  const P = window.Persephone;

  /**
   * Pushes "the latest text" somewhere rate-limited (a Telegram message edit)
   * as early as that limit allows.
   *
   * request() means "the text changed". The first change goes out at once.
   * Further changes go out as soon as `minGapMs` has passed since the last
   * send started; changes that arrive in between, or while a send is still in
   * flight, collapse into a single follow-up carrying the newest text.
   *
   * It is driven by calls, not by a clock, on purpose. Chrome slows timers in
   * a tab that is not in front (to once a second, later once a minute), so a
   * polling loop would hold text back for that long. Here a change is sent
   * from the call that reports it whenever the gap has already passed; the
   * timer only covers the case where nothing else happens during the gap.
   *
   * `send` returns a promise. It resolves with null when there turned out to
   * be nothing new to send; such a call does not count against the gap, so a
   * routine "anything changed?" check never delays the next real change. If
   * it resolves with `retryAfterMs` (Telegram saying "slow down"), sending
   * pauses that long and the gap widens to `slowGapMs` for the rest of this
   * pacer's life. If it resolves with `waitMs` (the background worker holding
   * the text back to stay inside Telegram's limit), sending pauses that long
   * and then carries on as before. Either way the text that did not go out is
   * sent as soon as the pause is over.
   */
  function createEditPacer({ send, minGapMs, slowGapMs, now = () => performance.now(),
                             setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
    let gapMs = minGapMs;
    let lastStartedAt = -Infinity;
    let pausedUntil = 0;
    let inFlight = false;
    let changedDuringSend = false;
    let timer = null;
    let stopped = false;

    async function run() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (stopped) return;
      inFlight = true;
      changedDuringSend = false;
      const previousStart = lastStartedAt;
      lastStartedAt = now();
      let result = null;
      let attempted = true;
      try {
        result = await send();
        attempted = result != null;
      } catch (e) {
        // A failed send is not retried here; the next change will carry newer text anyway.
      }
      inFlight = false;
      if (!attempted) lastStartedAt = previousStart;
      if (result && result.retryAfterMs > 0) {
        pausedUntil = now() + result.retryAfterMs;
        gapMs = Math.max(gapMs, slowGapMs);
        changedDuringSend = true;   // the refused text still has to go out
      } else if (result && result.waitMs > 0) {
        pausedUntil = now() + result.waitMs;
        changedDuringSend = true;   // held back, not refused: same text, a little later
      }
      if (changedDuringSend) request();
    }

    function request() {
      if (stopped) return;
      if (inFlight) { changedDuringSend = true; return; }
      const wait = Math.max(lastStartedAt + gapMs - now(), pausedUntil - now());
      if (wait <= 0) {
        run();
      } else if (timer === null) {
        timer = setTimer(run, wait);
      }
    }

    function stop() {
      stopped = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
    }

    return { request, stop, get gapMs() { return gapMs; } };
  }

  // --- Exports ---
  Object.assign(P, { createEditPacer });
})();
