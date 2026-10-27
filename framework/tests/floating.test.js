import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { clampPosition, createFloatingButton } from '../src/floating.js';
import { createPreferenceStore, KEY } from '../src/personal.js';
import { installMenuEntry } from '../src/menu-bridge.js';
const { act } = testUtils;
test('drag clamps to viewport, does not open on pointer release, and keeps normal click/keyboard activation', () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const Floating = createFloatingButton(React); let opened = 0, saved;
  try {
    act(() => { ReactDOM.render(React.createElement(Floating, { win: window, state: 'enabled', label: '插件已启用', settingsLabel: '插件设置', onPosition: p => { saved = p; }, onOpen: () => opened++ }), document.getElementById('root')); });
    const button = document.querySelector('button'); button.getBoundingClientRect = () => ({ left: 600, top: 500, width: 160, height: 44 });
    assert.equal(button.style.bottom, '88px');
    act(() => testUtils.Simulate.pointerDown(button, { pointerId: 1, button: 0, clientX: 620, clientY: 520 }));
    act(() => testUtils.Simulate.pointerMove(button, { pointerId: 1, clientX: -200, clientY: -100, preventDefault() {} }));
    act(() => testUtils.Simulate.pointerUp(button, { pointerId: 1 }));
    act(() => testUtils.Simulate.click(button, { detail: 1, preventDefault() {} })); assert.equal(opened, 0); assert.deepEqual(saved, { x: 12, y: 12 });
    act(() => testUtils.Simulate.click(button, { detail: 0 })); assert.equal(opened, 1);
    act(() => testUtils.Simulate.keyDown(button, { altKey: true, key: 'ArrowUp', preventDefault() {} })); assert.equal(saved.y, 484);
    assert.deepEqual(clampPosition({ x: 9999, y: 9999 }, { width: 400, height: 300 }, { width: 160, height: 44 }), { x: 228, y: 244 });
  } finally { act(() => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); }); dom.window.close(); delete globalThis.window; delete globalThis.document; }
});
test('floating position is a local preference; updates retain visibility and ignore unknown fields', () => {
  const dom = new JSDOM('', { url: 'https://tower.example.invalid' });
  let store = createPreferenceStore(dom.window);
  store.update({ showFloatingButton: false }); store.update({ floatingPosition: { x: 400, y: 200 }, password: 'EXAMPLE_NOT_TO_SAVE' });
  assert.equal(store.get().showFloatingButton, false); assert.deepEqual(store.get().floatingPosition, { x: 400, y: 200 });
  assert.ok(!dom.window.localStorage.getItem(KEY).includes('EXAMPLE_NOT_TO_SAVE')); store.dispose();
  store = createPreferenceStore(dom.window); assert.deepEqual(store.get().floatingPosition, { x: 400, y: 200 }); store.dispose(); dom.window.close();
});
test('menu host receives outside-click dismissal before the plugin center opens', () => {
  const dom = new JSDOM('<body><div id="menu"><button>系统配置</button><button>标签管理</button></div></body>');
  let visible = true, opened = false;
  dom.window.document.addEventListener('mousedown', event => { if (!event.target.closest('#menu')) visible = false; });
  const stop = installMenuEntry({ win: dom.window, onOpen: () => { assert.equal(visible, false); opened = true; } });
  dom.window.document.querySelector('[data-c89-menu-entry]').click(); assert.equal(opened, true); stop(); dom.window.close();
});

test('Rivetin preferences use only their own key without migrating other browser values', () => {
  const dom = new JSDOM('', { url: 'https://tower.example.invalid' });
  dom.window.localStorage.setItem('pluginkit.personal.v1', JSON.stringify({ showFloatingButton: false, floatingPosition: { x: 40, y: 50 } }));
  const store = createPreferenceStore(dom.window);
  try {
    assert.equal(store.get().showFloatingButton, true); assert.equal(store.get().floatingPosition, null);
    store.update({ showFloatingButton: false });
    assert.equal(JSON.parse(dom.window.localStorage.getItem(KEY)).showFloatingButton, false);
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'pluginkit.personal.v1', newValue: JSON.stringify({ showFloatingButton: true }) }));
    assert.equal(store.get().showFloatingButton, false);
  } finally { store.dispose(); dom.window.close(); }
});
