import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from '../../../framework/node_modules/jsdom/lib/api.js';
import { configuration, defaults, validate } from '../src/configuration.js';
import createPlugin from '../src/definition.js';
import { readFile } from 'node:fs/promises';
import { checkCompatibility } from '../../../framework/server/compatibility.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const React = require('react'), ReactDOM = require('react-dom'), { act } = require('react-dom/test-utils');
test('channel configuration defaults off and rejects credential or arbitrary command fields', () => {
  assert.deepEqual(defaults(), { version: 1, enabled: false });
  assert.throws(() => validate({ version: 1, enabled: false, password: 'EXAMPLE_NOT_A_PASSWORD' }), /INVALID_SETTINGS/);
  assert.throws(() => validate({ version: 1, enabled: true, command: 'EXAMPLE_NOT_A_COMMAND' }), /INVALID_SETTINGS/);
  assert.equal(configuration.id, 'rivetin-ssh-channel');
});

test('structured compatibility accepts only the declared framework range and Tower build without granting execution', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  const context = { towerBuild: '4.9.0', frameworkApi: 1, frameworkVersion: '0.2.0' };
  assert.equal(checkCompatibility(manifest, context).compatible, true);
  for (const patch of [{ frameworkVersion: '0.1.5' }, { frameworkVersion: '0.3.0' }, { towerBuild: '4.9.1' }, { towerBuild: null }, { frameworkApi: 2 }]) assert.equal(checkCompatibility(manifest, { ...context, ...patch }).compatible, false);
  assert.equal(manifest.configuration.defaults.enabled, false); assert.deepEqual(manifest.permissions, []); assert.equal(manifest.ssh, undefined);
});
test('settings use the framework draft store and activation does not connect to hosts', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://tower.example.invalid' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  let saves = 0, fetches = 0;
  dom.window.fetch = () => { fetches++; throw new Error('UNEXPECTED_CONNECTION'); };
  const backend = { load: async () => ({ revision: 0, updatedAt: null, settings: defaults() }), save: async settings => { saves++; return { revision: saves, updatedAt: null, settings }; } };
  const plugin = createPlugin({ React, win: dom.window, options: { configurationBackend: () => backend } });
  await plugin.store.load();
  const root = document.getElementById('root');
  try {
    const stop = plugin.activate();
    await act(async () => ReactDOM.render(React.createElement(plugin.Settings, { preferences: plugin.store.get(), locale: 'zh-CN' }), root));
    assert.equal(document.querySelector('input').checked, false);
    await act(async () => document.querySelector('input').click());
    assert.equal(plugin.store.status().dirty, true); assert.equal(saves, 0);
    await plugin.store.save(); assert.equal(saves, 1); assert.equal(fetches, 0);
    stop(); assert.equal(fetches, 0);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); plugin.store.dispose(); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});
