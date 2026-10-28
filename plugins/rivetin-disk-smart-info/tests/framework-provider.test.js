import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createService } from '../../../framework/server/service.js';
import { createApi } from '../../../framework/server/http.js';
import { createTowerDiskReader } from '../../../framework/server/tower-disks.js';
import { createSmartHistory } from '../../../framework/server/smart-history.js';
import { sanitizeSmartOutput } from '../../../framework/server/smart-data.js';
import { hash } from '../../../framework/server/manifest.js';
import { bundle } from '../../../framework/tests/helpers.js';
import { smartFixture, caller } from '../../../framework/tests/data-fixture.js';
import { createClient } from '../../../framework/src/client.js';
import { createDataProviders } from '../../../framework/src/data-providers.js';
import createPlugin from '../src/definition.js';
import { PLUGIN_ID } from '../src/configuration.js';
import { loadDiskData, readHistoryPage } from '../src/provider.js';
import { collectDisk, createRequestId } from '../src/collection.js';
import { sample, disks } from '../demo/fixtures.js';

const requireFramework = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = requireFramework('jsdom');
const channel = 'rivetin-ssh-channel', DAY = 86400000;
const adminToken = 'Bearer EXAMPLE_LOCAL_ADMIN', readerToken = 'Bearer EXAMPLE_LOCAL_READER';
const admin = { id: 'example-admin', name: 'Example administrator', source: 'tower', admin: true, auth: { Authorization: adminToken } };
const abort = () => new AbortController().signal;

