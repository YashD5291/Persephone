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

export function loadPersephone(html, { url = 'https://claude.ai/chat/test' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: 'dangerously',
  });
  const context = dom.getInternalVMContext();

  for (const file of CONTENT_FILES) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }

  return { window: dom.window, document: dom.window.document, P: dom.window.Persephone };
}
