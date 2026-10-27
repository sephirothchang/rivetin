import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateSource, newer } from '../server/updates.js';
import { bundle as baseBundle, fixture, actor } from './helpers.js';
import { hash } from '../server/manifest.js';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

const id = 'rivetin-example', token = 'EXAMPLE_UPDATE_TOKEN';
const bundle = (pluginId = id, version = '0.1.0', mutate = value => value) => baseBundle(pluginId, version, value => {
  value.manifest.compatibility.towerBuilds = ['4.9.0']; return mutate(value);
});
const item = (bytes, patch = {}) => {
  const manifest = JSON.parse(bytes).manifest;
  return { id, version: '0.1.1', frameworkApi: 1, status: 'published', assetId: 123, sha256: hash(bytes), name: manifest.name, description: manifest.description,
    author: manifest.author, license: manifest.license, permissions: manifest.permissions, compatibility: manifest.compatibility, ...patch };
};
function envelope(plugins, schemaVersion = 2) {
  return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify({ schemaVersion, plugins })).toString('base64') }), { status: 200 });
}
test('update versions compare numerically and reject ambiguous formats', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true);
  assert.equal(newer('1.0.0', '0.99.99'), true);
  for (const value of ['0.1.0', '0.0.9', '01.2.3', '1.2.3-rc', '1.2', '', null]) assert.equal(newer(value, '0.1.0'), false);
  assert.equal(newer('0.1.1', '01.0.0'), false);
});

test('GitHub catalog uses fixed repository API and keeps credentials server-side', async () => {
  const bytes = bundle(id, '0.1.1'), calls = [];
  const source = createUpdateSource({ token, fetchImpl: async (url, options) => { calls.push({ url, options }); return envelope([item(bytes)]); } });
  const rows = await source.catalog(); assert.equal(rows[0].version, '0.1.1');
  assert.equal(calls[0].url, 'https://api.github.com/repos/sephirothchang/rivetin/contents/catalog/plugins.json?ref=main');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(rows).includes(token), false);
});

test('market lists only explicitly published downloads and can retrieve a plugin that is not installed', async () => {
  const bytes = bundle(id, '0.1.1');
  const draft = item(bytes, { id: 'rivetin-unpublished', status: 'draft', assetId: null, sha256: null, compatibility: { frameworkApi: 1, tower: 'Not yet accepted.', towerBuilds: [] } });
  const source = createUpdateSource({ fetchImpl: async url => url.includes('/contents/') ? envelope([item(bytes), draft]) : new Response(bytes) });
  const catalog = await source.catalog(), market = await source.market();
  assert.equal(catalog.length, 2); assert.equal(market.length, 1);
  assert.deepEqual(market[0], { ...item(bytes), id: id });
  assert.deepEqual(await source.download(id, '0.1.1'), bytes);
  await assert.rejects(source.download('rivetin-unpublished', '0.1.1'), { message: 'UPDATE_PACKAGE_UNPUBLISHED' });
});

test('market rejects missing or contradictory publication metadata and untested published builds', async () => {
  const bytes = bundle(id, '0.1.1'), declaration = JSON.parse(bytes).manifest.compatibility;
  for (const patch of [
    { status: undefined }, { status: 'local' }, { status: 'published', assetId: null, sha256: null },
    { status: 'draft' }, { name: { 'zh-CN': 'Only one language' } }, { author: '' }, { license: 'GPL' },
    { permissions: ['inventory.read', 'inventory.read'] }, { permissions: ['invalid permission'] },
    { compatibility: { ...declaration, towerBuilds: [] } }, { compatibility: { frameworkApi: 1, tower: 'Legacy text only.' } },
    { compatibility: { ...declaration, towerBuilds: ['4.9.*'] } }, { unexpectedMetadata: true },
    { id: [id] }, { version: ['0.1.1'] }, { sha256: [hash(bytes)] },
  ]) {
    const source = createUpdateSource({ fetchImpl: async () => envelope([item(bytes, patch)]) });
    await assert.rejects(source.market(), { message: 'UPDATE_CATALOG_INVALID' });
  }
});

