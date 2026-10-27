import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bmcUrl, currentHostId } from '../src/target.js';
import { createPreferenceStore, STORAGE_KEY } from '../src/preferences.js';
import { installIpmiEnhancer } from '../src/dom-enhancer.js';
import { installMenuEntry } from '../src/menu-bridge.js';

const field = (label, ip) => `<div class="field"><div class="copy-icon-wrapper"><span class="copy-content">${ip}</span><button class="copy">copy</button></div><label>${label}</label></div>`;
function fixture(html = field('IPMI IP', '203.0.113.21')) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: 'https://tower.example.invalid/#/hosts/host-one?view=%22detail%22', pretendToBeVisual: true });
  const store = createPreferenceStore(dom.window);
  const stop = installIpmiEnhancer({ win: dom.window, store });
  return { win: dom.window, doc: dom.window.document, store, stop, close() { stop(); store.dispose(); dom.window.close(); } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 55));

test('only explicit IP literals become HTTPS targets', () => {
  assert.equal(bmcUrl('203.0.113.21'), 'https://203.0.113.21/');
  assert.equal(bmcUrl('2001:db8::1'), 'https://[2001:db8::1]/');
  for (const ip of ['javascript:alert(1)', 'user@203.0.113.21', '203.0.113.256', '0192.0.2.1', 'example.com', '192.0.2.1/path', ' 192.0.2.1']) assert.equal(bmcUrl(ip), null);
  assert.equal(currentHostId({ hash: '#/hosts/abc?view=%22detail%22' }), 'abc');
  assert.equal(currentHostId({ hash: '#/hosts/abc?view=%22vms%22' }), null);
  assert.equal(currentHostId({ hash: '#/clusters/abc' }), null);
});
test('enhances only IPMI, preserves copy behavior, and restores on disable', async () => {
  const f = fixture(field('管理 IP', '192.0.2.21') + field('IPMI IP', '203.0.113.21'));
  try {
    let copied = 0; f.doc.querySelectorAll('.copy')[1].addEventListener('click', () => copied++);
    await settle(); const a = f.doc.querySelector('a.c89-ipmi-link');
    assert.equal(a.href, 'https://203.0.113.21/'); assert.equal(a.target, '_blank');
    assert.equal(f.doc.querySelectorAll('a').length, 1);
    f.doc.querySelectorAll('.copy')[1].click(); assert.equal(copied, 1);
    f.store.update({ ipmiEnabled: false }); await settle();
    assert.equal(f.doc.querySelector('a'), null); assert.equal(f.doc.querySelectorAll('.copy-content')[1].textContent, '203.0.113.21');
  } finally { f.close(); }
});
test('React-like text replacement and host navigation do not retain stale IP', async () => {
  const f = fixture();
  try {
    await settle(); f.win.location.hash = '/hosts/host-two?view=%22detail%22';
    f.doc.querySelector('.copy-content').textContent = '203.0.113.22'; await settle();
    assert.equal(f.doc.querySelector('a').href, 'https://203.0.113.22/');
    f.win.location.hash = '/clusters/cluster-one'; await settle(); assert.equal(f.doc.querySelector('a'), null);
    assert.equal(f.doc.querySelector('.copy-content').textContent, '203.0.113.22');
  } finally { f.close(); }
});
test('ambiguous fields, dialogs, and invalid addresses fail closed', async () => {
  for (const html of [field('IPMI IP', '203.0.113.21') + field('IPMI IP', '203.0.113.22'), `<form>${field('IPMI IP', '203.0.113.21')}</form>`, field('IPMI IP', 'javascript:alert(1)')]) {
    const f = fixture(html); try { await settle(); assert.equal(f.doc.querySelector('a'), null); } finally { f.close(); }
  }
});
test('Chinese label and teardown are supported without duplicate anchors', async () => {
  const f = fixture(field('IPMI 地址', '203.0.113.21'));
  try {
    await settle(); f.doc.body.append(f.doc.createElement('div')); await settle();
    assert.equal(f.doc.querySelectorAll('a').length, 1);
    f.stop(); assert.equal(f.doc.querySelector('a'), null);
    assert.equal(f.doc.querySelector('.copy-content').textContent, '203.0.113.21');
  } finally { f.close(); }
});
test('only personal preferences persist locally and synchronize storage events', () => {
  const dom = new JSDOM('', { url: 'https://tower.example.invalid/' });
  const store = createPreferenceStore(dom.window);
  store.update({ showFloatingButton: false, password: 'DO_NOT_STORE', token: 'DO_NOT_STORE' });
  const serialized = dom.window.localStorage.getItem(STORAGE_KEY);
  assert.equal(JSON.parse(serialized).showFloatingButton, false); assert.ok(!serialized.includes('DO_NOT_STORE'));
  assert.deepEqual(Object.keys(JSON.parse(serialized)), ['version', 'showFloatingButton']);
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify({ showFloatingButton: true, ipmiEnabled: false }) }));
  assert.equal(store.get().showFloatingButton, true);
  assert.equal(store.get().ipmiEnabled, true);
  store.dispose(); dom.window.close();
});
test('menu entry appears once after Labels and survives menu recreation', async () => {
  const dom = new JSDOM('<body><div id="menu"><button>系统配置</button><button><span>标签管理</span></button></div></body>');
  let opened = 0;
  const stop = installMenuEntry({ win: dom.window, onOpen: () => opened++ });
  try {
    await Promise.resolve(); assert.equal(dom.window.document.querySelectorAll('[data-c89-menu-entry]').length, 1);
    dom.window.document.querySelector('[data-c89-menu-entry]').click(); assert.equal(opened, 1);
    dom.window.document.getElementById('menu').innerHTML = '<button>System settings</button><button>Label management</button>';
    await settle(); assert.equal(dom.window.document.querySelectorAll('[data-c89-menu-entry]').length, 1);
    stop(); assert.equal(dom.window.document.querySelector('[data-c89-menu-entry]'), null);
  } finally { stop(); dom.window.close(); }
});
test('supports the actual Tower menu-group-item div structure without modifying sibling items', () => {
  const dom = new JSDOM('<body><div class="menu-group"><div class="menu-group-title">设置</div><div class="menu-group-item"><span><img alt="Settings"></span><div>系统配置</div></div><div class="menu-group-item"><span><img alt="Tag"></span><div>标签管理</div></div></div></body>');
  let status;
  const stop = installMenuEntry({ win: dom.window, onOpen() {}, onStatus(value) { status = value; } });
  try {
    const entry = dom.window.document.querySelector('[data-c89-menu-entry]');
    assert.equal(entry.previousElementSibling.textContent, '标签管理'); assert.equal(status, 'ready');
    assert.equal(dom.window.document.querySelectorAll('.menu-group-item:not([data-c89-menu-entry])').length, 2);
  } finally { stop(); dom.window.close(); }
});
test('stale host link cannot navigate during the interval before a route rescan', async () => {
  const f = fixture();
  try {
    await settle(); const anchor = f.doc.querySelector('a');
    f.win.location.hash = '/hosts/host-two?view=%22detail%22';
    const click = new f.win.MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click); assert.equal(click.defaultPrevented, true);
  } finally { f.close(); }
});
