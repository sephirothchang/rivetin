import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { fixture, actor, bundle } from './helpers.js';
import { createService } from '../server/service.js';
import { validatePackage, validateManifest } from '../server/manifest.js';
import { createApi } from '../server/http.js';
import { createTowerAuditSink } from '../server/audit.js';
import { listenPort } from '../server/options.js';

test('listen port ignores Kubernetes service-link variables and rejects invalid explicit values', () => {
  assert.equal(listenPort({ PLUGINKIT_PORT: 'tcp://192.0.2.10:8787' }), 8787);
  assert.equal(listenPort({ PLUGINKIT_LISTEN_PORT: '8788' }), 8788);
  for (const value of ['0', '65536', 'NaN', 'tcp://example.invalid:8787', '-1', '8787x']) assert.throws(() => listenPort({ PLUGINKIT_LISTEN_PORT: value }));
});
test('permanent Tower region uses an unversioned registry key; release version remains informational', async () => {
  const manifest = JSON.parse(await readFile(new URL('../sea-map.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'pluginkit'); assert.equal(manifest.metadata.version, undefined);
  assert.equal(manifest.metadata.info.version, '0.1.0'); assert.equal(manifest.data[0].island, './PluginKit');
  assert.equal(manifest.data[0].region, 'PERMANENT_CLUSTER_MANAGER_MODAL');
});

test('CLI bootstrap is persistent, disabled by default and idempotent', async t => {
  const { service, directory } = await fixture(t);
  assert.equal((await service.runtime()).enabled, false);
  assert.equal((await service.initialize(actor)).created, false);
  await service.enable(actor); assert.equal((await createService(directory).runtime()).enabled, true);
  const output = await promisify(execFile)(process.execPath, ['cli.mjs', 'disable', '--data', directory]);
  assert.equal(JSON.parse(output.stdout).enabled, false);
  assert.equal((await service.runtime()).enabled, false);
});
test('lifecycle install/enable/update/rollback/reset/uninstall retain independent settings and backups', async t => {
  const { service, directory, install } = await fixture(t); const id = 'pluginkit-example';
  await install(); assert.equal((await service.plugins())[0].enabled, false);
  await service.enable(actor); await service.change('enable', id, null, actor);
  assert.equal((await service.plugins())[0].active, true);
  await service.saveConfig(id, { enabled: false }, actor);
  const next = await service.upload(bundle(id, '0.1.1'), actor);
  await service.change('update', id, next.packageId, actor);
  let item = (await service.plugins())[0]; assert.equal(item.version, '0.1.1'); assert.equal(item.enabled, false);
  assert.equal((await service.loadConfig()).plugins[id].settings.enabled, false);
  await service.change('rollback', id, null, actor); assert.equal((await service.plugins())[0].version, '0.1.0');
  await service.change('reset', id, null, actor); assert.equal((await service.loadConfig()).plugins[id].settings.enabled, true);
  await service.change('uninstall', id, null, actor); assert.equal((await service.plugins())[0].installed, false);
  assert.ok((await readFile(path.join(directory, 'plugins', id, 'config.json'), 'utf8')).includes('enabled'));
  assert.ok((await service.logs()).items.some(event => event.action === 'plugin.uninstall'));
});
test('last save wins across independent services and different plugin files cannot overwrite each other', async t => {
  const { service, directory, install } = await fixture(t); await install(); await install('pluginkit-second');
  const other = createService(directory);
  await Promise.all([service.saveConfig('pluginkit-example', { enabled: false }, actor), other.saveConfig('pluginkit-second', { enabled: false }, actor)]);
  await other.saveConfig('pluginkit-example', { enabled: true }, actor);
  const data = await service.loadConfig(); assert.equal(data.plugins['pluginkit-example'].settings.enabled, true); assert.equal(data.plugins['pluginkit-second'].settings.enabled, false);
  assert.equal(data.plugins['pluginkit-example'].revision, 2);
  await assert.rejects(service.saveConfig('pluginkit-example', { password: 'EXAMPLE_REJECTED' }, actor));
});
test('one corrupt plugin config does not block another plugin or emergency disable, even if lifecycle lock is held', async t => {
  const { service, directory, install } = await fixture(t); await install(); await install('pluginkit-second'); await service.enable(actor);
  await writeFile(path.join(directory, 'plugins/pluginkit-example/config.json'), 'EXAMPLE_CORRUPTION');
  const data = await service.loadConfig(); assert.ok(data.errors['pluginkit-example']); assert.ok(data.plugins['pluginkit-second']);
  await service.saveConfig('pluginkit-second', { enabled: false }, actor);
  await writeFile(path.join(directory, '.write.lock'), 'EXAMPLE_HELD_LOCK');
  assert.equal((await service.disable(actor)).enabled, false); assert.equal((await service.runtime()).enabled, false);
  assert.equal(await readFile(path.join(directory, 'plugins/pluginkit-example/config.json'), 'utf8'), 'EXAMPLE_CORRUPTION');
});
test('legacy migration keeps backup and refuses to overwrite existing settings', async t => {
  const { service, directory, install } = await fixture(t); await install(); const file = path.join(directory, 'legacy.json');
  await writeFile(file, JSON.stringify({ plugins: { 'pluginkit-example': { revision: 8, updatedAt: 'EXAMPLE_TIME', settings: { enabled: false } } } }));
  await service.migrateLegacy(file, actor); assert.equal((await service.loadConfig()).plugins['pluginkit-example'].revision, 8);
  assert.ok((await readFile(path.join(directory, 'backups/legacy-configuration.json'), 'utf8')).includes('EXAMPLE_TIME'));
  await assert.rejects(service.migrateLegacy(file, actor), /CONFIGURATION_ALREADY_EXISTS/);
});
test('update refuses incompatible config schema and preserves active pointer', async t => {
  const { service, install } = await fixture(t); await install();
  const uploaded = await service.upload(bundle('pluginkit-example', '0.2.0', pkg => { pkg.manifest.configuration.version = 2; return pkg; }), actor);
  await assert.rejects(service.change('update', 'pluginkit-example', uploaded.packageId, actor));
  assert.equal((await service.plugins())[0].version, '0.1.0');
});
for (const [name, change] of [
  ['path traversal', pkg => { pkg.files[0].path = '../escape.js'; }],
  ['windows path', pkg => { pkg.files[0].path = 'C:/escape.js'; }],
  ['reserved device', pkg => { pkg.files[0].path = 'web/con.js'; }],
  ['case collision', pkg => { pkg.files.push({ ...pkg.files[0], path: 'web/PLUGIN.js' }); }],
  ['bad digest', pkg => { pkg.files[0].sha256 = '0'.repeat(64); }],
  ['missing entry', pkg => { pkg.manifest.frontend.entry = 'web/missing.js'; }],
  ['backend hook', pkg => { pkg.manifest.installScript = 'example'; }],
  ['unsupported API', pkg => { pkg.manifest.compatibility.frameworkApi = 2; }],
  ['unknown permission', pkg => { pkg.manifest.permissions = ['root.exec']; }],
  ['missing translation', pkg => { delete pkg.manifest.name['en-US']; }],
  ['invalid defaults', pkg => { pkg.manifest.configuration.defaults = { enabled: 'true' }; }],
]) test(`package rejects ${name}`, () => assert.throws(() => validatePackage(bundle(undefined, undefined, pkg => { change(pkg); return pkg; }))));

test('HTTP API authenticates all reads, requires admin+origin for mutations, and keeps disable simple', async t => {
  const { service, install } = await fixture(t); await install();
  const api = createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers['x-example-identity'] ? { ...actor, admin: req.headers['x-example-identity'] === 'admin' } : null });
  const server = http.createServer(api); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/pluginkit/v1`;
  assert.equal((await fetch(base + '/config')).status, 401);
  assert.equal((await fetch(base + '/logs', { headers: { 'x-example-identity': 'reader' } })).status, 403);
  assert.equal((await fetch(base + '/enable', { method: 'POST', headers: { 'x-example-identity': 'reader', Origin: 'https://tower.example.invalid' } })).status, 403);
  assert.equal((await fetch(base + '/enable', { method: 'POST', headers: { 'x-example-identity': 'admin', Origin: 'https://evil.example.invalid' } })).status, 403);
  const headers = { 'x-example-identity': 'admin', Origin: 'https://tower.example.invalid' };
  assert.equal((await fetch(base + '/enable', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/disable', { method: 'POST', headers })).status, 200);
  assert.equal((await service.runtime()).enabled, false);
  assert.equal((await fetch(base + '/config', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ pluginId: '../escape', settings: {} }) })).status, 400);
});
test('local audit is paginated and contains metadata only; Tower sink emits bilingual official payload', async t => {
  const { service, install } = await fixture(t); await install(); await service.saveConfig('pluginkit-example', { enabled: false }, actor);
  const first = await service.logs({ limit: 2 }); assert.equal(first.items.length, 2); assert.ok(first.next);
  const second = await service.logs({ limit: 2, before: first.next }); assert.ok(!second.items.some(event => first.items.some(other => event.id === other.id)));
  assert.ok(!JSON.stringify(await service.logs()).includes('settings'));
  let sent;
  const sink = createTowerAuditSink({ request: async (endpoint, body) => { sent = { endpoint, body }; return [{ data: { id: 'EXAMPLE_LOG_ID' }, task_id: null }]; } });
  await sink({ ...first.items[0], actor: { ...actor, source: 'tower' } });
  assert.equal(sent.endpoint, '/v2/api/create-user-audit-log'); assert.ok(sent.body[0].message['zh-CN']); assert.ok(sent.body[0].message['en-US']); assert.equal(sent.body[0].resource_type, 'pluginkit');
  await assert.rejects(createTowerAuditSink({ request: async () => [{ data: { id: 'EXAMPLE_LOG_ID' }, task_id: 'EXAMPLE_PENDING' }] })({ ...first.items[0], actor }));
});
