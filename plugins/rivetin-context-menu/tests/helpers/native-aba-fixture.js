import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import createPlugin from '../../src/definition.js';
import { installAbaHost } from '../../demo/aba-host.js';
import { defaults } from '../../src/configuration.js';
import { createNativeActionProvider } from '../../src/native/provider.js';
const require = createRequire(new URL('../../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom'), React = require('react');

export async function createFixture(factory = createPlugin, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://tower.example.invalid/' + (options.base || '#/vms/'), runScripts: 'outside-only' });
  const win = dom.window, doc = win.document, errors = [];
  win.HTMLElement.prototype.getClientRects = () => [{ width: 180, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 310, height: 450, right: 320, bottom: 460 });
  const host = installAbaHost(win, options);
  let transport = 0; win.fetch = () => { transport++; throw Error('NO_LIVE_TRANSPORT'); };
  const getLocale = () => options.locale || 'zh-CN';
  const plugin = factory({ React, win, history: host.history, getLocale,
    ...(options.providerTimeoutMs ? { actionProvider: createNativeActionProvider({ win, history: host.history, getLocale, timeoutMs: options.providerTimeoutMs, onError: message => errors.push(message) }) } : {}),
    options: { configurationBackend: () => ({ load: async () => ({ settings: defaults(), revision: 0, updatedAt: null }) }) } });
  await plugin.store.load(); const stop = plugin.activate(message => errors.push(message));
  const pause = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  async function until(check, timeout = 6500) { const deadline = Date.now() + timeout; while (!check() && Date.now() < deadline) await pause(10); return check(); }
  async function cpu() {
    const source = doc.querySelector('tr[data-row-key="vm-a"] td[unique="name"]');
    source.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    assert.ok(await until(() => doc.querySelector('[data-rivetin-object-menu]'), 1000));
    doc.querySelector('[data-group-id="vm.hardware"]').click();
    assert.ok(await until(() => doc.querySelector('[data-action-id="vm.hardware.cpu"]'), 1000));
    doc.querySelector('[data-action-id="vm.hardware.cpu"]').click();
    await until(() => doc.querySelector('.ant-modal') || errors.length, options.providerTimeoutMs ? options.providerTimeoutMs + 500 : 6500);
  }
  return { win, doc, host, errors, cpu, until, get transport() { return transport; },
    dispose() { stop(); plugin.store.dispose(); host.stop(); win.close(); } };
}
