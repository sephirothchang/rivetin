import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDeploymentProbes } from '../server/deployment-probes.js';
import { createTowerConnection } from '../server/tower.js';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';
import { fixture } from './helpers.js';

const actor = { id: 'example-admin', source: 'tower', admin: true, role: 'ROOT', auth: { Authorization: 'EXAMPLE_NOT_A_REAL_TOKEN' } };
const registration = () => ({ seaMaps: [{ name: 'rivetin', metadata: { info: { version: FRAMEWORK_VERSION } }, data: [{ region: 'PERMANENT_CLUSTER_MANAGER_MODAL', island: './Rivetin' }] }] });
const options = { origins: ['https://tower.example.invalid'], version: FRAMEWORK_VERSION };
const row = (value, id) => value.components.find(item => item.id === id);

test('registry observes one exact registration and never infers it from a loaded page or version alone', async () => {
  let value = registration();
  const probes = createDeploymentProbes({ ...options, registry: async () => value });
  assert.deepEqual(await probes.readIsland({ actor }), { available: true, matched: true, code: null });
  value.seaMaps[0].data[0].island = './Wrong';
  assert.equal((await probes.readIsland({ actor })).code, 'ISLAND_REGISTRATION_MISMATCH');
  value = registration(); value.seaMaps.push(structuredClone(value.seaMaps[0]));
  assert.equal((await probes.readIsland({ actor })).matched, false);
  value = { seaMaps: [] }; assert.equal((await probes.readIsland({ actor })).code, 'ISLAND_REGISTRATION_MISSING');
  value = { seaMaps: 'EXAMPLE_INVALID' }; assert.equal((await probes.readIsland({ actor })).available, false);
  value = registration(); value.seaMaps[0].metadata.info.version = '0.0.0';
  assert.equal((await probes.readIsland({ actor })).matched, false);
});

test('probes require current Tower admin auth and a single exact trusted HTTPS origin', async () => {
  let calls = 0;
  const probes = createDeploymentProbes({ ...options, registry: async () => { calls++; }, fetchImpl: async () => { calls++; } });
  for (const identity of [null, { ...actor, admin: false }, { ...actor, source: 'cli' }, { ...actor, auth: {} }]) {
    assert.equal((await probes.readIsland({ actor: identity })).code, 'DEPLOYMENT_PROBE_AUTH_UNAVAILABLE');
    assert.equal((await probes.readGateway({ actor: identity })).code, 'DEPLOYMENT_PROBE_AUTH_UNAVAILABLE');
  }
  for (const origins of [[], ['http://tower.example.invalid'], ['https://tower.example.invalid/path'], ['https://a.example.invalid','https://b.example.invalid'], ['https://user:password@tower.example.invalid']]) {
    const invalid = createDeploymentProbes({ ...options, origins, fetchImpl: async () => { calls++; } });
    assert.equal((await invalid.readGateway({ actor })).code, 'GATEWAY_ORIGIN_UNAVAILABLE');
  }
  assert.equal(calls, 0);
  for (const certificatePin of ['', 'INVALID_PIN', 'A'.repeat(64), 'a'.repeat(63)]) {
    const invalid = createDeploymentProbes({ ...options, certificatePin, fetchImpl: async () => { calls++; } });
    assert.equal((await invalid.readGateway({ actor })).code, 'GATEWAY_TRUST_INVALID');
  }
  assert.equal(calls, 0);
});

test('gateway binds fresh challenge, version and backend instance; status/HTML/oversize/foreign instances never pass', async () => {
  let respond, calls = 0;
  const probes = createDeploymentProbes({ ...options, fetchImpl: async (url, request) => {
    calls++; assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error'); assert.equal(url.origin, options.origins[0]);
    assert.equal(url.pathname, '/api/rivetin/v1/components/status'); assert.equal(request.headers.Authorization, actor.auth.Authorization);
    assert.equal(Object.keys(request.headers).join(), 'Authorization'); assert.ok(request.signal);
    return respond(url.searchParams.get('probe'));
  } });
  respond = nonce => Response.json(probes.reply(nonce)); assert.equal((await probes.readGateway({ actor })).matched, true);
  const foreign = createDeploymentProbes(options);
  respond = nonce => Response.json(foreign.reply(nonce)); assert.equal((await probes.readGateway({ actor })).matched, false);
  respond = nonce => Response.json({ ...probes.reply(nonce), challenge: '0'.repeat(32) }); assert.equal((await probes.readGateway({ actor })).matched, false);
  respond = () => new Response('login', { headers: { 'Content-Type': 'text/html' } }); assert.equal((await probes.readGateway({ actor })).matched, false);
  respond = () => new Response('[]', { status: 404 }); assert.equal((await probes.readGateway({ actor })).code, 'GATEWAY_HTTP_FAILED');
  respond = () => new Response(null, { status: 403 }); assert.equal((await probes.readGateway({ actor })).available, false);
  respond = () => new Response(' '.repeat(4097), { headers: { 'Content-Type': 'application/json' } }); assert.equal((await probes.readGateway({ actor })).code, 'GATEWAY_RESPONSE_MISMATCH');
  assert.equal(calls, 7);
});

