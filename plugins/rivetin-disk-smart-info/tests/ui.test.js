import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { installSmartInfo } from '../src/enhancer.js';
import { findDiskDetail, routeDisk } from '../src/detail-adapter.js';
import { createConfigurationStore } from '../../../framework/src/config-store.js';
import { configuration, defaults } from '../src/configuration.js';
import { createMockProvider, disks } from '../demo/fixtures.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const observedSidebar = await readFile(new URL('./fixtures/cloudtower-4.9-disk-sidebar.html', import.meta.url), 'utf8');
async function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><head></head><body><table><tbody><tr data-row-key="disk-demo-nvme"><td unique="path">/dev/nvme0n1</td></tr></tbody></table><aside class="drawer-content-inner"><div class="title-wrapper"><h2 class="header-title">/dev/nvme0n1</h2></div><div class="detail-tabs"><button class="tab-item">详情</button><button class="tab-item">监控</button></div><div class="detail-tab-content">Native details</div></aside></body></html>', { url: 'https://tower.example.invalid/' });
  const win = dom.window;
  if (options.html) { win.document.open(); win.document.write(options.html); win.document.close(); }
  const route = diskId => { win.location.hash = `/clusters/cluster-demo?${new URLSearchParams({ view: JSON.stringify('disks'), sidebar: JSON.stringify({ type: 'disk', id: diskId }) })}`; };
  route(disks[0].diskId);
  let saved = { revision: 0, updatedAt: null, settings: defaults() };
  const backend = { load: async () => structuredClone(saved), save: async settings => { saved = { revision: saved.revision + 1, updatedAt: new Date().toISOString(), settings }; return structuredClone(saved); } };
  const store = createConfigurationStore(win, backend, configuration); await store.load();
  let locale = 'zh-CN';
  const stop = installSmartInfo({ win, store, getLocale: () => locale, provider: options.provider === undefined ? createMockProvider() : options.provider, timeoutMs: options.timeoutMs || 8000,
    collectionTimeoutMs: options.collectionTimeoutMs || 500, collectionIntervalMs: 1 });
  t.after(() => { stop(); store.dispose(); win.close(); });
  return { win, store, stop, route, doc: win.document, locale(value) { locale = value; win.document.documentElement.lang = value; win.dispatchEvent(new win.Event('languagechange')); }, open() { win.document.querySelector('[data-pk-smart-tab]').click(); } };
}
test('cluster and host route fixtures require exact disk identity and matching visible path', async t => {
  const f = await fixture(t); assert.equal(routeDisk(f.win), disks[0].diskId); assert.ok(findDiskDetail(f.win));
  f.win.location.hash = f.win.location.hash.replace('/clusters/cluster-demo', '/hosts/host-demo'); assert.ok(findDiskDetail(f.win));
  f.doc.querySelector('.header-title').textContent = '/dev/other'; assert.equal(findDiskDetail(f.win), null);
  f.win.location.hash = '#/vms/vm-demo'; assert.equal(routeDisk(f.win), null);
});

test('observed Tower 4.9 cluster and host header-border-content shapes stay matched after mounting', async t => {
  const f = await fixture(t, { html: observedSidebar }), content = f.doc.querySelector('.tab-content');
  assert.equal(findDiskDetail(f.win).content, content);
  f.open(); await delay(); assert.ok(f.doc.querySelector('.pk-smart-table'));
  assert.equal(findDiskDetail(f.win).content, content); assert.equal(content.hidden, true);
  f.open(); await delay(); assert.equal(f.doc.querySelectorAll('[data-pk-smart-tab]').length, 1);
  f.win.location.hash = f.win.location.hash.replace('/clusters/cluster-demo', '/hosts/host-demo'); await delay();
  assert.equal(findDiskDetail(f.win).content, content); assert.equal(f.doc.querySelectorAll('[data-pk-smart-panel]').length, 1);
  assert.equal(f.doc.querySelectorAll('[data-pk-smart-style]').length, 1);
});