// All I/O stays in a generated plugin QA directory and an ephemeral loopback port.
// Only Tower resource responses and SSH execution are simulated; the shared layers are real.
async function setup(t) {
  const base = path.resolve(fileURLToPath(new URL('../qa/', import.meta.url)));
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'provider-integration-'));
  const state = { token: adminToken, denied: false, reads: [], runs: 0, mode: 'ok', afterRead: null,
    disk: { id: disks[0].diskId, host: { id: 'tower-host-example' }, serial: 'EXAMPLE_SYNTHETIC_SERIAL', path: disks[0].path, model: 'Example NVMe SSD' } };
  const raw = offset => ({ ...sample(disks[0], offset).smart, serial_number: state.disk.serial });
  const towerRequest = async (route, body, actor) => {
    assert.equal(route, '/v2/api/get-disks'); assert.deepEqual(body, { where: { id: state.disk.id }, first: 2 });
    assert.ok([adminToken, readerToken].includes(actor.auth?.Authorization)); state.reads.push(actor.auth.Authorization);
    if (state.beforeRead) await state.beforeRead();
    if (state.denied) throw Object.assign(new Error('EXAMPLE_DISK_DENIED'), { status: 403 });
    state.afterRead?.(); return [structuredClone(state.disk)];
  };
  const service = createService(directory, {
    towerBuild: '4.9.0', readDisk: createTowerDiskReader({ request: towerRequest }),
    builtinPackages: [bundle(channel, '0.1.0', pkg => { pkg.manifest.configuration.defaults.enabled = false; return pkg; })],
    sshRun: async ({ host, command, signal }) => {
      state.runs++; assert.equal(host.hostId, 'ssh-profile-example'); assert.equal(signal.aborted, false);
      assert.equal(command, `sudo -n -- /usr/sbin/smartctl --json=c --all ${state.disk.path}`);
      if (state.mode === 'failed') throw new Error('SSH_EXECUTION_TIMEOUT');
      return { stdout: JSON.stringify(raw(0)), stderr: '', exitCode: 0 };
    },
  });
  t.after(async () => {
    await Promise.all([service.smartCollection.stop(), service.sshChannel.stop()]);
    const target = path.resolve(directory); if (!target.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await service.initialize(admin);
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  // Exercise the actual controlled candidate's version gate without an override.
  const files = [];
  for (const name of ['web/plugin.js', 'LICENSE']) {
    // Source factory is exercised below; bundle execution has a separate package check.
    const bytes = name === 'LICENSE' ? await readFile(new URL('../LICENSE', import.meta.url)) : Buffer.from('/* unexecuted integration lifecycle fixture */');
    files.push({ path: name, sha256: hash(bytes), data: bytes.toString('base64') });
  }
  const uploaded = await service.upload(Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest, files })), admin);
  await service.change('install', PLUGIN_ID, uploaded.packageId, admin);
  await service.sshSaveHost({ hostId: 'ssh-profile-example', clusterId: 'cluster-profile-example', address: '192.0.2.10', port: 22,
    username: 'collector', hostKeySha256: 'a'.repeat(64), password: 'EXAMPLE_NOT_A_REAL_SECRET',
    devices: [{ deviceId: 'ssh-device-example', serial: state.disk.serial, path: state.disk.path }] }, admin);
  await service.enable(admin); await service.change('enable', channel, null, admin); await service.saveConfig(channel, { enabled: true }, admin);
  await service.change('enable', PLUGIN_ID, null, admin);
  const api = createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => {
    const token = req.headers.authorization;
    return [adminToken, readerToken].includes(token) ? { ...admin, id: token === adminToken ? admin.id : 'example-reader', admin: token === adminToken, auth: { Authorization: token } } : null;
  } });
  const server = http.createServer(api); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM(await readFile(new URL('./fixtures/cloudtower-4.9-disk-sidebar.html', import.meta.url), 'utf8'), { url: origin });
  const win = dom.window; t.after(() => win.close());
  win.location.hash = `/clusters/cluster-example?${new URLSearchParams({ view: JSON.stringify('disks'), sidebar: JSON.stringify({ type: 'disk', id: state.disk.id }) })}`;
  Object.defineProperty(win, 'localStorage', { value: { getItem: key => key === 'token' ? JSON.stringify({ value: state.token }) : null } });
  const payloads = [];
  win.fetch = async (relative, options) => {
    const url = new URL(relative, origin); assert.equal(url.origin, origin); assert.ok(url.pathname.startsWith('/api/rivetin/v1/'));
    const response = await fetch(url, { ...options, ...(state.ignoreFetchAbort ? { signal: undefined } : {}), headers: { ...options.headers, Origin: 'https://tower.example.invalid' } });
    payloads.push(await response.clone().text()); return response;
  };
  const client = createClient(win), provider = createDataProviders(client, PLUGIN_ID).diskSmart;
  async function bind() { return client('/inventory/disk-bindings', 'POST', { action: 'bind', diskId: state.disk.id, profileHostId: 'ssh-profile-example', deviceId: 'ssh-device-example' }); }
  async function collect() {
    const review = await service.sshChannel.review(PLUGIN_ID, admin);
    await service.sshChannel.approve({ pluginId: PLUGIN_ID, challenge: review.challenge, digest: review.digest, acknowledged: true }, admin);
    return service.sshChannel.run(PLUGIN_ID, 'daily-smart', admin);
  }
  async function seed(identity, count = 35) {
    const history = createSmartHistory(directory), time = Date.now();
    for (let offset = 1; offset <= count; offset++) await history.append({ pluginId: PLUGIN_ID, diskId: identity.diskId, hostId: identity.hostId, generation: identity.generation,
      operation: 'disk.smart.read', operationId: `example-history-${offset}`, status: 'ok', collectedAt: new Date(time - offset * DAY).toISOString(), smart: sanitizeSmartOutput(JSON.stringify(raw(offset)), 0) });
    return history;
  }
  return { service, state, provider, client, win, payloads, bind, collect, seed };
}

