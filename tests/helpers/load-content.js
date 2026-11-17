import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CONTENT_FILES = [
  'content/constants.js',
  'content/logger.js',
  'content/state.js',
  'content/selectors.js',
  'content/text.js',
];

/**
 * Load content modules into a fresh JSDOM page.
 * `extraFiles` are loaded after the core modules, in order; `globals` are
 * defined on the page first (e.g. a `chrome` stub for modules that message
 * the background worker). `prepare(P)` runs after the core modules and before
 * the extra ones, to stand in for modules a test does not load.
 */
export function loadPersephone(html, { url = 'https://claude.ai/chat/test', extraFiles = [], globals = {}, prepare = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: 'dangerously',
  });
  const context = dom.getInternalVMContext();
  Object.assign(dom.window, globals);

  const run = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  CONTENT_FILES.forEach(run);
  if (prepare) prepare(dom.window.Persephone);
  extraFiles.forEach(run);

  return { window: dom.window, document: dom.window.document, P: dom.window.Persephone };
}