test('observed sidebar restores both original hidden states on native tab and idempotent stop', async t => {
  for (const hidden of [false, true]) {
    const html = hidden ? observedSidebar.replace('class="tab-content"', 'class="tab-content" hidden') : observedSidebar;
    const f = await fixture(t, { html }), content = f.doc.querySelector('.tab-content');
    assert.equal(content.hidden, hidden); f.open(); await delay(); assert.equal(content.hidden, true);
    f.doc.querySelector('.detail-tabs button:not([data-pk-smart-tab])').click();
    assert.equal(content.hidden, hidden); assert.equal(f.doc.querySelector('[data-pk-smart-panel]').hidden, true);
    assert.equal(f.doc.querySelector('[data-pk-smart-tab]').getAttribute('aria-selected'), 'false');
    f.open(); await delay(); f.stop(); f.stop(); assert.equal(content.hidden, hidden);
    assert.equal(f.doc.querySelectorAll('[data-pk-smart-tab],[data-pk-smart-panel],[data-pk-smart-style]').length, 0);
    f.doc.body.append(f.doc.createElement('div')); await delay(); assert.equal(f.doc.querySelector('[data-pk-smart-tab]'), null);
  }
});

test('observed sidebar rejects duplicate drawers, ambiguous contents and unknown header structures', async t => {
  const changes = [
    doc => doc.body.append(doc.querySelector('.drawer-content-inner').cloneNode(true)),
    doc => doc.querySelector('.detail-tabs').after(doc.querySelector('.detail-tabs').cloneNode(true)),
    doc => doc.querySelector('.tab-content').after(doc.querySelector('.tab-content').cloneNode(true)),
    doc => doc.querySelector('.tab-border-bottom').remove(),
    doc => doc.querySelector('.tab-border-bottom').before(doc.createElement('div')),
    doc => doc.querySelector('.tab-content').after(doc.createElement('div')),
    doc => { const tabs = doc.querySelector('.detail-tabs'), wrapper = doc.createElement('div'); tabs.before(wrapper); wrapper.append(tabs); },
    doc => { doc.querySelector('.tab-content').className = 'unknown-content'; },
  ];
  for (const change of changes) {
    const shape = new JSDOM(observedSidebar); change(shape.window.document); const html = shape.serialize(); shape.window.close();
    const f = await fixture(t, { html }); assert.equal(findDiskDetail(f.win), null);
    assert.equal(f.doc.querySelector('[data-pk-smart-tab]'), null); assert.equal(f.doc.querySelector('[data-pk-smart-panel]'), null);
  }
});

