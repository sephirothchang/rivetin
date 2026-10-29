import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, actor } from './helpers.js';
import { createApi } from '../server/http.js';
import { createService } from '../server/service.js';

async function api(t) {
  const f = await fixture(t); await f.install();
  let identity = actor;
  const handler = createApi(f.service, { authenticate: async () => identity, origins: ['https://tower.example.invalid'] });
  const server = http.createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rivetin/v1${route}`, { method, headers: { Origin: 'https://tower.example.invalid', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  return { ...f, call, identity(value) { identity = value; } };
}

test('component APIs work while globally disabled, require admin and perform read-only checks', async t => {
  const f = await api(t);
  const before = await readFile(path.join(f.directory, 'plugins/rivetin-example/state.json'));
  const result = await f.call('/components/status?fresh=true'); assert.equal(result.status, 200);
  assert.equal(result.value.schemaVersion, 1); assert.equal(result.value.components.length, 17);
  assert.equal(result.value.components.find(item => item.id === 'gateway').status, 'unknown');
  assert.equal(result.value.components.some(item => item.id === 'api-smart'), false);
  assert.equal(result.value.components.find(item => item.id === 'api-market').code, 'API_PROBE_UNCONFIRMED');
  assert.deepEqual(await readFile(path.join(f.directory, 'plugins/rivetin-example/state.json')), before);
  f.identity({ ...actor, admin: false });
  for (const route of ['/components/status', '/components/support']) assert.equal((await f.call(route)).status, 403);
  f.identity(actor); assert.equal((await f.call('/components/status?fresh=false')).status, 400);
});

test('market component probes the read-only listing and keeps unavailable sources unknown without writes', async t => {
  const f = await api(t);
  let unavailable = false, reads = 0, downloads = 0;
  const service = createService(f.directory, { towerBuild: '4.9.0', updateSource: {
    market: async () => { reads++; if (unavailable) throw new Error('UPDATE_SOURCE_ACCESS_REQUIRED'); return []; },
    download: async () => { downloads++; throw new Error('UNEXPECTED_DOWNLOAD'); },
  } });
  const files = async root => {
    const entries = await readdir(root, { withFileTypes: true }), output = [];
    for (const entry of entries) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) output.push(...(await files(file)));
      else output.push([file, createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
    return output.sort(([a], [b]) => a.localeCompare(b));
  };
  const before = await files(f.directory);
  const healthy = await service.components.status(actor, { fresh: true });
  assert.equal(healthy.components.find(item => item.id === 'api-market').status, 'ok');
  unavailable = true;
  const failed = await service.components.status(actor, { fresh: true });
  assert.equal(failed.components.find(item => item.id === 'api-market').status, 'unknown');
  assert.equal(failed.components.find(item => item.id === 'api-market').code, 'API_PROBE_UNCONFIRMED');
  assert.equal(reads, 2); assert.equal(downloads, 0);
  assert.deepEqual(await files(f.directory), before);
});

test('unified support download contains only projected metadata and anonymous log references', async t => {
  const f = await api(t);
  const result = await f.call('/components/support'); assert.equal(result.status, 200);
  const bytes = Buffer.from(result.value.data, 'base64'); assert.equal(bytes.length, result.value.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.value.sha256);
  const text = gunzipSync(bytes).toString(), support = JSON.parse(text);
  assert.equal(support.plugins.items.length, 1); assert.equal(support.components.items.length, 17);
  assert.ok(support.logs.items.length > 0); assert.equal(text.includes(actor.id), false); assert.equal(text.includes(actor.name), false);
  assert.equal(text.includes('settings'), false); assert.equal(text.includes(f.directory.replaceAll('\\', '\\\\')), false);
  assert.equal((await readdir(f.directory)).includes('support'), false);
});

test('repair and reset retain independent plugin settings, disable all and replay without duplicate mutations', async t => {
  const f = await api(t); await f.service.enable(actor); await f.service.change('enable', 'rivetin-example', null, actor);
  const configFile = path.join(f.directory, 'plugins/rivetin-example/config.json'), before = await readFile(configFile);
  const input = { operationId: randomUUID(), acknowledged: true };
  const repaired = await f.call('/components/repair', 'POST', input); assert.equal(repaired.status, 200);
  assert.ok(['success', 'partial'].includes(repaired.value.result));
  assert.equal((await f.service.runtime()).enabled, false); assert.equal((await f.service.plugins())[0].enabled, false);
  assert.deepEqual(await readFile(configFile), before);
  const duplicate = await f.call('/components/repair', 'POST', input); assert.deepEqual(duplicate.value, repaired.value);
  assert.equal((await f.call('/components/reset', 'POST', input)).status, 409);
  const reset = await f.call('/components/reset', 'POST', { ...input, operationId: randomUUID() }); assert.equal(reset.status, 200);
  assert.deepEqual(await readFile(configFile), before);
  assert.equal((await f.service.plugins())[0].installed, true);
});

test('support export rejects corrupted journal identifiers without reading arbitrary files', async t => {
  const f = await api(t);
  await writeFile(path.join(f.directory, 'audit.jsonl'), JSON.stringify({ id: '../EXAMPLE_SECRET', actor: { id: 'EXAMPLE' } }) + '\n');
  const result = await f.call('/components/support'); assert.equal(result.status, 400); assert.equal(result.value.error, 'SUPPORT_JOURNAL_INVALID');
});

test('Web repair never upgrades old metadata in place or bypasses the explicit CLI migration gate', async t => {
  const f = await api(t), file = path.join(f.directory, 'framework/settings.json');
  const original = { version: '0.1.5', apiVersion: 1, initializedAt: 'EXAMPLE_ORIGINAL_TIME' };
  await writeFile(file, JSON.stringify(original));
  const result = await f.call('/components/repair', 'POST', { operationId: randomUUID(), acknowledged: true });
  assert.equal(result.status, 200); assert.equal(result.value.result, 'partial');
  assert.equal(result.value.outcomes.find(item => item.id === 'repair').status, 'failed');
  assert.deepEqual(JSON.parse(await readFile(file)), original);
});
