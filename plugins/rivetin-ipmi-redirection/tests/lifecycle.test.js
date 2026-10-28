import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createIpmiPlugin from '../src/definition.js';
import { sanitizeFunctionalSettings } from '../src/configuration.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);

test('reactivation retries inventory after a stopped request completes, and ignores older activation results', async () => {
  for (const finishBeforeRestart of [true, false]) {
    const dom = new JSDOM('<body></body>', { url: 'https://tower.example.invalid/', pretendToBeVisual: true });
    const first = deferred(), second = deferred(); let reads = 0, updates = 0;
    const plugin = createIpmiPlugin({ win: dom.window, options: {
      configurationBackend: () => ({ load: async () => ({ revision: 0, updatedAt: null, settings: sanitizeFunctionalSettings() }) }),
      inventoryProvider: () => (++reads === 1 ? first.promise : second.promise),
    } });
    dom.window.addEventListener('c89:inventory-updated', () => updates++);
    let stop;
    try {
      await plugin.store.load(); stop = plugin.activate(); stop();
      const stale = { hosts: [], clusters: [{ id: 'stale-cluster', name: 'Stale' }] };
      if (finishBeforeRestart) { first.resolve(stale); await flush(); }
      stop = plugin.activate();
      assert.equal(reads, 2, 'a new activation must start a new inventory request');
      if (!finishBeforeRestart) { first.resolve(stale); await flush(); }
      assert.equal(updates, 0, 'previous activation must not publish inventory');
      second.resolve({ hosts: [], clusters: [{ id: 'current-cluster', name: 'Current' }] }); await flush();
      assert.equal(updates, 1);
      assert.deepEqual(plugin.store.getDraft().seededClusterIds, ['current-cluster']);
    } finally { stop?.(); plugin.store.dispose(); dom.window.close(); }
  }
});

test('a host missing from the loaded inventory cannot authorize global simulated login over cluster rules', async () => {
  const dom = new JSDOM('<body><div><div class="copy-icon-wrapper"><span class="copy-content">203.0.113.21</span></div><label>IPMI IP</label></div></body>', {
    url: 'https://tower.example.invalid/#/hosts/missing-host', pretendToBeVisual: true,
  });
  let launches = 0;
  const settings = sanitizeFunctionalSettings({ loginMode: 'megarac', defaultVendor: 'ami-megarac',
    bmcExceptions: [{ id: 'cluster-rule', scope: 'cluster', targetId: 'known-cluster', vendor: 'generic' }],
  });
  const plugin = createIpmiPlugin({ win: dom.window, options: {
    configurationBackend: () => ({ load: async () => ({ revision: 1, updatedAt: null, settings }) }),
    inventoryProvider: async () => ({ hosts: [], clusters: [] }),
    requestLaunch: async () => { launches++; return 'https://gateway.example.invalid/launch/example'; },
  } });
  let stop;
  try {
    await plugin.store.load(); stop = plugin.activate();
    await new Promise(resolve => setTimeout(resolve, 55));
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    dom.window.document.querySelector('a').addEventListener('click', value => value.preventDefault());
    dom.window.document.querySelector('a').dispatchEvent(event);
    await flush(); assert.equal(launches, 0);
  } finally { stop?.(); plugin.store.dispose(); dom.window.close(); }
});