test('closing the observed drawer removes its UI and ignores pending responses', async t => {
  const provider = createMockProvider(), latest = provider.readLatest; let release, pendingSignal;
  provider.readLatest = args => { pendingSignal = args.signal; return new Promise(resolve => { release = async () => resolve(await latest({ ...args, signal: new AbortController().signal })); }); };
  const f = await fixture(t, { html: observedSidebar, provider }); f.open(); await delay(20); assert.ok(release);
  f.doc.querySelector('.drawer-content-inner').remove(); await delay(); assert.equal(pendingSignal.aborted, true);
  assert.equal(f.doc.querySelectorAll('[data-pk-smart-tab],[data-pk-smart-panel]').length, 0);
  assert.equal(f.doc.querySelectorAll('[data-pk-smart-style]').length, 1); await release(); await delay();
  assert.equal(f.doc.querySelector('[data-pk-smart-panel]'), null); f.stop(); assert.equal(f.doc.querySelector('[data-pk-smart-style]'), null);
});
test('UI displays localized metrics, deterioration and three risk colors without HTML injection', async t => {
  const provider = createMockProvider(), original = provider.readLatest;
  provider.readLatest = async args => { const value = await original(args); value.smart.ata_smart_attributes = { table: [{ id: 250, name: '<img src=x onerror=alert(1)>', value: 100, thresh: 0, raw: { value: 1 } }, { id: 199, name: 'UDMA_CRC_Error_Count', value: 200, thresh: 0, raw: { value: 2 } }] }; return value; };
  const f = await fixture(t, { provider }); f.open(); await delay();
  assert.ok(f.doc.querySelector('.pk-smart-risk-yellow')); assert.ok(f.doc.querySelector('.pk-smart-risk-red')); assert.ok(f.doc.querySelector('.pk-smart-risk-darkred'));
  assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /已消耗寿命/); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /1 个百分点/);
  assert.equal(f.doc.querySelector('.pk-smart-panel img'), null); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /<img/);
  f.locale('en-US'); await delay(); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /Endurance used/); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /Local mock data/);
});
test('native tab and repeated SMART clicks restore native content, and stop removes all UI', async t => {
  const f = await fixture(t), native = f.doc.querySelector('.detail-tab-content');
  f.open(); f.open(); await delay(); assert.equal(native.hidden, true);
  f.doc.querySelector('.detail-tabs button:not([data-pk-smart-tab])').click(); assert.equal(native.hidden, false);
  f.open(); await delay(); f.stop(); f.stop();
  assert.equal(native.hidden, false); assert.equal(f.doc.querySelectorAll('[data-pk-smart-tab],[data-pk-smart-panel],[data-pk-smart-style]').length, 0);
  f.doc.body.append(f.doc.createElement('div')); await delay(); assert.equal(f.doc.querySelector('[data-pk-smart-tab]'), null);
});
test('draft setting has no runtime effect until save and is isolated from history storage', async t => {
  const f = await fixture(t); f.store.update({ enabled: false }); await delay(); assert.ok(f.doc.querySelector('[data-pk-smart-tab]'));
  assert.equal(f.store.status().dirty, true); f.store.discard(); assert.equal(f.store.getDraft().enabled, true);
  f.store.update({ enabled: false }); assert.equal(await f.store.save(), true); await delay(); assert.equal(f.doc.querySelector('[data-pk-smart-tab]'), null);
  assert.equal(f.win.localStorage.length, 0);
});
test('changing disk cancels previous request and discards its late response', async t => {
  const provider = createMockProvider(), original = provider.readLatest;
  let release, pendingSignal;
  provider.readLatest = args => { pendingSignal = args.signal; return new Promise(resolve => { release = async () => resolve(await original({ ...args, signal: new AbortController().signal })); }); };
  const f = await fixture(t, { provider }); f.open(); await delay(20); assert.ok(release);
  f.route(disks[1].diskId); await delay(); assert.equal(pendingSignal.aborted, true); assert.equal(f.doc.querySelector('[data-pk-smart-panel]'), null);
  await release(); await delay(); assert.equal(f.doc.querySelector('[data-pk-smart-panel]'), null);
});
test('unverified provider identity, missing adapter and read timeout never show a healthy result', async t => {
  const f = await fixture(t, { provider: null }); f.open(); await delay(); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /暂不可用/);
  assert.equal(f.doc.querySelector('.pk-smart-table'), null);
  const provider = createMockProvider(); provider.readLatest = () => new Promise(() => {});
  const g = await fixture(t, { provider, timeoutMs: 20 }); g.open(); await delay(); assert.match(g.doc.querySelector('.pk-smart-panel').textContent, /暂不可用/);
  const wrong = createMockProvider(); wrong.resolveDisk = async () => ({ ...disks[0], path: '/dev/not-the-disk' });
  const h = await fixture(t, { provider: wrong }); h.open(); await delay(); assert.equal(h.doc.querySelector('.pk-smart-table'), null);
});

test('history is paged on demand, failed days remain selectable, and latest view is restored', async t => {
  const provider = createMockProvider(), read = provider.readHistory; let calls = 0;
  provider.readHistory = args => { calls++; return read(args); };
  const f = await fixture(t, { provider }); await delay(); assert.equal(calls, 0);
  f.open(); await delay(); assert.equal(calls, 1); assert.equal(f.doc.querySelectorAll('[data-sample-time]').length, 30);
  f.doc.querySelectorAll('[data-sample-time]')[1].click();
  assert.equal(f.doc.querySelector('.pk-smart-table'), null); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /本次采集失败/);
  assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /采集尝试时间/);
  f.doc.querySelector('[data-smart-more]').click(); await delay(); assert.equal(calls, 2);
  assert.equal(f.doc.querySelectorAll('[data-sample-time]').length, 60); assert.equal(f.doc.querySelector('.pk-smart-table'), null);
  [...f.doc.querySelectorAll('.pk-smart-panel button')].find(button => button.textContent === '查看最近结果').click();
  assert.ok(f.doc.querySelector('.pk-smart-table'));
  f.doc.querySelector('[data-smart-more]').click(); await delay(); assert.equal(f.doc.querySelectorAll('[data-sample-time]').length, 65);
  assert.equal(f.doc.querySelector('[data-smart-more]'), null); assert.equal(f.win.localStorage.length, 0);
});