test('real shared HTTP/provider consumes binding, no sample, failed collection, recovery and paginated history', async t => {
  const f = await setup(t);
  await assert.rejects(loadDiskData(f.provider, f.state.disk.id, abort()), { code: 'SMART_DISK_UNBOUND', status: 404 });
  await f.bind();
  let result = await loadDiskData(f.provider, f.state.disk.id, abort());
  assert.equal(result.latest.code, 'SMART_NO_SAMPLE'); assert.equal(result.latest.collectedAt, null); assert.deepEqual(result.history, []); assert.equal(f.state.runs, 0);
  f.state.mode = 'failed'; await f.collect();
  result = await loadDiskData(f.provider, f.state.disk.id, abort());
  assert.equal(result.latest.code, 'SMART_EXECUTION_TIMEOUT'); assert.ok(result.latest.collectedAt); assert.equal(result.history.length, 1); assert.equal(result.latest.risk, 'unknown');
  await f.seed(result.identity); f.state.mode = 'ok'; await f.collect();
  result = await loadDiskData(f.provider, f.state.disk.id, abort());
  assert.equal(result.latest.gapCode, 'SMART_EXECUTION_TIMEOUT'); assert.equal(result.latest.source, 'host-smartctl');
  assert.equal(result.latest.metrics.find(metric => metric.id === 'media_errors').deterioration, '1'); assert.equal(result.history.length, 30); assert.equal(result.identity.path, '');
  result = await readHistoryPage(f.provider, result, result.nextCursor, abort()); assert.equal(result.history.length, 36); assert.equal(result.hasMore, false);
  assert.equal(f.state.runs, 2); assert.ok(!f.payloads.join('').includes('EXAMPLE_SYNTHETIC_SERIAL')); assert.ok(!f.payloads.join('').includes('EXAMPLE_NOT_A_REAL_SECRET'));
});

test('real provider rechecks reader access and fails closed when access changes between latest and history', async t => {
  const f = await setup(t); await f.bind(); await f.collect(); f.state.token = readerToken;
  const before = f.state.reads.length;
  await loadDiskData(f.provider, f.state.disk.id, abort());
  assert.deepEqual(f.state.reads.slice(before), [readerToken, readerToken, readerToken]);
  let reads = 0; f.state.afterRead = () => { if (++reads === 2) f.state.denied = true; };
  await assert.rejects(loadDiskData(f.provider, f.state.disk.id, abort()), { status: 403 });
});

test('real provider rejects a replaced disk and stale persisted history cursor without merging pages', async t => {
  const f = await setup(t); await f.bind(); const initial = await loadDiskData(f.provider, f.state.disk.id, abort());
  await f.seed(initial.identity); const result = await loadDiskData(f.provider, f.state.disk.id, abort()); assert.equal(result.history.length, 30);
  await f.collect(); await assert.rejects(readHistoryPage(f.provider, result, result.nextCursor, abort()), { code: 'SMART_HISTORY_CURSOR_STALE', status: 409 });
  assert.equal(result.history.length, 30);
  f.state.disk.serial = 'EXAMPLE_REPLACEMENT_SERIAL';
  await assert.rejects(f.provider.readLatest({ identity: result.identity, signal: abort() }), { code: 'SMART_GENERATION_CHANGED', status: 409 });
});

test('framework provider rejects a late HTTP response after caller cancellation', async t => {
  const f = await setup(t); await f.bind();
  let release, started; const pendingRead = new Promise(resolve => { started = resolve; });
  f.state.beforeRead = () => { started(); return new Promise(resolve => { release = resolve; }); }; f.state.ignoreFetchAbort = true;
  const controller = new AbortController(); const result = f.provider.resolveDisk({ diskId: f.state.disk.id, signal: controller.signal });
  await pendingRead; controller.abort(); release();
  await assert.rejects(result, { code: 'REQUEST_CANCELLED' });
});

