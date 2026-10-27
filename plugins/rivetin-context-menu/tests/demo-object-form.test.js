import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const webpack = require('webpack');
const { JSDOM } = require('jsdom');

async function compileActualDemo() {
  const outputPath = path.join(root, 'qa', 'demo-form-memory-output'), filename = 'demo-object-form.js', files = new Map();
  const compiler = webpack({
    context: root, mode: 'development', entry: './demo/bootstrap.js', devtool: false, cache: false,
    output: { path: outputPath, filename }, optimization: { splitChunks: false, runtimeChunk: false },
    externalsType: 'window', externals: { react: '__TEST_REACT__', 'react-dom': '__TEST_REACT_DOM__' },
    performance: { hints: false },
  });
  // Compile the actual source, including its JSON/module imports, without writing build output.
  compiler.outputFileSystem = {
    mkdir(...args) { args.at(-1)(null); },
    writeFile(file, bytes, ...args) { files.set(file, Buffer.from(bytes)); args.at(-1)(null); },
    readFile(file, callback) { const value = files.get(file); if (value) callback(null, value); else { const error = new Error('Not found'); error.code = 'ENOENT'; callback(error); } },
    stat(file, callback) { const error = new Error('Not found'); error.code = 'ENOENT'; callback(error); },
    join: path.join,
  };
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    const result = files.get(path.join(outputPath, filename)); assert.ok(result, 'the actual demo bundle must be emitted to memory');
    return result.toString('utf8');
  } finally { await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve())); }
}

test('actual React 16 demo form accepts select/text changes and preserves snapshot/name confirmation gates', { timeout: 20000 }, async t => {
  const bundle = await compileActualDemo();
  const dom = new JSDOM('<!doctype html><div id="demo-root"></div>', {
    url: 'https://demo.example.invalid/#/clusters/demo-cluster?view=%22vms%22', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const win = dom.window, doc = win.document, originals = new Map(), failures = [];
  // Use React 16's timer scheduler in Node: its browser branch would retain Node MessagePorts after jsdom closes.
  for (const [key, value] of Object.entries({ window: win, document: doc, navigator: win.navigator, HTMLElement: win.HTMLElement, Node: win.Node, MessageChannel: undefined })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 180, height: 100 }]; };
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 40, top: 50, width: 180, height: 100, right: 220, bottom: 150 });
  win.addEventListener('error', event => { failures.push(event.error || new Error(event.message)); event.preventDefault(); });
  // ReactDOM and test utilities deliberately share the exact React instance used by the real App.
  const React = require('react'), ReactDOM = require('react-dom'), { act } = require('react-dom/test-utils');
  assert.match(React.version, /^16\./); win.__TEST_REACT__ = React; win.__TEST_REACT_DOM__ = ReactDOM;
  const consoleErrors = [];
  t.mock.method(console, 'error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  async function flush(action = () => {}) { await act(async () => { action(); await tick(); await tick(); }); }
  function change(element, value) {
    const prototype = element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new win.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }
  const dialog = () => doc.querySelector('[role="dialog"][aria-label="对象操作预览"]');
  const field = name => {
    const label = [...dialog().querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === name);
    assert.ok(label, `field ${name} must be present`); return label.querySelector('select,input');
  };
  const confirm = () => [...dialog().querySelectorAll('button')].find(button => button.textContent === '确认模拟操作');
  async function openSnapshotAction(id) {
    const source = doc.querySelector('tr[data-row-key="ubuntu-demo"] td[unique="name"]'); assert.ok(source);
    await flush(() => source.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 100 })));
    const group = doc.querySelector('[data-group-id="vm.snapshots"]'); assert.ok(group, 'the real VM object menu must be active');
    await flush(() => group.click());
    const action = doc.querySelector(`[data-action-id="${id}"]`); assert.ok(action); assert.equal(action.disabled, false);
    await flush(() => action.click()); assert.ok(dialog(), 'the real App must render the requested form');
  }
  function assertHealthy() {
    assert.equal(failures.length, 0, failures.map(value => value.stack || String(value)).join('\n'));
    assert.ok(doc.querySelector('#demo-root').childElementCount, 'the app must remain mounted');
    assert.ok(!consoleErrors.some(value => /Cannot read properties of null|synthetic event is reused/i.test(value)), consoleErrors.join('\n'));
  }
  try {
    await flush(() => win.eval(bundle));
    assert.ok(doc.querySelector('[aria-label="Demo VM state"]'));
    await flush(() => change(doc.querySelector('[aria-label="Demo VM state"]'), 'STOPPED'));
    await openSnapshotAction('vm.snapshots.restore');
    assert.equal(confirm().disabled, true, 'missing snapshot and exact VM name must block confirmation');
    // Native events exercise React's real pooled SyntheticEvents; Simulate.change persists events and would miss the regression.
    await flush(() => ReactDOM.unstable_batchedUpdates(() => {
      change(field('选择快照'), 'snapshot-demo-baseline');
      change(field('输入虚拟机名称以确认'), 'Wrong VM name');
    }));
    assertHealthy(); assert.equal(field('选择快照').value, 'snapshot-demo-baseline');
    assert.equal(field('输入虚拟机名称以确认').value, 'Wrong VM name'); assert.equal(confirm().disabled, true);
    await flush(() => change(field('输入虚拟机名称以确认'), 'Ubuntu demo')); assertHealthy(); assert.equal(confirm().disabled, false);
    await flush(() => change(field('选择快照'), '')); assert.equal(confirm().disabled, true, 'the exact name alone must not bypass snapshot selection');
    await flush(() => change(field('选择快照'), 'snapshot-demo-change')); assert.equal(confirm().disabled, false);
    await flush(() => change(field('输入虚拟机名称以确认'), 'ubuntu demo')); assert.equal(confirm().disabled, true, 'confirmation is case-sensitive');
    await flush(() => [...dialog().querySelectorAll('button')].find(button => button.textContent === '取消').click());
    await openSnapshotAction('vm.snapshots.create'); assert.equal(confirm().disabled, true, 'snapshot name is required');
    await flush(() => ReactDOM.unstable_batchedUpdates(() => {
      change(field('快照名称'), 'Checkpoint from native input');
      change(field('描述'), 'Description from a second pooled event');
    }));
    assertHealthy(); assert.equal(field('快照名称').value, 'Checkpoint from native input');
    assert.equal(field('描述').value, 'Description from a second pooled event'); assert.equal(confirm().disabled, false);
    await flush(() => change(field('快照名称'), '   ')); assert.equal(confirm().disabled, true, 'blank names remain invalid');
    assertHealthy(); assert.ok(!win.location.hash.includes('sidebar'), 'object preview forms must not open the native sidebar');
  } finally {
    win.dispatchEvent(new win.Event('pagehide')); act(() => ReactDOM.unmountComponentAtNode(doc.querySelector('#demo-root'))); dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