test('failed latest retains history and never paints the failed attempt as healthy', async t => {
  const f = await fixture(t, { provider: createMockProvider({ state: () => 'failed' }) }); f.open(); await delay();
  assert.equal(f.doc.querySelector('.pk-smart-table'), null); assert.equal(f.doc.querySelectorAll('[data-sample-time]').length, 30);
  f.doc.querySelector('[data-sample-time]').click(); assert.ok(f.doc.querySelector('.pk-smart-table'));
  assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /正在查看历史采样/);
});

test('stale cursor shows a localized reload instruction without joining pages or leaking server text', async t => {
  const provider = createMockProvider(), read = provider.readHistory;
  provider.readHistory = args => args.cursor ? Promise.reject(Object.assign(new Error('private debug text'), { code: 'SMART_HISTORY_CURSOR_STALE' })) : read(args);
  const f = await fixture(t, { provider }); f.open(); await delay();
  f.doc.querySelector('[data-smart-more]').click(); await delay();
  assert.equal(f.doc.querySelectorAll('[data-sample-time]').length, 30); assert.equal(f.doc.querySelector('[data-smart-more]').disabled, true);
  assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /历史记录已更新/); assert.doesNotMatch(f.doc.querySelector('.pk-smart-panel').textContent, /private debug/);
  f.locale('en-US'); await delay(); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /History changed/);
  [...f.doc.querySelectorAll('.pk-smart-panel button')].find(button => button.textContent === 'Reload').click(); await delay();
  assert.equal(f.doc.querySelector('[data-smart-more]').disabled, false);
});

test('generation change during pagination clears previously displayed data', async t => {
  const provider = createMockProvider(), read = provider.readHistory;
  provider.readHistory = args => args.cursor ? Promise.reject(Object.assign(new Error('fixed'), { code: 'SMART_GENERATION_CHANGED' })) : read(args);
  const f = await fixture(t, { provider }); f.open(); await delay(); f.doc.querySelector('[data-smart-more]').click(); await delay();
  assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /磁盘已更换/); assert.equal(f.doc.querySelectorAll('[data-sample-time]').length, 0);
  assert.equal(f.doc.querySelector('.pk-smart-table'), null);
});

test('disabling plugin cancels an older-page request and ignores its late response', async t => {
  const provider = createMockProvider(), read = provider.readHistory; let release, pendingSignal;
  provider.readHistory = args => args.cursor ? new Promise(resolve => { pendingSignal = args.signal; release = async () => resolve(await read({ ...args, signal: new AbortController().signal })); }) : read(args);
  const f = await fixture(t, { provider }); f.open(); await delay(); f.doc.querySelector('[data-smart-more]').click(); await delay(20);
  assert.ok(release); f.stop(); assert.equal(pendingSignal.aborted, true); await release(); await delay();
  assert.equal(f.doc.querySelector('[data-pk-smart-panel]'), null);
});