test('plugin factory renders real shared provider data and recovery notice without collecting on read', async t => {
  const f = await setup(t); await f.bind(); f.state.mode = 'failed'; await f.collect(); f.state.mode = 'ok'; await f.collect();
  const plugin = createPlugin({ React: requireFramework('react'), win: f.win, getLocale: () => 'zh-CN', options: { diskSmartInfo: { provider: f.provider } } });
  let stop; t.after(() => { stop?.(); plugin.store.dispose(); });
  await plugin.store.load(); stop = plugin.activate(); f.win.document.querySelector('[data-pk-smart-tab]').click();
  const deadline = Date.now() + 3000;
  while (!f.win.document.querySelector('.pk-smart-table') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(f.win.document.querySelector('.pk-smart-table')); assert.match(f.win.document.querySelector('.pk-smart-recovered').textContent, /当日曾采集失败，后恢复/);
  assert.doesNotMatch(f.win.document.querySelector('[data-pk-smart-panel]').textContent, /本地模拟数据|EXAMPLE_SYNTHETIC_SERIAL/); assert.equal(f.state.runs, 2);
  stop(); stop = null; assert.equal(f.win.document.querySelector('[data-pk-smart-panel]'), null); assert.equal(f.win.document.querySelector('.tab-content').hidden, false);
});

test('official shared fixture reaches consumer with null no-sample and collected metrics/history', async t => {
  const f = await smartFixture(t);
  let result = await loadDiskData(f.provider, 'example-disk', abort());
  assert.equal(result.latest.collectedAt, null); assert.equal(result.latest.code, 'SMART_NO_SAMPLE'); assert.equal(result.latest.risk, 'unknown');
  assert.deepEqual(result.history, []); assert.equal(f.runs(), 0);
  await f.approve(); await f.collect(); result = await loadDiskData(f.provider, 'example-disk', abort());
  assert.equal(result.latest.source, 'host-smartctl'); assert.equal(result.latest.protocol, 'ATA'); assert.equal(result.latest.metrics.find(metric => metric.id === 'power_on_hours').value, '123');
  assert.equal(result.history.length, 1); assert.equal(result.previous, null); assert.equal(result.history[0].collectedAt, result.latest.collectedAt); assert.equal(f.runs(), 1);
  assert.ok(f.reads.every(read => read.actorId === caller.id && read.auth.Authorization === caller.auth.Authorization));
});

test('official shared fixture permission loss after latest rejects the whole consumer result', async t => {
  const f = await smartFixture(t); await f.approve(); await f.collect();
  const latest = f.provider.readLatest;
  const provider = { ...f.provider, async readLatest(args) { const sample = await latest(args); f.deny(); return sample; } };
  await assert.rejects(loadDiskData(provider, 'example-disk', abort()), { status: 403 });
  assert.equal(f.runs(), 1);
});

test('official shared fixture exposes a failed day followed by a recovered daily success', async t => {
  const f = await smartFixture(t); await f.approve(); f.failRun(); await f.collect();
  const failed = await loadDiskData(f.provider, 'example-disk', abort());
  assert.equal(failed.latest.status, 'unavailable'); assert.equal(failed.latest.code, 'SMART_EXECUTION_TIMEOUT');
  assert.ok(failed.latest.collectedAt); assert.equal(failed.history.length, 1); assert.equal(failed.previous, null);
  f.failRun(false); await f.collect(); const recovered = await loadDiskData(f.provider, 'example-disk', abort());
  assert.equal(recovered.latest.status, 'ok'); assert.equal(recovered.latest.gapCode, 'SMART_EXECUTION_TIMEOUT');
  assert.equal(recovered.history.length, 1); assert.equal(recovered.previous, null); assert.equal(f.runs(), 2);
});

test('collect now crosses the real shared HTTP adapter and executes only the selected approved disk', async t => {
  const f = await smartFixture(t, { twoDevices: true }), before = await loadDiskData(f.provider, 'example-disk', abort());
  await f.approve(); let posts = 0, gets = 0;
  const provider = { ...f.provider, collect: args => { posts++; return f.provider.collect(args); }, collection: args => { gets++; return f.provider.collection(args); } };
  const outcome = await collectDisk(provider, { identity: before.identity, requestId: createRequestId(globalThis.crypto), signal: abort(), intervalMs: 1, timeoutMs: 5000 });
  assert.equal(outcome.status, 'succeeded'); assert.equal(posts, 1); assert.ok(gets >= 1); assert.equal(f.runs(), 1);
  assert.deepEqual(f.commands, ['sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sda']);
  const refreshed = await loadDiskData(f.provider, 'example-disk', abort());
  assert.equal(refreshed.latest.status, 'ok'); assert.equal(refreshed.latest.metrics.find(metric => metric.id === 'power_on_hours').value, '123'); assert.equal(refreshed.history.length, 1);
  const repeated = await collectDisk(provider, { identity: refreshed.identity, requestId: createRequestId(globalThis.crypto), signal: abort(), intervalMs: 1, timeoutMs: 5000 });
  assert.equal(repeated.status, 'succeeded');
  const newer = await loadDiskData(f.provider, 'example-disk', abort());
  assert.ok(Date.parse(newer.latest.collectedAt) > Date.parse(refreshed.latest.collectedAt)); assert.equal(newer.history.length, 1);
  assert.equal(posts, 2); assert.equal(f.runs(), 2); assert.ok(f.commands.every(command => command.endsWith('/dev/sda')));
});

test('shared collection without approval is diagnostic and executes no mock SSH command', async t => {
  const f = await smartFixture(t), before = await loadDiskData(f.provider, 'example-disk', abort());
  const outcome = await collectDisk(f.provider, { identity: before.identity, requestId: createRequestId(globalThis.crypto), signal: abort(), intervalMs: 1, timeoutMs: 5000 });
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.code, 'SSH_APPROVAL_REQUIRED'); assert.equal(f.runs(), 0);
  assert.equal((await loadDiskData(f.provider, 'example-disk', abort())).latest.code, 'SMART_NO_SAMPLE');
});

