import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { nativeErrorMessage } from '../src/native/errors.js';
import { createNativeActionProvider } from '../src/native/provider.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');

test('known failures include distinct actionable Chinese and English reasons without old placeholders', () => {
  const codes = ['provider-unavailable', 'action-unknown', 'plugin-disabled', 'source-changed', 'source-retired', 'proof-expired', 'blocked-by-dialog', 'navigation-unavailable', 'target-timeout', 'target-mismatch', 'trigger-missing', 'trigger-ambiguous', 'popup-unproven', 'popup-timeout', 'entry-missing', 'entry-disabled', 'entry-ambiguous', 'menu-empty', 'menu-ambiguous', 'menu-changed', 'depth-limit', 'surface-timeout', 'activation-expired', 'cancelled', 'unexpected'];
  const zh = codes.map(code => nativeErrorMessage(code)), en = codes.map(code => nativeErrorMessage(code, 'en-US'));
  assert.equal(new Set(zh).size, codes.length); assert.equal(new Set(en).size, codes.length);
  for (const message of [...zh, ...en]) assert.doesNotMatch(message, /尚未接入|待接入|尚无已验证|not connected/i);
  assert.match(nativeErrorMessage('source-retired'), /请重新打开对象详情后重试/);
  assert.match(nativeErrorMessage('entry-disabled'), /CloudTower 当前禁用/);
  assert.doesNotMatch(nativeErrorMessage('entry-disabled'), /没有权限|无权|授权不足/);
});
test('unknown exception values cannot inject paths, HTML, credentials or raw errors into UI', () => {
  const values = ['secret-token-value', '<script>bad</script>', 'C:\\private\\credentials.json', { toString() { throw Error('unsafe conversion'); } }, '__proto__', null, undefined];
  for (const reason of values) assert.equal(nativeErrorMessage(reason), nativeErrorMessage('unexpected'));
});
function fixture(t) {
  const dom = new JSDOM('<aside class="drawer-content-inner frame" data-resource-id="vm-demo"><div class="title-wrapper"><span class="header-title">Demo VM</span></div><div>基本信息<span class="extra-action"><button class="edit-icon">编辑</button></span></div></aside>', { url: 'https://tower.example.invalid/#/vms/vm-demo?view=%22detail%22' });
  const win = dom.window, doc = win.document, errors = [];
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  let clicks = 0; doc.querySelector('.edit-icon').onclick = () => clicks++;
  const provider = createNativeActionProvider({ win, timeoutMs: 80, onError: e => errors.push(e) });
  const resource = { type: 'vm', id: 'vm-demo' };
  const request = id => { provider.bindSource(doc.querySelector('.header-title')); return { resource, actionId: id, data: provider.read(resource) }; };
  t.after(() => { provider.stop(); win.close(); }); return { doc, provider, request, errors, clicks: () => clicks };
}
test('disabled, missing and duplicate native controls return separate reasons without leaf clicks', async t => {
  const f = fixture(t), button = f.doc.querySelector('.edit-icon');
  button.disabled = true; assert.equal((await f.provider.open(f.request('vm.hardware.cpu'))).reason, 'entry-disabled');
  button.disabled = false; button.className = 'different'; assert.equal((await f.provider.open(f.request('vm.hardware.cpu'))).reason, 'entry-missing');
  button.className = 'edit-icon'; button.parentElement.append(button.cloneNode(true)); assert.equal((await f.provider.open(f.request('vm.hardware.cpu'))).reason, 'entry-ambiguous');
  assert.equal(f.clicks(), 0); assert.equal(f.errors.length, 3);
});
test('blocked dialog, expired proof and unknown operation fail with exact diagnostic stages', async t => {
  const f = fixture(t), request = f.request('vm.hardware.cpu');
  f.provider.bindSource(f.doc.querySelector('.header-title'));
  assert.equal((await f.provider.open(request)).reason, 'proof-expired');
  f.doc.body.insertAdjacentHTML('beforeend', '<section class="ant-modal">Existing dialog</section>');
  assert.equal((await f.provider.open(f.request('vm.hardware.cpu'))).reason, 'blocked-by-dialog');
  assert.equal((await f.provider.open(f.request('unregistered-operation'))).reason, 'action-unknown'); assert.equal(f.clicks(), 0);
});
test('a clicked native editor without its expected dialog reports uncertain surface, not unfinished implementation', async t => {
  const f = fixture(t), result = await f.provider.open(f.request('vm.hardware.cpu'));
  assert.equal(f.clicks(), 1); assert.equal(result.reason, 'surface-timeout'); assert.equal(result.reported, true);
  assert.match(f.errors[0], /避免重复操作/);
});
test('menu renderer source has no old unfinished-binding fallback text', async () => {
  const files = ['src/actions/menu.js', 'src/native/resource-menu.js', 'src/native/provider.js', 'src/actions/catalog.js', 'src/actions/provider.js'];
  for (const file of files) assert.doesNotMatch(await readFile(new URL('../' + file, import.meta.url), 'utf8'), /尚未接入|尚无已验证|not connected/i, file);
});

test('retired initial panel exposes its specific reopen-details reason in every disabled menu item', async t => {
  const f = fixture(t);
  f.provider.stop();
  const provider = createNativeActionProvider({ win: f.doc.defaultView });
  t.after(() => provider.stop());
  const resource = { type: 'vm', id: 'vm-demo' };
  assert.equal(provider.bindSource(f.doc.querySelector('.header-title')), false);
  const data = provider.read(resource);
  assert.equal(data.native.reason, 'source-retired');
  const items = provider.tree({ resource, data }).flatMap(group => group.items);
  assert.ok(items.length > 0);
  for (const item of items) { assert.equal(item.enabled, false); assert.match(item.reason, /请重新打开对象详情后重试/); }
  assert.equal((await provider.open({ resource, actionId: 'vm.hardware.cpu', data })).reason, 'source-retired');
  assert.equal(f.clicks(), 0);
});