test('recovered latest and history localize earlier daily failure without inventing a failure time', async t => {
  const provider = createMockProvider({ state: () => 'recovered' }), read = provider.readHistory;
  provider.readHistory = async args => { const page = await read(args); page.items[0].gapCode = 'SMART_EXECUTION_CANCELLED'; return page; };
  const f = await fixture(t, { provider }); f.open(); await delay();
  assert.match(f.doc.querySelector('.pk-smart-recovered').textContent, /当日曾采集失败，后恢复（采集超时）/);
  assert.match(f.doc.querySelector('.pk-smart-recovered').textContent, /此前失败时刻未提供/);
  assert.ok(f.doc.querySelector('.pk-smart-table')); assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /劣化: 1/);
  assert.match(f.doc.querySelector('[data-sample-time]').textContent, /当日采集已恢复/);
  f.doc.querySelector('[data-sample-time]').click(); assert.match(f.doc.querySelector('.pk-smart-recovered').textContent, /采集取消/);
  assert.equal(f.doc.querySelector('.pk-smart-panel').textContent.includes('采集尝试时间'), false);
  f.locale('en-US'); await delay(); assert.match(f.doc.querySelector('.pk-smart-recovered').textContent, /Collection failed earlier that UTC day, then recovered/);
  assert.match(f.doc.querySelector('.pk-smart-recovered').textContent, /earlier failure time was not provided/);
});

test('collect now submits once, disables competing reads and refreshes latest/history only after success', async t => {
  const provider = createMockProvider(), latest = provider.readLatest, history = provider.readHistory;
  let release, posts = 0, gets = 0, latestReads = 0, historyReads = 0, submitted;
  provider.readLatest = args => { latestReads++; return latest(args); }; provider.readHistory = args => { historyReads++; return history(args); };
  provider.collect = args => { posts++; submitted = args; return new Promise(resolve => { release = () => resolve({ schemaVersion: 1, operationId: args.requestId, status: 'running' }); }); };
  provider.collection = async args => { gets++; assert.deepEqual(args.identity, submitted.identity); assert.equal(args.operationId, submitted.requestId); return { schemaVersion: 1, operationId: args.operationId, status: 'succeeded' }; };
  const f = await fixture(t, { provider }); f.open(); await delay();
  f.doc.querySelector('[data-smart-collect]').click(); f.doc.querySelector('[data-smart-collect]').click(); f.open();
  assert.equal(posts, 1); assert.equal(latestReads, 1); assert.equal(f.doc.querySelector('[data-smart-collect]').disabled, true);
  assert.match(submitted.requestId, /^[0-9a-f-]{36}$/); assert.equal(Object.isFrozen(submitted.identity), true);
  assert.equal([...f.doc.querySelectorAll('button')].find(button => button.textContent === '重新读取').disabled, true);
  release(); await delay(); assert.equal(gets, 1); assert.equal(latestReads, 2); assert.equal(historyReads, 2);
  assert.match(f.doc.querySelector('.pk-smart-collection').textContent, /采集任务已完成/); assert.equal(f.doc.querySelector('[data-smart-collect]').disabled, false);
});

test('approval and missing framework capability are diagnostic without fabricated collection results', async t => {
  const f = await fixture(t, { provider: createMockProvider({ state: () => 'collection-denied' }) }); f.open(); await delay();
  f.doc.querySelector('[data-smart-collect]').click(); await delay(); assert.match(f.doc.querySelector('.pk-smart-collection').textContent, /尚未审核/);
  f.locale('en-US'); await delay(); assert.match(f.doc.querySelector('.pk-smart-collection').textContent, /not approved/);
  const provider = createMockProvider(); delete provider.collect; delete provider.collection;
  const g = await fixture(t, { provider }); g.open(); await delay(); assert.equal(g.doc.querySelector('[data-smart-collect]').disabled, true);
  assert.match(g.doc.querySelector('.pk-smart-panel').textContent, /当前框架尚未提供立即采集/);
  const unbound = createMockProvider(); unbound.resolveDisk = async () => { throw new Error('SMART_DISK_UNBOUND'); };
  const h = await fixture(t, { provider: unbound }); h.open(); await delay(); assert.equal(h.doc.querySelector('[data-smart-collect]').disabled, true); assert.match(h.doc.querySelector('.pk-smart-panel').textContent, /尚未绑定/);
  const unconfigured = createMockProvider(); unconfigured.collect = async () => { throw Object.assign(new Error('private'), { code: 'SMART_PROFILE_UNAVAILABLE', status: 503 }); };
  const j = await fixture(t, { provider: unconfigured }); j.open(); await delay(); j.doc.querySelector('[data-smart-collect]').click(); await delay();
  assert.match(j.doc.querySelector('.pk-smart-collection').textContent, /配置不可用/); assert.doesNotMatch(j.doc.querySelector('.pk-smart-collection').textContent, /private/);
});