test('shared polling rechecks authorization for the pinned identity', async t => {
  const f = await smartFixture(t), before = await loadDiskData(f.provider, 'example-disk', abort()); await f.approve();
  const provider = { ...f.provider, collection: args => { f.deny(); return f.provider.collection(args); } };
  await assert.rejects(collectDisk(provider, { identity: before.identity, requestId: createRequestId(globalThis.crypto), signal: abort(), intervalMs: 1, timeoutMs: 5000 }), { code: 'SMART_DISK_FORBIDDEN' });
});

test('actual plugin button rejects unapproved execution then refreshes through shared HTTP after local approval', async t => {
  const f = await setup(t); await f.bind();
  const plugin = createPlugin({ React: requireFramework('react'), win: f.win, getLocale: () => 'zh-CN', options: { diskSmartInfo: { provider: f.provider } } });
  let stop; t.after(() => { stop?.(); plugin.store.dispose(); }); await plugin.store.load(); stop = plugin.activate();
  const waitFor = async check => { const end = Date.now() + 5000; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check()); };
  f.win.document.querySelector('[data-pk-smart-tab]').click(); await waitFor(() => f.win.document.querySelector('[data-smart-collect]')?.disabled === false);
  f.win.document.querySelector('[data-smart-collect]').click(); await waitFor(() => f.win.document.querySelector('.pk-smart-collection')?.textContent.includes('尚未审核'));
  assert.equal(f.state.runs, 0);
  const review = await f.service.sshChannel.review(PLUGIN_ID, admin); await f.service.sshChannel.approve({ pluginId: PLUGIN_ID, challenge: review.challenge, digest: review.digest, acknowledged: true }, admin);
  f.win.document.querySelector('[data-smart-collect]').click();
  await waitFor(() => f.win.document.querySelector('.pk-smart-table') && f.win.document.querySelector('.pk-smart-collection')?.textContent.includes('已完成'));
  assert.equal(f.state.runs, 1); assert.match(f.win.document.querySelector('[data-pk-smart-panel]').textContent, /host-smartctl/);
  assert.doesNotMatch(f.win.document.querySelector('[data-pk-smart-panel]').textContent, /本地模拟数据/);
});
