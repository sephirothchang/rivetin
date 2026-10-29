import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import factory from '../src/definition.js';
import { configuration } from '../src/configuration.js';
import { validateUiContributions, readUiContributions, UI_CONTRIBUTIONS_MINIMUM, contributionVisible } from '../../../framework/shared/ui-contributions.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom'), React = require('react');
const ReactDOM = require('react-dom'), { act, Simulate } = require('react-dom/test-utils');

async function setup(t, { active = true, load = true, signal, onDirtyChange } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><nav id="host-nav">Host navigation</nav><main id="content"></main><div id="settings"></div></body></html>', { url: 'http://localhost/' });
  const win = dom.window; global.window = win; global.document = win.document;
  win.requestAnimationFrame = callback => win.setTimeout(callback, 0); win.cancelAnimationFrame = id => win.clearTimeout(id);
  let stored = { revision: 0, updatedAt: null, settings: configuration.defaults() }, writes = 0, network = 0, blob;
  win.fetch = () => { network++; throw new Error('NETWORK_FORBIDDEN_IN_TEST'); };
  win.URL.createObjectURL = value => { blob = value; return 'blob:page-review'; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download, 'security-policy-review.json'); };
  const backend = { load: async () => structuredClone(stored), save: async settings => {
    writes++; stored = { revision: stored.revision + 1, updatedAt: null, settings }; return structuredClone(stored);
  } };
  const plugin = factory({ React, win, options: { configurationBackend: () => backend } });
  if (load) await plugin.store.load();
  const stop = plugin.activate(), Page = plugin.ui.pages.find(page => page.id === 'converter').Component;
  const root = win.document.querySelector('#content'), settings = win.document.querySelector('#settings');
  let props = { active, locale: 'zh-CN', signal, onDirtyChange };
  const render = patch => { props = { ...props, ...patch }; act(() => { ReactDOM.render(React.createElement(Page, props), root); }); };
  const click = selector => { const element = root.querySelector(selector); assert.ok(element, selector); act(() => element.click()); };
  render();
  t.after(() => {
    act(() => { ReactDOM.unmountComponentAtNode(root); ReactDOM.unmountComponentAtNode(settings); stop(); });
    plugin.store.dispose(); win.close();
  });
  return { root, settings, win, plugin, render, click,
    unmount() { act(() => { ReactDOM.unmountComponentAtNode(root); }); },
    mountSettings() { act(() => { ReactDOM.render(React.createElement(plugin.Settings, { preferences: plugin.store.getDraft(), locale: 'zh-CN' }), settings); }); },
    stats: () => ({ writes, network, blob }) };
}

test('work page requires explicit host activation and loaded shared configuration', async t => {
  const c = await setup(t, { active: false, load: false });
  assert.equal(c.root.querySelector('textarea'), null);
  c.render({ active: 'false' }); assert.equal(c.root.querySelector('textarea'), null);
  c.render({ active: true }); assert.match(c.root.textContent, /加载共享配置/);
  await act(async () => c.plugin.store.load());
  assert.ok(c.root.querySelector('[data-action="convert"]'));
  c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  assert.match(c.root.textContent, /3 个候选策略，4 条规则/);
});