test('TLS, timeout and registry authorization errors remain distinct unknown reasons with no retries or diagnostics leaked', async () => {
  for (const [failure, expected] of [[Object.assign(new Error('EXAMPLE_PRIVATE_PATH'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), 'GATEWAY_TLS_UNTRUSTED'], [new DOMException('EXAMPLE_PRIVATE', 'TimeoutError'), 'DEPLOYMENT_PROBE_TIMEOUT'], [new Error('EXAMPLE_PRIVATE'), 'GATEWAY_UNREACHABLE']]) {
    let calls = 0;
    const probes = createDeploymentProbes({ ...options, fetchImpl: async () => { calls++; throw failure; } });
    const value = await probes.readGateway({ actor }); assert.equal(value.available, false); assert.equal(value.code, expected); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(value), /EXAMPLE_PRIVATE/);
  }
  const probes = createDeploymentProbes({ ...options, registry: async () => { throw Object.assign(new Error('EXAMPLE_PRIVATE'), { status: 401 }); } });
  assert.equal((await probes.readIsland({ actor })).code, 'DEPLOYMENT_PROBE_FORBIDDEN');
});

test('Tower registry reader performs only a fixed authenticated GET with bounded JSON and no new POST or caller-selected URL', async () => {
  let calls = 0;
  const tower = createTowerConnection({ baseUrl: 'http://tower.example.invalid', fetchImpl: async (url, request) => {
    calls++; assert.equal(url.toString(), 'http://tower.example.invalid/api/island-registry/sea-maps?refreshCache=true');
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error'); assert.equal(request.body, undefined);
    assert.deepEqual(request.headers, { Authorization: actor.auth.Authorization }); return Response.json(registration());
  } });
  assert.deepEqual(await tower.islandRegistry(actor), registration()); assert.equal(calls, 1);
  await assert.rejects(tower.islandRegistry({ ...actor, admin: false }), /AUTH_UNAVAILABLE/); assert.equal(calls, 1);
});

test('actual HTTP component route probes are non-recursive, admin-only and leave persistent files unchanged', async t => {
  const f = await fixture(t); let service, normal = 0, probes = 0, identity = actor;
  const server = http.createServer(async (request, response) => {
    if (new URL(request.url, 'http://localhost').searchParams.has('probe')) probes++; else normal++;
    await handler(request, response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const deployment = createDeploymentProbes({ ...options, registry: async () => registration(),
    // Test-only routing injection: actual local HTTP traverses the production route.
    // Production keeps the configured HTTPS origin and normal TLS validation.
    fetchImpl: (url, request) => fetch(base + url.pathname + url.search, request) });
  service = createService(f.directory, { towerBuild: '4.9.0', componentProbes: deployment });
  const handler = createApi(service, { origins: [base], authenticate: async () => identity });
  async function files(directory) {
    const result = {};
    for (const name of await readdir(directory, { recursive: true })) {
      try { result[name] = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex'); } catch (error) { if (!['EISDIR','EPERM'].includes(error.code)) throw error; }
    }
    return result;
  }
  const before = await files(f.directory);
  const response = await fetch(base + '/api/rivetin/v1/components/status?fresh=true'); assert.equal(response.status, 200);
  const status = await response.json();
  for (const id of ['island-registration','gateway','api-components']) assert.equal(row(status, id).status, 'ok');
  assert.equal(normal, 1); assert.equal(probes, 2);
  assert.deepEqual(await files(f.directory), before);
  assert.doesNotMatch(JSON.stringify(status), /EXAMPLE_NOT_A_REAL_TOKEN|instance|challenge/);
  identity = { ...actor, admin: false };
  assert.equal((await fetch(base + '/api/rivetin/v1/components/status?probe=' + 'a'.repeat(32))).status, 403);
  identity = actor;
  for (const suffix of ['probe=invalid', 'probe=' + 'a'.repeat(32) + '&fresh=true']) assert.equal((await fetch(base + '/api/rivetin/v1/components/status?' + suffix)).status, 400);
});
