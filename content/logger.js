(function() {
  'use strict';
  const P = window.Persephone;

  const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
  const LOG_LEVEL = 'debug';

  const logBuffer = [];
  const LOG_BUFFER_MAX = 200;

  function createLogger() {
    const categories = ['streaming', 'selectors', 'telegram', 'state', 'ui', 'voice', 'screenshot', 'init'];
    const logger = {};

    function emit(category, level, args) {
      const entry = {
        ts: Date.now(),
        cat: category,
        lvl: level,
        msg: args.map(a => {
          if (a === undefined) return 'undefined';
          if (a === null) return 'null';
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
          return String(a);
        }).join(' ')
      };
      logBuffer.push(entry);
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

      if (LOG_LEVELS[level] <= LOG_LEVELS[LOG_LEVEL]) {
        const prefix = `[Persephone:${category}]`;
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(prefix, ...args);
      }
    }

    categories.forEach(cat => {
      const logFn = (...args) => emit(cat, 'info', args);
      logFn.debug = (...args) => emit(cat, 'debug', args);
      logFn.info = (...args) => emit(cat, 'info', args);
      logFn.warn = (...args) => emit(cat, 'warn', args);
      logFn.error = (...args) => emit(cat, 'error', args);
      logger[cat] = logFn;
    });

    logger.getBuffer = () => [...logBuffer];
    logger.getRecent = (n = 50) => logBuffer.slice(-n);

    return logger;
  }

  const log = createLogger();

  // --- Exports ---
  Object.assign(P, { log, logBuffer });
})();