test('factory owns its Everoute contribution and uses the actual UI contributions framework floor', async t => {
  const c = await setup(t);
  assert.equal(Object.hasOwn(c.plugin, 'workPage'), false);
  assert.deepEqual(c.plugin.ui.pages.map(page => page.id), ['converter']);
  assert.deepEqual(c.plugin.ui.actions, []);
  assert.equal(UI_CONTRIBUTIONS_MINIMUM, '0.2.6');
  const manifest = JSON.parse(readFileSync(new URL('../rivetin.json', import.meta.url)));
  const ui = validateUiContributions(c.plugin.ui, manifest), contribution = ui.contributions[0];
  assert.equal(readUiContributions(c.plugin, manifest).status, 'registered');
  assert.equal(ui.pages[0].slot, 'everoute.navigation.tools');
  assert.deepEqual(contribution, {
    id: 'open-converter', slot: 'everoute.navigation.tools',
    label: { 'zh-CN': '安全策略转换', 'en-US': 'Security policy converter' },
    icon: 'convert', order: 100, visibility: { requiresContext: [] }, target: { type: 'page', id: 'converter' }
  });
  const context = Object.freeze({ schemaVersion: 1, section: 'everoute', clusterId: null });
  assert.equal(contributionVisible(contribution, context), true);
  assert.throws(() => validateUiContributions(c.plugin.ui, { compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.5' } }), /UI_FRAMEWORK_MINIMUM_REQUIRED/);
  c.render({ context });
  c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  assert.ok(c.root.querySelector('[data-summary]')); assert.equal(c.stats().network, 0);
});

test('migration never dual-registers the old field and invalid UI does not alter the original settings store', async t => {
  const c = await setup(t), manifest = JSON.parse(readFileSync(new URL('../rivetin.json', import.meta.url)));
  const before = c.plugin.store.get(), Settings = c.plugin.Settings;
  const dual = readUiContributions({ ...c.plugin, workPage: { section: 'everoute', Component: c.plugin.ui.pages[0].Component } }, manifest);
  assert.equal(dual.code, 'UI_CONTRIBUTIONS_INVALID'); assert.equal(dual.ui, null);
  const legacy = readUiContributions({ ...c.plugin, ui: undefined, workPage: { section: 'everoute', Component: c.plugin.ui.pages[0].Component } }, manifest);
  assert.equal(legacy.status, 'unavailable'); assert.equal(legacy.code, 'UI_LEGACY_WORKPAGE_UNAVAILABLE');
  const invalid = readUiContributions({ ...c.plugin, ui: { ...c.plugin.ui, contributions: [] } }, manifest);
  assert.equal(invalid.code, 'UI_CONTRIBUTIONS_INVALID');
  assert.equal(c.plugin.Settings, Settings); assert.deepEqual(c.plugin.store.get(), before);
  c.mountSettings(); assert.ok(c.settings.querySelector('[data-action="sample"]'));
  assert.equal(c.stats().writes, 0); assert.equal(c.stats().network, 0);
});

test('full page conversion and review export preserve surrounding host content without business requests', async t => {
  const c = await setup(t), nav = c.win.document.querySelector('#host-nav'), before = nav.outerHTML;
  c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  assert.equal(c.root.querySelector('[data-action="export"]').disabled, true);
  c.click('[data-action="review"]'); c.click('[data-action="export"]');
  const text = await new Promise((resolve, reject) => {
    const reader = new c.win.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(c.stats().blob);
  });
  const review = JSON.parse(text);
  assert.equal(review.format, 'rivetin-policy-review-v1'); assert.equal(review.canDeploy, false); assert.equal(review.policies.length, 3);
  assert.equal(nav.outerHTML, before); assert.equal(c.win.document.querySelector('#host-nav'), nav);
  assert.equal(c.stats().network, 0); assert.equal(c.stats().writes, 0); assert.equal(c.win.localStorage.length, 0);
});

test('work page uses saved label key only and invalidates its review after an explicit save', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]'); c.click('[data-action="review"]');
  act(() => { c.plugin.store.update({ labelKey: 'service' }); });
  assert.ok(c.root.querySelector('[data-summary]')); assert.match(c.root.textContent, /已保存的标签键：application/);
  await act(async () => c.plugin.store.save());
  assert.equal(c.root.querySelector('[data-summary]'), null); assert.match(c.root.textContent, /已保存的标签键：service/);
  assert.equal(c.stats().writes, 1);
});

test('settings and work page have independent imported data and unmount cleanup', async t => {
  const c = await setup(t); c.mountSettings(); c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  assert.equal(c.settings.querySelector('[data-field="inventoryText"]').value, '');
  act(() => c.settings.querySelector('[data-action="sample"]').click());
  act(() => { ReactDOM.unmountComponentAtNode(c.settings); });
  assert.ok(c.root.querySelector('[data-summary]'));
  c.unmount(); c.render();
  assert.equal(c.root.querySelector('[data-field="inventoryText"]').value, '');
  assert.equal(c.root.querySelector('[data-summary]'), null);
});

test('host deactivation clears review and a late file read cannot restore inputs after reactivation', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  let finishRead;
  const pending = new Promise(resolve => { finishRead = resolve; });
  act(() => Simulate.change(c.root.querySelectorAll('input[type="file"]')[1], { target: { files: [{ size: 32, text: () => pending }], value: 'mock-file' } }));
  c.render({ active: false }); assert.equal(c.root.querySelector('textarea'), null);
  c.render({ active: true });
  await act(async () => { finishRead('late file must not reappear'); await pending; });
  assert.equal(c.root.querySelector('[data-field="trafficText"]').value, '');
  assert.equal(c.root.querySelector('[data-summary]'), null);
});