test('unknown or failed collections never refresh samples or automatically resubmit', async t => {
  for (const state of ['collection-unknown', 'collection-failed']) {
    const provider = createMockProvider({ state: () => state }), latest = provider.readLatest, submit = provider.collect;
    let reads = 0, posts = 0; provider.readLatest = args => { reads++; return latest(args); }; provider.collect = args => { posts++; return submit(args); };
    const f = await fixture(t, { provider }); f.open(); await delay(); f.doc.querySelector('[data-smart-collect]').click(); await delay();
    assert.equal(posts, 1); assert.equal(reads, 1); assert.ok(f.doc.querySelector('.pk-smart-table'));
    assert.match(f.doc.querySelector('.pk-smart-collection').textContent, state === 'collection-unknown' ? /结果待确认/ : /本次采集失败/);
  }
});

test('collection deadline is unknown rather than remote cancellation and never retries POST', async t => {
  const provider = createMockProvider(); let posts = 0; provider.collect = () => { posts++; return new Promise(() => {}); };
  const f = await fixture(t, { provider, collectionTimeoutMs: 20 }); f.open(); await delay(); f.doc.querySelector('[data-smart-collect]').click(); await delay();
  assert.equal(posts, 1); assert.match(f.doc.querySelector('.pk-smart-collection').textContent, /结果待确认/); assert.match(f.doc.querySelector('.pk-smart-collection').textContent, /任务可能仍在执行/);
});

test('route changes and stop cancel collection waiting and late replies cannot refresh another disk', async t => {
  for (const action of ['route', 'stop', 'drawer', 'native-tab']) {
    const provider = createMockProvider(); let release, submitted, gets = 0;
    provider.collect = args => { submitted = args; return new Promise(resolve => { release = resolve; }); };
    provider.collection = async () => { gets++; };
    const f = await fixture(t, { provider }); f.open(); await delay(); f.doc.querySelector('[data-smart-collect]').click();
    if (action === 'route') f.route(disks[1].diskId);
    else if (action === 'drawer') f.doc.querySelector('.drawer-content-inner').remove();
    else if (action === 'native-tab') f.doc.querySelector('.detail-tabs button:not([data-pk-smart-tab])').click();
    else f.stop(); await delay(); assert.equal(submitted.signal.aborted, true);
    release({ schemaVersion: 1, operationId: submitted.requestId, status: 'succeeded' }); await delay();
    assert.equal(gets, 0);
    if (action === 'native-tab') { f.open(); await delay(); assert.match(f.doc.querySelector('.pk-smart-collection').textContent, /已停止页面等待/); }
    else assert.equal(f.doc.querySelector('[data-pk-smart-panel]'), null);
  }
});

test('successful operation never displays a replacement generation or different source as its refreshed result', async t => {
  for (const change of ['generation', 'source']) {
    const provider = createMockProvider(), latest = provider.readLatest, resolve = provider.resolveDisk, history = provider.readHistory;
    let completed = false;
    provider.collect = async args => { completed = true; return { schemaVersion: 1, operationId: args.requestId, status: 'succeeded' }; };
    provider.resolveDisk = async args => { const identity = await resolve(args); return completed && change === 'generation' ? { ...identity, generation: '4'.repeat(64), deviceId: '4'.repeat(64) } : identity; };
    provider.readLatest = async args => { const value = await latest(args); if (completed && change === 'source') value.source = 'host-smartctl'; return value; };
    provider.readHistory = async args => { const page = await history(args); if (completed && change === 'source') { page.source = 'host-smartctl'; page.items.forEach(item => { item.source = 'host-smartctl'; }); } return page; };
    const f = await fixture(t, { provider }); f.open(); await delay(); f.doc.querySelector('[data-smart-collect]').click(); await delay();
    assert.match(f.doc.querySelector('.pk-smart-panel').textContent, /磁盘已更换/); assert.equal(f.doc.querySelector('.pk-smart-table'), null);
  }
});
