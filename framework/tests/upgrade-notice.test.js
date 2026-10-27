import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installUpgradeNotice } from '../src/upgrade-notice.js';
const selector = '[data-rivetin-upgrade-notice]';
const tick = () => new Promise(setImmediate);
function fixture(t, html = '<main class="upgrade-center"><h1>CloudTower 升级</h1><button id="native-upgrade">上传升级包</button></main>') {
  const dom = new JSDOM(html, { url: 'https://tower.example.invalid/#/upgrade-center', pretendToBeVisual: true });
  let state = { enabled: true, plugins: [{ id: 'rivetin-example', installed: true, enabled: true }] }, locale = 'zh-CN', opens = 0;
  const stop = installUpgradeNotice({ win: dom.window, getState: () => state, getLocale: () => locale, onOpen: () => { opens++; } });
  t.after(() => { stop(); dom.window.close(); });
  return { dom, document: dom.window.document, stop, state: value => { state = value; }, locale: value => { locale = value; }, opens: () => opens };
}
test('upgrade reminder is adjacent to a recognized heading and only its own button opens Plugin Center', t => {
  const { document, opens } = fixture(t);
  const notice = document.querySelector(selector), title = document.querySelector('h1');
  assert.equal(title.nextElementSibling, notice);
  assert.match(notice.textContent, /确认插件框架及子插件与目标版本兼容/);
  assert.equal(document.getElementById('native-upgrade').textContent, '上传升级包');
  notice.querySelector('button').click(); assert.equal(opens(), 1);
  assert.equal(document.getElementById('native-upgrade').disabled, false);
});
test('framework disabled or no installed enabled/active plugins removes the notice and all owned styles', t => {
  const { document, stop, state } = fixture(t);
  for (const next of [{ enabled: false, plugins: [{ installed: true, enabled: true }] }, { enabled: true, plugins: [{ installed: false, enabled: true }] }, { enabled: true, plugins: [{ installed: true, enabled: false, active: false }] }]) {
    state(next); stop.update();
    assert.equal(document.querySelector(selector), null); assert.equal(document.querySelector('[data-rivetin-upgrade-notice-style]'), null);
  }
  state({ enabled: true, plugins: [{ installed: true, active: true }] }); assert.equal(stop.update(), true);
});
test('route changes clear the notice and returning to the supported route restores it', async t => {
  const { dom, document } = fixture(t);
  dom.window.location.hash = '#/hosts/example-host'; dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange')); await tick();
  assert.equal(document.querySelector(selector), null);
  dom.window.location.hash = '#/upgrade-center?view=overview'; dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange')); await tick();
  assert.ok(document.querySelector(selector));
});
test('unknown or ambiguous page headings do not inject into native UI', t => {
  const { document, stop } = fixture(t, '<main><h1>上传升级包</h1><button>开始升级</button></main>');
  assert.equal(document.querySelector(selector), null); assert.equal(stop.update(), false);
  document.querySelector('main').innerHTML = '<h1>CloudTower Upgrade</h1><h2>CloudTower 升级</h2>';
  assert.equal(stop.update(), false); assert.equal(document.querySelector(selector), null);
});
test('locale update follows the host, repeated observations remain idempotent and cleanup prevents reinsertion', async t => {
  const { document, stop, locale } = fixture(t);
  locale('en-US'); stop.update();
  assert.match(document.querySelector(selector).textContent, /Before upgrading CloudTower/);
  for (let i = 0; i < 12; i++) { document.querySelector('main').append(document.createTextNode(' ')); stop.update(); }
  await tick(); await tick();
  assert.equal(document.querySelectorAll(selector).length, 1); assert.equal(document.querySelectorAll('[data-rivetin-upgrade-notice-style]').length, 1);
  stop(); stop();
  document.querySelector('main').append(document.createElement('p')); await tick();
  assert.equal(document.querySelector(selector), null); assert.equal(stop.update(), false);
});
test('two installations do not duplicate the reminder or remove another owner during cleanup', async t => {
  const { dom, document, stop } = fixture(t);
  const second = installUpgradeNotice({ win: dom.window, getState: () => ({ enabled: true, plugins: [{ installed: true, enabled: true }] }), onOpen() {} });
  assert.equal(document.querySelectorAll(selector).length, 1);
  second(); assert.ok(document.querySelector(selector));
  stop(); await tick(); assert.equal(document.querySelector(selector), null);
});
test('missing or throwing runtime state fails closed', t => {
  const { dom, document, stop } = fixture(t);
  stop();
  const broken = installUpgradeNotice({ win: dom.window, getState() { throw new Error('UNAVAILABLE'); } });
  assert.equal(document.querySelector(selector), null); broken();
});
test('observed div.title shape is recognized while global navigation and plugin headings are excluded', t => {
  const { document } = fixture(t, '<div class="global-header"><div class="title">升级中心</div></div><nav>升级中心</nav><div class="example-toolbar" style="display:flex"><div class="title example-title-hash">升级中心</div><button id="upload">上传升级包</button><button id="settings">设置</button></div><div class="c89-plugin-root"><div class="title">升级中心</div></div>');
  const title = document.querySelector('.example-title-hash'), upload = document.getElementById('upload'), settings = document.getElementById('settings');
  assert.equal(title.nextElementSibling, document.querySelector(selector));
  assert.deepEqual([...document.querySelector('.example-toolbar').querySelectorAll('button:not(.pk-upgrade-notice button)')].map(button => button.id), ['upload', 'settings']);
  let actions = 0; upload.addEventListener('click', () => { actions++; }); settings.addEventListener('click', () => { actions++; });
  upload.click(); settings.click(); assert.equal(actions, 2);
  assert.equal(document.querySelectorAll(selector).length, 1);
});
