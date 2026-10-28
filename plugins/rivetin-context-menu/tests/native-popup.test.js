import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeMenuOpener, ownedNativePopup, nativePopups } from '../src/native/popup.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
function fixture(t) {
  const dom = new JSDOM('<aside><div class="toolbar"><button class="ant-dropdown-trigger"><svg data-testid="EditPen16BlueIcon"></svg>编辑</button></div></aside>');
  const win = dom.window, doc = win.document, pane = doc.querySelector('aside'), trigger = doc.querySelector('button');
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 });
  t.after(() => win.close());
  function popup() { const n = doc.createElement('div'); n.className = 'ant-dropdown'; doc.body.append(n); return n; }
  return { win, doc, pane, trigger, popup };
}
test('portal ownership requires a new visible popup and an opened exact trigger', t => {
  const f = fixture(t); assert.equal(nativeMenuOpener(f.win, f.pane, 'edit-item'), f.trigger);
  const before = new Set(nativePopups(f.win)), p = f.popup();
  assert.equal(ownedNativePopup(f.win, f.trigger, before), null);
  f.trigger.classList.add('ant-dropdown-open'); assert.equal(ownedNativePopup(f.win, f.trigger, before), p);
  assert.equal(ownedNativePopup(f.win, f.trigger, new Set([p])), null);
});
test('concurrent portals and conflicting edit labels cannot be claimed', t => {
  const f = fixture(t); f.trigger.classList.add('ant-dropdown-open'); f.popup(); f.popup();
  assert.equal(ownedNativePopup(f.win, f.trigger, new Set()), null);
  f.trigger.append(' Delete'); assert.equal(nativeMenuOpener(f.win, f.pane, 'edit-item'), null);
});
test('distant portal requires an explicit correct ARIA relation', t => {
  const f = fixture(t), p = f.popup(); p.id = 'owned'; f.trigger.classList.add('ant-dropdown-open');
  p.getBoundingClientRect = () => ({ left: 900, top: 900, right: 1000, bottom: 930, width: 100, height: 30 });
  assert.equal(ownedNativePopup(f.win, f.trigger, new Set()), null);
  f.trigger.setAttribute('aria-controls', 'owned'); assert.equal(ownedNativePopup(f.win, f.trigger, new Set()), p);
});