test('legacy catalog v1 fails closed instead of guessing machine compatibility or publication', async () => {
  const source = createUpdateSource({ fetchImpl: async () => envelope([{ id, version: '0.1.1', frameworkApi: 1, assetId: null, sha256: null }], 1) });
  await assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' });
  await assert.rejects(source.market(), { message: 'UPDATE_CATALOG_INVALID' });
  assert.equal((await source.probe()).reachable, false);
});

test('download compares the final package to reviewed market metadata, including permission and compatibility changes', async () => {
  const bytes = bundle(id, '0.1.1'), declaration = JSON.parse(bytes).manifest.compatibility;
  for (const patch of [
    { name: { 'zh-CN': 'Different name', 'en-US': 'Different name' } },
    { description: { 'zh-CN': 'Different purpose', 'en-US': 'Different purpose' } },
    { author: 'Different maintainer' }, { permissions: ['inventory.read'] },
    { compatibility: { ...declaration, towerBuilds: ['4.8.0'] } },
    { compatibility: { ...declaration, frameworkMinVersion: '0.1.1' } },
  ]) {
    const source = createUpdateSource({ fetchImpl: async url => url.includes('/contents/') ? envelope([item(bytes, patch)]) : new Response(bytes) });
    await assert.rejects(source.download(id, '0.1.1'), { message: 'UPDATE_METADATA_MISMATCH' });
  }
  const legacy = bundle(id, '0.1.1', value => { delete value.manifest.compatibility.towerBuilds; return value; });
  const source = createUpdateSource({ fetchImpl: async url => url.includes('/contents/') ? envelope([item(bytes, { sha256: hash(legacy) })]) : new Response(legacy) });
  await assert.rejects(source.download(id, '0.1.1'), { message: 'UPDATE_METADATA_MISMATCH' });
});

test('the checked-in catalog validates as v2 and does not invent a released asset', async () => {
  const checkedIn = JSON.parse(await readFile(new URL('../../catalog/plugins.json', import.meta.url), 'utf8'));
  const source = createUpdateSource({ fetchImpl: async () => envelope(checkedIn.plugins, checkedIn.schemaVersion) });
  assert.equal((await source.catalog()).length, checkedIn.plugins.length);
  assert.deepEqual(await source.market(), []);
});

test('metadata equality treats tested build and permission ordering as immaterial', async () => {
  const bytes = bundle(id, '0.1.1', value => {
    value.manifest.permissions = ['inventory.read', 'ui.context-menu'];
    value.manifest.compatibility.towerBuilds = ['4.8.0', '4.9.0']; return value;
  });
  const row = item(bytes); row.permissions.reverse(); row.compatibility.towerBuilds.reverse();
  const source = createUpdateSource({ fetchImpl: async url => url.includes('/contents/') ? envelope([row]) : new Response(bytes) });
  assert.deepEqual(await source.download(id, '0.1.1'), bytes);
});

test('source probe validates the actual catalog and shares one request with concurrent catalog consumers', async () => {
  let clock = 1000, calls = 0, release;
  const source = createUpdateSource({ now: () => clock, fetchImpl: async url => {
    assert.equal(url, 'https://api.github.com/repos/sephirothchang/rivetin/contents/catalog/plugins.json?ref=main');
    calls++;
    if (calls === 1) return new Promise(resolve => { release = resolve; });
    return envelope([]);
  } });
  const first = source.probe(), second = source.probe(), catalog = source.catalog();
  assert.equal(calls, 1); release(envelope([]));
  const [a, b, data] = await Promise.all([first, second, catalog]);
  assert.deepEqual(a, { reachable: true, checkedAt: new Date(1000).toISOString() });
  assert.deepEqual(b, a); assert.deepEqual(data, []);
  a.reachable = false;
  clock = 30999; assert.equal((await source.probe()).reachable, true); assert.equal(calls, 1);
  clock = 31000; assert.equal((await source.probe()).reachable, true); assert.equal(calls, 2);
});

test('failed probe results have a short cache and automatically recover after its TTL', async () => {
  let clock = 1000, available = false, calls = 0;
  const source = createUpdateSource({ token, now: () => clock, fetchImpl: async () => { calls++; return available ? envelope([]) : new Response('EXAMPLE_PRIVATE_RESPONSE', { status: 403 }); } });
  const failed = await source.probe();
  assert.deepEqual(failed, { reachable: false, checkedAt: new Date(clock).toISOString(), reason: 'UPDATE_SOURCE_ACCESS_REQUIRED' });
  available = true; clock = 30999;
  assert.equal((await source.probe()).reachable, false); assert.equal(calls, 1);
  clock = 31000;
  assert.equal((await source.probe()).reachable, true); assert.equal(calls, 2);
});

