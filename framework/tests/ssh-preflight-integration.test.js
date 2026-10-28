import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { bundle } from './helpers.js';

const channel = 'rivetin-ssh-channel', route = '/ssh-channel/preflight';
const actor = { id: 'example-admin', name: 'Example administrator', source: 'tower', admin: true, auth: { Authorization: 'Bearer EXAMPLE_SYNTHETIC_TOKEN' } };
const profile = () => ({ hostId: 'host-example', clusterId: 'cluster-example', address: '192.0.2.10', port: 22, username: 'saved-reader', password: 'EXAMPLE_SAVED_SECRET', hostKeySha256: 'a'.repeat(64), devices: [] });
const discover = () => ({ action: 'discover', hostId: 'host-example', address: '192.0.2.10', port: 22 });
const confirm = challenge => ({ ...discover(), action: 'confirm', challenge, acknowledged: true });
const verify = () => ({ action: 'verify', hostId: 'host-example' });

async function fixture(t) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'ssh-preflight-integration-'));
  const state = { build: '4.9.0', address: '192.0.2.10', inventoryAllowed: true, discoverCalls: [], verifyCalls: [], requests: [], holdVerify: false, aborted: 0 };
  const service = createService(directory, { towerVersionProvider: async () => state.build, towerBuild: '4.9.0',
    builtinPackages: [bundle(channel, '0.1.0', pkg => { pkg.manifest.configuration.defaults.enabled = false; return pkg; })],
    towerRequest: async (endpoint, body, who) => {
      state.requests.push({ endpoint, body, actorId: who.id });
      assert.equal(who.auth.Authorization, actor.auth.Authorization);
      if (!state.inventoryAllowed) throw Object.assign(new Error('EXAMPLE_PRIVATE_TOWER_ERROR'), { status: 403 });
      if (endpoint === '/v2/api/get-clusters') return [{ id: 'cluster-example', name: 'Example cluster' }];
      if (endpoint === '/v2/api/get-hosts') return [{ id: 'host-example', name: 'Example host', cluster: { id: 'cluster-example' }, management_ip: state.address }];
      throw new Error('UNEXPECTED_TOWER_ENDPOINT');
    },
    sshRun: async () => { throw new Error('EXECUTION_MUST_NOT_BE_USED'); },
    sshPreflightTransport: {
      discover: async args => { state.discoverCalls.push(args); return { algorithm: 'ssh-ed25519', sha256Hex: 'b'.repeat(64), fingerprint: 'SHA256:' + Buffer.from('b'.repeat(64), 'hex').toString('base64').replace(/=+$/, '') }; },
      verify: async args => {
        state.verifyCalls.push(args);
        if (!state.holdVerify) return { verified: true };
        return new Promise((_, reject) => args.signal.addEventListener('abort', () => { state.aborted++; reject(new Error('SSH_ABORTED')); }, { once: true }));
      },
    } });
  await service.initialize(actor); await service.sshSaveHost(profile(), actor);
  const api = createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers['x-example-role'] ? { ...actor, admin: req.headers['x-example-role'] === 'admin', id: req.headers['x-example-user'] || actor.id } : null });
  const server = http.createServer((req, res) => api(req, res).then(handled => { if (handled === false) { res.writeHead(404); res.end('{}'); } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { service.sshPreflight.stop(); await service.sshChannel.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const apiBase = `http://127.0.0.1:${server.address().port}/api/rivetin/v1`;
  const request = async (endpoint, method = 'POST', value, headers = {}) => {
    const response = await fetch(apiBase + endpoint, { method, headers: { 'x-example-role': 'admin', Origin: 'https://tower.example.invalid', 'Content-Type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(8000) });
    return { status: response.status, body: await response.json() };
  };
  const ready = async () => { await service.enable(actor); await service.change('enable', channel, null, actor); };
  return { directory, service, state, request, ready };
}

test('actual HTTP preflight enforces authentication, administrator and same-origin changes before any transport', async t => {
  const f = await fixture(t); await f.ready();
  assert.equal((await f.request(route, 'POST', discover(), { 'x-example-role': '' })).status, 401);
  assert.equal((await f.request(route, 'POST', discover(), { 'x-example-role': 'reader' })).status, 403);
  assert.equal((await f.request(route, 'POST', discover(), { Origin: 'https://untrusted.example.invalid' })).status, 403);
  assert.equal(f.state.discoverCalls.length, 0); assert.equal(f.state.verifyCalls.length, 0);
});

test('actual preflight routes accept only exact discovery confirmation and saved-host verification fields', async t => {
  const f = await fixture(t); await f.ready();
  for (const action of [discover(), confirm('b'.repeat(64)), verify()]) for (const extra of [{ password: 'EXAMPLE_FORBIDDEN' }, { command: '/usr/bin/uname -srm' }, { extra: true }, { actor: { admin: true } }, { host: profile() }]) {
    const result = await f.request(route, 'POST', { ...action, ...extra }); assert.equal(result.status, 400); assert.equal(result.body.error, 'INVALID_REQUEST');
  }
  for (const value of [null, [], {}, { action: 'verify' }, { action: 'discover', hostId: 'host-example', port: 22 }, { action: 'run', hostId: 'host-example' }]) assert.equal((await f.request(route, 'POST', value)).status, 400);
  assert.equal((await f.request(route, 'GET')).status, 404); assert.equal(f.state.discoverCalls.length, 0); assert.equal(f.state.verifyCalls.length, 0);
});

test('framework and lifecycle gates reject preflight while the separate collection configuration can remain disabled', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(route, 'POST', discover())).status, 403);
  await f.service.enable(actor); assert.equal((await f.request(route, 'POST', discover())).status, 403);
  await f.service.change('enable', channel, null, actor);
  assert.equal((await f.service.loadConfig()).plugins[channel].settings.enabled, false);
  assert.equal((await f.request(route, 'POST', discover())).status, 200);
  assert.equal((await f.request(route, 'POST', verify())).status, 200);
  assert.equal((await f.service.sshChannel.status(actor)).enabled, false);
  assert.equal(f.state.verifyCalls.length, 1);
  await f.service.change('disable', channel, null, actor); assert.equal((await f.request(route, 'POST', verify())).status, 403);
  await f.service.change('enable', channel, null, actor); f.state.build = '4.10.0'; assert.equal((await f.request(route, 'POST', discover())).status, 403);
});

test('discovery and confirmation use fresh caller inventory and candidate confirmation never saves Vault trust', async t => {
  const f = await fixture(t); await f.ready(); const beforeRevision = await f.service.sshHosts.revision(), bytes = await readFile(path.join(f.service.sshHosts.root, 'host-example.host.json'));
  assert.equal((await f.request(route, 'POST', { ...discover(), address: '192.0.2.11' })).status, 409);
  assert.equal((await f.request(route, 'POST', { ...discover(), address: '127.0.0.1' })).status, 400);
  assert.equal((await f.request(route, 'POST', { ...discover(), address: 'tower.example.invalid' })).status, 400);
  assert.equal((await f.request(route, 'POST', { ...discover(), hostId: 'foreign-host' })).status, 404);
  const found = await f.request(route, 'POST', discover()); assert.equal(found.status, 200); const confirmed = await f.request(route, 'POST', confirm(found.body.challenge));
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.confirmed, true); assert.equal(confirmed.body.sha256Hex, 'b'.repeat(64));
  assert.equal(await f.service.sshHosts.revision(), beforeRevision); assert.deepEqual(await readFile(path.join(f.service.sshHosts.root, 'host-example.host.json')), bytes);
  assert.equal((await f.service.sshHosts.get('host-example')).hostKeySha256, 'a'.repeat(64));
  const stale = await f.request(route, 'POST', discover()); f.state.address = '192.0.2.11'; assert.equal((await f.request(route, 'POST', confirm(stale.body.challenge))).status, 409);
  f.state.address = '192.0.2.10'; f.state.inventoryAllowed = false; assert.equal((await f.request(route, 'POST', discover())).status, 403);
  assert.ok(f.state.requests.every(request => ['/v2/api/get-hosts', '/v2/api/get-clusters'].includes(request.endpoint) && request.actorId === actor.id));
});

test('saved effective credentials and saved pin alone reach auth-only verify; secrets never appear in HTTP or audit', async t => {
  const f = await fixture(t); await f.ready();
  // Explicitly seed the legacy vault fixture; public connection writes require v2.
  const original = await f.service.sshHosts.connections(), draft = { version: 1, operationId: randomUUID(), global: { username: 'global-reader', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_GLOBAL_SECRET' }, privateKey: { action: 'keep' } }, clusters: [], hosts: original.hosts.map(({ connection, effective, ...target }) => ({ ...target, connection: null })) };
  await f.service.sshHosts.saveConnections(draft);
  const verified = await f.request(route, 'POST', verify()); assert.equal(verified.status, 200); assert.deepEqual(Object.keys(verified.body).sort(), ['checkedAt', 'hostId', 'verified']);
  const call = f.state.verifyCalls.at(-1); assert.equal(call.host.username, 'global-reader'); assert.equal(call.host.password, 'EXAMPLE_GLOBAL_SECRET'); assert.equal(call.host.hostKeySha256, 'a'.repeat(64)); assert.ok(call.timeoutMs <= 5000); assert.equal(Object.hasOwn(call, 'command'), false);
  const audit = await readFile(path.join(f.directory, 'audit.jsonl'), 'utf8');
  for (const secret of ['EXAMPLE_SAVED_SECRET', 'EXAMPLE_GLOBAL_SECRET', 'EXAMPLE_SYNTHETIC_TOKEN']) { assert.ok(!JSON.stringify(verified.body).includes(secret)); assert.ok(!audit.includes(secret)); }
});

test('framework disable and channel configuration saves abort an active auth-only request', async t => {
  for (const mutation of ['disable', 'config']) {
    const f = await fixture(t); await f.ready(); f.state.holdVerify = true;
    const pending = f.request(route, 'POST', verify()); while (f.state.verifyCalls.length === 0) await new Promise(resolve => setImmediate(resolve));
    const changed = mutation === 'disable' ? await f.request('/disable', 'POST') : await f.request('/config', 'PUT', { pluginId: channel, settings: { enabled: false } }); assert.equal(changed.status, 200);
    const cancelled = await pending; assert.equal(cancelled.status, 409); assert.equal(cancelled.body.error, 'SSH_PREFLIGHT_CANCELLED'); assert.equal(f.state.aborted, 1); assert.equal(f.state.verifyCalls[0].signal.aborted, true);
  }
});

test('framework, lifecycle, configuration and connection writes clear pending fingerprint challenges', async t => {
  for (const mutation of ['framework', 'lifecycle', 'config', 'host-save', 'host-delete']) {
    const f = await fixture(t); await f.ready(); const found = await f.request(route, 'POST', discover()); assert.equal(found.status, 200);
    if (mutation === 'framework') { await f.service.disable(actor); await f.service.enable(actor); }
    if (mutation === 'lifecycle') { await f.service.change('disable', channel, null, actor); await f.service.change('enable', channel, null, actor); }
    if (mutation === 'config') await f.service.saveConfig(channel, { enabled: false }, actor);
    if (mutation === 'host-save') await f.service.sshSaveHost(profile(), actor);
    if (mutation === 'host-delete') await f.service.sshRemoveHost('host-example', actor);
    const stale = await f.request(route, 'POST', confirm(found.body.challenge)); assert.equal(stale.status, 409); assert.equal(stale.body.error, 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED');
  }
});
