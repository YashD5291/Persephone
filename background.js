// Persephone - Background Service Worker (entry point)
// Splits loaded via importScripts — all share the global scope.

importScripts(
  'background/constants.js',
  'background/logger.js',
  'background/settings.js',
  'background/native.js',
  'background/live.js',
  'background/telegram-rate.js',
  'background/telegram.js',
  'background/messages.js',
  'background/init.js'
);