test('probe treats network, authorization and invalid catalogs as unreachable without exposing diagnostics', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); },
    ...[401, 403, 404].map(status => async () => new Response('EXAMPLE_PRIVATE_RESPONSE', { status })),
    async () => new Response('EXAMPLE_PRIVATE_RESPONSE'),
    async () => new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify({ schemaVersion: 3, plugins: [] })).toString('base64') })),
  ]) {
    const result = await createUpdateSource({ token, fetchImpl }).probe();
    assert.equal(result.reachable, false); assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.ok(['UPDATE_SOURCE_ACCESS_REQUIRED', 'UPDATE_SOURCE_UNAVAILABLE', 'UPDATE_CATALOG_INVALID'].includes(result.reason));
    assert.equal(JSON.stringify(result).includes('EXAMPLE_'), false);
  }
});

test('private or restricted repositories fail explicitly without echoing response bodies', async () => {
  for (const status of [401, 403, 404]) {
    const source = createUpdateSource({ fetchImpl: async () => new Response('EXAMPLE_PRIVATE_RESPONSE', { status }) });
    await assert.rejects(source.catalog(), { message: 'UPDATE_SOURCE_ACCESS_REQUIRED' });
  }
  const source = createUpdateSource({ fetchImpl: async () => { throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); } });
  await assert.rejects(source.catalog(), { message: 'UPDATE_SOURCE_UNAVAILABLE' });
});

test('malformed catalogs, duplicate plugins and invalid assets have safe errors', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const rows of [[null], [item(bytes), item(bytes)], [item(bytes, { version: '01.1.1' })], [item(bytes, { frameworkApi: 99 })], [item(bytes, { assetId: -1 })], [item(bytes, { sha256: 'INVALID_SHA' })]]) {
    const source = createUpdateSource({ fetchImpl: async () => envelope(rows) });
    await assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' });
  }
  for (const response of ['EXAMPLE_PRIVATE_RESPONSE', JSON.stringify({ encoding: 'base64', content: Buffer.from('EXAMPLE_PRIVATE_RESPONSE').toString('base64') })]) {
    const source = createUpdateSource({ fetchImpl: async () => new Response(response) });
    await assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' });
  }
});

test('asset redirects preserve digest verification and strip API credentials at the asset host', async () => {
  const bytes = bundle(id, '0.1.1'), calls = [];
  const source = createUpdateSource({ token, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/contents/')) return envelope([item(bytes)]);
    if (url.includes('/releases/assets/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/EXAMPLE_ASSET' } });
    return new Response(bytes);
  } });
  assert.deepEqual(await source.download(id, '0.1.1'), bytes);
  assert.equal(calls.length, 3); assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[2].options.headers.Authorization, undefined);
  assert.equal(calls[2].options.headers.Accept, 'application/octet-stream');
});

test('untrusted, insecure and cross-repository redirects are refused before following them', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const location of ['https://untrusted.example.invalid/asset', 'http://release-assets.githubusercontent.com/asset', 'https://api.github.com/repos/other/repository/releases/assets/123', 'https://api.github.com@untrusted.example.invalid/asset', 'https://release-assets.githubusercontent.com:444/asset']) {
    let requests = 0;
    const source = createUpdateSource({ token, fetchImpl: async url => {
      requests++;
      return url.includes('/contents/') ? envelope([item(bytes)]) : new Response(null, { status: 302, headers: { location } });
    } });
    await assert.rejects(source.download(id, '0.1.1'), { message: 'UPDATE_REDIRECT_REJECTED' }); assert.equal(requests, 2);
  }
  const source = createUpdateSource({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/catalog' } }) });
  await assert.rejects(source.catalog(), { message: 'UPDATE_REDIRECT_REJECTED' });
});

