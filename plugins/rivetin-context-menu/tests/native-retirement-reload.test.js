import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');

test('re-evaluated retirement module preserves retired DOM identity on the same document', async t => {
  const dom = new JSDOM('<table><tr data-row-key="host-a"><td unique="_action_"><button>More</button></td></tr></table>');
  t.after(() => dom.window.close());
  const first = await import('../src/native/retirement.js?first-load');
  const second = await import('../src/native/retirement.js?second-load');
  const node = dom.window.document.querySelector('button');
  first.nativeRetirement(dom.window).quarantine();
  assert.equal(second.nativeRetirement(dom.window).trusted(node), false, 'a new module closure must not restore a retired callback');
  const fresh = dom.window.document.createElement('button'); node.replaceWith(fresh);
  assert.equal(second.nativeRetirement(dom.window).trusted(fresh), true, 'new verified nodes must remain eligible');
});
