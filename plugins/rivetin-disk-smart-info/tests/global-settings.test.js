import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createGlobalCollection } from '../src/global-collection.js';
import { globalStates } from '../demo/global-fixture.js';
import { createMockBatchProvider } from '../demo/global-fixture.js';
import createPlugin from '../src/definition.js';
import { defaults } from '../src/configuration.js';
const requireFramework = createRequire(new URL('../../../framework/package.json', import.meta.url));
const React = requireFramework('react'), ReactDOM = requireFramework('react-dom'), { JSDOM } = requireFramework('jsdom');

async function fixture(t, props = {}, createComponent = () => createGlobalCollection(React)) {
  const dom = new JSDOM('<!doctype html><html><body><div id="settings"></div></body></html>', { url: 'https://tower.example.invalid' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.getElementById('settings'), Component = createComponent(dom.window);
  const render = value => ReactDOM.render(React.createElement(Component, value), root); render(props);
  t.after(() => { ReactDOM.unmountComponentAtNode(root); dom.window.close(); globalThis.window = previous.window; globalThis.document = previous.document; });
  return { root, render, win: dom.window };
}

test('global settings has a distinct explicit action and never collects while rendering', async t => {
  let submits = 0; const f = await fixture(t, { onCollect: () => submits++ });
  assert.equal(submits, 0); assert.match(f.root.textContent, /全局手动采集/); assert.match(f.root.textContent, /物理盘侧栏仍可单独采集/);
  f.root.querySelector('button').click(); assert.equal(submits, 1); assert.equal(f.root.querySelector('button').type, 'button');
});

test('global settings separates the read-only command template from per-disk authorized plans in both languages', async t => {
  let submits = 0; const f = await fixture(t, { locale: 'zh-CN', onCollect: () => submits++ });
  assert.match(f.root.textContent, /命令范式/); assert.match(f.root.textContent, /目标主机.*库存/);
  assert.match(f.root.textContent, /all.*custom/); assert.match(f.root.textContent, /逐盘/);
  assert.equal(f.root.querySelector('[data-smart-command-template]').textContent, 'sudo -n -- /usr/sbin/smartctl --json=c --all <disk>');
  const declaration = f.root.querySelector('[data-smart-command-declaration]');
  assert.equal(declaration.dataset.smartCategory, 'disk'); assert.equal(declaration.dataset.smartArgumentSource, 'fresh-host-inventory');
  assert.equal(declaration.dataset.smartExpansion, 'each-authorized-disk'); assert.match(declaration.textContent, /旧v1/);
  assert.doesNotMatch(f.root.querySelector('[data-smart-command-declaration]').textContent, /\/dev\/sd[a-z]/);
  assert.equal(submits, 0);
  f.render({ locale: 'en-US', onCollect: () => submits++ });
  assert.match(f.root.textContent, /Command template/); assert.match(f.root.textContent, /fresh inventory/);
  assert.match(f.root.textContent, /not executable input/); assert.equal(submits, 0);
});

test('plugin settings wires the global action without saving drafts and stops its wait on unmount', async t => {
  let plugin, stop, posts = 0, aborted = false;
  const mock = createMockBatchProvider();
  const provider = { ...mock, collectAll: args => { posts++; args.signal.addEventListener('abort', () => { aborted = true; }); return mock.collectAll(args); } };
  const f = await fixture(t, { locale: 'zh-CN', preferences: defaults() }, win => {
    plugin = createPlugin({ React, win, options: { diskSmartInfo: { provider }, configurationBackend: () => ({ load: async () => ({ revision: 0, updatedAt: null, settings: defaults() }) }) } });
    return plugin.Settings;
  });
  t.after(() => { stop?.(); plugin.store.dispose(); });
  await plugin.store.load(); stop = plugin.activate();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(posts, 0); assert.equal(f.root.querySelector('[data-smart-collect-all]').disabled, false);
  f.root.querySelector('[data-smart-collect-all]').click(); f.root.querySelector('[data-smart-collect-all]').click();
  assert.equal(posts, 1); assert.equal(f.root.querySelector('[data-smart-collect-all]').disabled, true);
  assert.equal(plugin.store.status().dirty, false);
  ReactDOM.unmountComponentAtNode(f.root); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(aborted, true);
  stop(); stop = null;
  f.render({ locale: 'en-US', preferences: defaults() }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.root.querySelector('[data-smart-collect-all]').disabled, true); assert.equal(posts, 1);
});

test('running batch disables submission and renders bounded progress counters', async t => {
  let submits = 0; const f = await fixture(t, { state: globalStates.running, onCollect: () => submits++ });
  f.root.querySelector('button').click(); assert.equal(submits, 0); assert.equal(f.root.querySelector('button').disabled, true);
  assert.match(f.root.textContent, /后台任务可能继续/); assert.equal(f.root.querySelectorAll('tbody tr').length, 3);
});

test('partial batch displays failures and skipped targets instead of universal success', async t => {
  const f = await fixture(t, { state: globalStates.partial, onCollect() {} });
  assert.match(f.root.querySelector('[role="status"]').textContent, /存在失败、待确认或未执行/);
  assert.match(f.root.textContent, /采集命令尚未审核/); assert.equal(f.root.querySelectorAll('tbody tr').length, 3);
});

test('zero targets and unknown outcomes cannot be presented as successful collection', async t => {
  const f = await fixture(t, { state: globalStates.empty, onCollect() {} });
  assert.match(f.root.textContent, /没有可执行的采集目标/); assert.doesNotMatch(f.root.textContent, /批次采集已完成/);
  f.render({ state: globalStates.unknown, onCollect() {} }); assert.match(f.root.textContent, /未自动重发/); assert.doesNotMatch(f.root.textContent, /批次采集已完成/);
  f.render({ state: { status: 'succeeded', summary: { ...globalStates.completed.summary, total: 3 } }, onCollect() {} });
  assert.match(f.root.textContent, /信息不完整/); assert.doesNotMatch(f.root.textContent, /批次采集已完成/);
  f.render({ state: { ...globalStates.running, status: 'succeeded' }, onCollect() {} });
  assert.match(f.root.textContent, /信息不完整/); assert.doesNotMatch(f.root.textContent, /批次采集已完成/);
});

test('unavailable capability and explicit disabled state prevent clicks', async t => {
  const f = await fixture(t); assert.equal(f.root.querySelector('button').disabled, true); assert.match(f.root.textContent, /当前框架尚未提供全局采集/);
  let submits = 0; f.render({ disabled: true, onCollect: () => submits++ }); f.root.querySelector('button').click(); assert.equal(submits, 0);
});

test('global results localize to English and escape labels without exposing arbitrary error messages', async t => {
  const state = structuredClone(globalStates.partial); state.items[0].label = '<img src=x onerror=alert(1)>'; state.items[1].code = 'private stack text';
  const f = await fixture(t, { locale: 'en-US', state, onCollect() {} });
  assert.match(f.root.textContent, /Collect all now/); assert.match(f.root.textContent, /failed, unknown or skipped/); assert.match(f.root.textContent, /<img/);
  assert.equal(f.root.querySelector('img'), null); assert.doesNotMatch(f.root.textContent, /private stack text/);
});