test('download rejects mismatched digests, plugin IDs, versions and unpublished assets', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const [row, asset, code] of [
    [item(bytes, { sha256: 'a'.repeat(64) }), bytes, 'UPDATE_CHECKSUM_FAILED'],
    [item(bundle('rivetin-other', '0.1.1')), bundle('rivetin-other', '0.1.1'), 'UPDATE_IDENTITY_MISMATCH'],
    [item(bundle(id, '0.1.2')), bundle(id, '0.1.2'), 'UPDATE_IDENTITY_MISMATCH'],
    [item(bytes, { status: 'draft', assetId: null, sha256: null }), bytes, 'UPDATE_PACKAGE_UNPUBLISHED'],
  ]) {
    const source = createUpdateSource({ fetchImpl: async url => url.includes('/contents/') ? envelope([row]) : new Response(asset) });
    await assert.rejects(source.download(id, '0.1.1'), { message: code });
  }
});

test('catalog size and redirect chains are bounded', async () => {
  const oversized = createUpdateSource({ fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) });
  await assert.rejects(oversized.catalog(), { message: 'UPDATE_DOWNLOAD_TOO_LARGE' });
  let requests = 0;
  const loop = createUpdateSource({ fetchImpl: async url => { requests++; return new Response(null, { status: 302, headers: { location: url } }); } });
  await assert.rejects(loop.catalog(), { message: 'UPDATE_SOURCE_UNAVAILABLE' }); assert.equal(requests, 4);
});

test('service checks versions, stages an upgrade without activating it and audits download failures', async t => {
  const { directory, install } = await fixture(t); await install(id, '0.1.0');
  const bytes = bundle(id, '0.1.1'); let fail = false;
  const service = createService(directory, { updateSource: { catalog: async () => [item(bytes)], download: async () => { if (fail) throw new Error('UPDATE_CHECKSUM_FAILED'); return bytes; } } });
  const checked = await service.checkUpdates(actor); assert.equal(checked.items[0].available, true); assert.equal(checked.items[0].downloadable, true);
  const staged = await service.downloadUpdate(id, '0.1.1', actor); assert.equal(staged.manifest.version, '0.1.1');
  assert.equal((await service.plugins())[0].version, '0.1.0');
  fail = true; await assert.rejects(service.downloadUpdate(id, '0.1.1', actor), { message: 'UPDATE_CHECKSUM_FAILED' });
  const events = await service.logs(); assert.ok(events.items.some(event => event.action === 'plugin.download' && event.result === 'failed' && event.code === 'UPDATE_CHECKSUM_FAILED'));
  await assert.rejects(service.downloadUpdate(id, '0.1.0', actor), { message: 'UPDATE_VERSION_MUST_INCREASE' });
});

test('update API requires admin and matching origin and rejects unsupported bodies', async () => {
  const calls = [];
  const handler = createApi({
    checkUpdates: async identity => { calls.push(['check', identity.id]); return { items: [] }; },
    downloadUpdate: async (pluginId, version, identity) => { calls.push(['download', pluginId, version, identity.id]); return { packageId: 'EXAMPLE_PACKAGE' }; },
  }, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers.authorization ? { ...actor, admin: req.headers.authorization === 'EXAMPLE_ADMIN' } : null });
  async function invoke(body, { authorization = 'EXAMPLE_ADMIN', origin = 'https://tower.example.invalid' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req, { url: '/api/rivetin/v1/updates', method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' } });
    const response = { writeHead(status) { this.status = status; }, end(bytes) { this.body = JSON.parse(bytes); } };
    await handler(req, response); return response;
  }
  assert.equal((await invoke({ action: 'check' }, { authorization: '' })).status, 401);
  assert.equal((await invoke({ action: 'check' }, { authorization: 'EXAMPLE_READER' })).status, 403);
  assert.equal((await invoke({ action: 'check' }, { origin: 'https://other.example.invalid' })).status, 403);
  assert.equal((await invoke({ action: 'check', unexpected: true })).status, 400);
  assert.equal((await invoke({ action: 'execute' })).status, 400);
  const checked = await invoke({ action: 'check' }); assert.equal(checked.status, 200); assert.deepEqual(checked.body.items, []);
  const downloaded = await invoke({ action: 'download', pluginId: id, version: '0.1.1' }); assert.equal(downloaded.status, 201);
  assert.deepEqual(calls.at(-1), ['download', id, '0.1.1', actor.id]);
});
