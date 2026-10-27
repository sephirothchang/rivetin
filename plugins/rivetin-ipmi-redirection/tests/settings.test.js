import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import { JSDOM } from 'jsdom';
import { BmcSettings } from '../src/bmc-settings.js';
import { createPreferenceStore } from '../src/preferences.js';

test('new exceptions default to cluster with matching object choices; catalog filtering does not change preferences', () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/#/hosts/host-a?view=%22detail%22' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const store = createPreferenceStore(dom.window), app = document.getElementById('app');
  const inventory = { loaded: true, hosts: [{ id: 'host-a', name: 'EXAMPLE_HOST' }], clusters: [{ id: 'cluster-a', name: 'EXAMPLE_CLUSTER' }] };
  const render = () => ReactDOM.render(React.createElement(BmcSettings, { preferences: store.get(), store, inventory }), app);
  const unsub = store.subscribe(render);
  try {
    render(); app.querySelector('.c89-add-rule').click();
    for (const select of app.querySelectorAll('#c89-default-vendor, [aria-label="例外 1 厂商协议"]')) {
      assert.equal(select.options[0].value, 'generic');
      assert.equal(select.options[1].disabled, true);
      assert.equal(select.options[2].value, 'ami-megarac');
    }
    assert.equal(store.get().bmcExceptions[0].scope, 'cluster');
    assert.equal(store.get().bmcExceptions[0].vendor, 'generic');
    assert.equal(app.querySelector('[aria-label="例外 1 对象"]').textContent, '选择集群EXAMPLE_CLUSTER');
    const before = JSON.stringify(store.get()), filter = app.querySelector('#c89-catalog-vendor');
    filter.value = 'h3c-hdm'; filter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(app.querySelectorAll('.c89-catalog li').length, 14);
    assert.equal(JSON.stringify(store.get()), before);
    assert.equal(app.querySelector('.c89-remove-rule').textContent, '');
    assert.equal(app.querySelector('.c89-remove-rule svg').getAttribute('stroke'), 'currentColor');
  } finally {
    unsub(); ReactDOM.unmountComponentAtNode(app); store.dispose(); dom.window.close();
    delete globalThis.window; delete globalThis.document;
  }
});