test('host language changes keep current review, while page remount starts empty', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  c.render({ locale: 'en-US' }); assert.match(c.root.textContent, /3 candidate policies, 4 rules/);
  assert.equal(c.root.querySelector('[data-rivetin-policy-workpage]').lang, 'en-US');
  c.unmount(); c.render(); assert.equal(c.root.querySelector('[data-summary]'), null);
  assert.equal(c.win.localStorage.length, 0);
});

test('dirty reports only booleans and clearing, cancellation and discard do not save configuration', async t => {
  const changes = [], controller = new AbortController();
  const c = await setup(t, { signal: controller.signal, onDirtyChange: value => changes.push(value) });
  assert.deepEqual(changes, [false]);
  act(() => { c.plugin.store.update({ labelKey: 'draft-only' }); });
  assert.deepEqual(changes, [false]);
  act(() => { c.plugin.store.discard(); });
  c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  assert.deepEqual(changes, [false, true]);
  // A cancelled host leave keeps the same signal and mounted component.
  c.render(); assert.ok(c.root.querySelector('[data-summary]')); assert.equal(controller.signal.aborted, false);
  c.click('[data-action="clear"]'); assert.deepEqual(changes, [false, true, false]);
  c.click('[data-action="sample"]');
  act(() => controller.abort());
  assert.equal(changes.at(-1), false); assert.equal(c.root.querySelector('textarea'), null);
  c.render({ active: true }); assert.equal(c.root.querySelector('textarea'), null);
  assert.equal(c.stats().writes, 0); assert.equal(c.stats().network, 0);
});

test('pending import is dirty even on an empty page and abort rejects its late completion', async t => {
  const changes = [], controller = new AbortController();
  const c = await setup(t, { signal: controller.signal, onDirtyChange: value => changes.push(value) });
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  act(() => Simulate.change(c.root.querySelector('input[type="file"]'), { target: { files: [{ size: 2, text: () => pending }], value: 'mock-file' } }));
  assert.equal(changes.at(-1), true);
  act(() => controller.abort()); assert.equal(changes.at(-1), false);
  c.render({ signal: new AbortController().signal });
  await act(async () => { complete('[]'); await pending; });
  assert.equal(c.root.querySelector('[data-field="inventoryText"]').value, '');
  assert.equal(changes.at(-1), false);
});

test('replacing the host signal clears data and detaches the old abort listener', async t => {
  const oldController = new AbortController(), newController = new AbortController();
  const c = await setup(t, { signal: oldController.signal });
  c.click('[data-action="sample"]'); c.render({ signal: newController.signal });
  assert.equal(c.root.querySelector('[data-field="inventoryText"]').value, '');
  c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  act(() => oldController.abort()); assert.ok(c.root.querySelector('[data-summary]'));
  act(() => newController.abort()); assert.equal(c.root.querySelector('textarea'), null);
});

test('already aborted signal never activates and deactivation or unmount clears dirty without approval', async t => {
  const controller = new AbortController(); controller.abort();
  const changes = [], c = await setup(t, { signal: controller.signal, onDirtyChange: value => changes.push(value) });
  assert.equal(c.root.querySelector('textarea'), null); assert.deepEqual(changes, [false]);
  c.render({ signal: new AbortController().signal }); c.click('[data-action="sample"]');
  c.render({ active: false }); assert.equal(changes.at(-1), false);
  c.render({ active: true }); c.click('[data-action="sample"]'); c.unmount();
  assert.equal(changes.at(-1), false); assert.equal(c.stats().writes, 0);
});

test('workpage copy describes discard and cancel rather than closing the unrelated settings panel', async t => {
  const c = await setup(t);
  assert.equal(c.root.querySelector('h2').textContent, '安全策略转换');
  assert.match(c.root.textContent, /丢弃并退出/); assert.match(c.root.textContent, /取消离开会保留/);
  assert.doesNotMatch(c.root.textContent, /关闭插件面板/);
  c.mountSettings(); assert.match(c.settings.textContent, /关闭插件面板/);
  assert.equal(c.settings.querySelector('h2').textContent, '安全策略自动转化工具');
  c.render({ locale: 'en-US' });
  assert.match(c.root.textContent, /discarding this workpage/); assert.match(c.root.textContent, /Cancelling navigation keeps it/);
  assert.doesNotMatch(c.root.textContent, /when the panel closes/);
});
