// ============================================
// STRUCTURED LOGGER
// ============================================

const BG_LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const BG_LOG_LEVEL = 'debug';

const bgLogBuffer = [];
const BG_LOG_BUFFER_MAX = 200;

function createBgLogger() {
  const categories = ['settings', 'telegram', 'screenshot', 'broadcast', 'native', 'init'];
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
    bgLogBuffer.push(entry);
    if (bgLogBuffer.length > BG_LOG_BUFFER_MAX) bgLogBuffer.shift();

    if (BG_LOG_LEVELS[level] <= BG_LOG_LEVELS[BG_LOG_LEVEL]) {
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

  logger.getBuffer = () => [...bgLogBuffer];
  logger.getRecent = (n = 50) => bgLogBuffer.slice(-n);

  return logger;
}

const log = createBgLogger();

const TELEGRAM_MAX_LENGTH = 4096;
