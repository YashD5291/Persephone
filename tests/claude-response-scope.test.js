import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersephone } from './helpers/load-content.js';

const NEW_CLAUDE_DOM = `
  <div data-is-streaming="false" class="group relative">
    <h2 class="sr-only select-none">Claude responded: everything's local right now, all in one folder: C:\\Users\\juan.</h2>
    <div class="font-claude-response">
      <div class="standard-markdown">
        <p class="font-claude-response-body">everything's local right now, all in one folder: C:\\Users\\juan.flores\\ION-4474-A11y-Investigation\\</p>
        <p class="font-claude-response-body">breakdown of what's in there:</p>
      </div>
    </div>
  </div>
`;

test('getResponseScope excludes the sr-only "Claude responded:" heading', () => {
  const { document, P } = loadPersephone(NEW_CLAUDE_DOM);
  const container = document.querySelector('[data-is-streaming]');
  const scope = P.getResponseScope(container);

  assert.ok(scope, 'expected a response scope');
  assert.equal(scope.querySelector('h2.sr-only'), null);
  assert.match(scope.querySelector('p').textContent, /^everything's local right now/);
});

test('findFirstContentElement skips sr-only heading and returns the real paragraph', () => {
  const { document, P } = loadPersephone(NEW_CLAUDE_DOM);
  const container = document.querySelector('[data-is-streaming]');
  const first = P.findFirstContentElement(container);

  assert.ok(first, 'expected a content element');
  assert.equal(first.tagName, 'P');
  assert.match(first.textContent, /^everything's local right now/);
  assert.doesNotMatch(first.textContent, /Claude responded:/);
});

test('findFirstContentElement does not bind to a lone sr-only heading', () => {
  const { document, P } = loadPersephone(`
    <div data-is-streaming="true">
      <h2 class="sr-only">Claude responded: anytime.</h2>
    </div>
  `);
  const container = document.querySelector('[data-is-streaming]');

  assert.equal(P.findFirstContentElement(container), null);
});

test('getResponseScope still returns null while only thinking UI exists', () => {
  const { document, P } = loadPersephone(`
    <div data-is-streaming="true">
      <div class="row-start-1">thinking summary</div>
    </div>
  `);
  const container = document.querySelector('[data-is-streaming]');
  assert.equal(P.getResponseScope(container), null);
});

test('getResponseScope ignores .font-ui timeline when thinking grid is present', () => {
  const { document, P } = loadPersephone(`
    <div data-is-streaming="true">
      <div class="row-start-2">
        <div class="row-start-1">
          <div class="standard-markdown"><p>hello from the real response</p></div>
        </div>
        <div class="row-start-1">
          <div class="font-ui">10 results</div>
        </div>
      </div>
    </div>
  `);
  const container = document.querySelector('[data-is-streaming]');
  const scope = P.getResponseScope(container);

  assert.ok(scope);
  assert.equal(scope.querySelector('.font-ui'), null);
  assert.match(scope.textContent, /hello from the real response/);
});

test('isElementStreaming does not treat the sr-only heading as the live last element', () => {
  const { document, P } = loadPersephone(`
    <div data-is-streaming="true">
      <h2 class="sr-only">Claude responded: anytime.</h2>
      <div class="font-claude-response">
        <div class="progressive-markdown">
          <p>anytime. happy to dig into any piece of it deeper if useful</p>
        </div>
      </div>
    </div>
  `);
  const heading = document.querySelector('h2.sr-only');
  const paragraph = document.querySelector('p');

  assert.equal(P.isElementStreaming(heading), false);
  assert.equal(P.isElementStreaming(paragraph), true);
});
