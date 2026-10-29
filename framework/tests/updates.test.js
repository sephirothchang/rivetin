import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateSource, newer } from '../server/updates.js';
import { bundle as baseBundle, fixture, actor } from './helpers.js';
import { hash, MAX_PACKAGE_BYTES } from '../server/manifest.js';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { Readable } from 'node:stream';

const id = 'rivetin-example';
const catalogURL = 'https://rivetin.dev/catalog/v4/plugins.json';
const path = (pluginId = id, version = '0.1.1') => `/downloads/plugins/${pluginId}/${version}/${pluginId}-${version}.rivetin.json`;
const bundle = (pluginId = id, version = '0.1.0', mutate = value => value) => baseBundle(pluginId, version, value => {
  value.manifest.compatibility.towerBuilds = ['4.9.0']; return mutate(value);
});
const item = (bytes, patch = {}) => {
  const manifest = JSON.parse(bytes).manifest;
  return { id, version: '0.1.1', frameworkApi: 1, status: 'published', downloadPath: path(), sha256: hash(bytes), name: manifest.name, description: manifest.description,
    author: manifest.author, license: manifest.license, permissions: manifest.permissions, compatibility: manifest.compatibility, ...patch };
};
const envelope = (plugins, schemaVersion = 4) => new Response(JSON.stringify({ schemaVersion, plugins }), { status: 200 });
const publishedSource = (bytes, row = item(bytes), extra = {}) => createUpdateSource({ fetchImpl: async url => url === catalogURL ? envelope([row]) : new Response(bytes), ...extra });

test('update versions compare numerically and reject ambiguous formats', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true); assert.equal(newer('1.0.0', '0.99.99'), true);
  for (const value of ['0.1.0', '0.0.9', '01.2.3', '1.2.3-rc', '1.2', '', null]) assert.equal(newer(value, '0.1.0'), false);
  assert.equal(newer('0.1.1', '01.0.0'), false);
});

test('official catalog and package paths are fixed and requests never contain credentials', async () => {
  const bytes = bundle(id, '0.1.1'), calls = [];
  const source = createUpdateSource({ token: 'EXAMPLE_IGNORED_NOT_A_REAL_TOKEN', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return url === catalogURL ? envelope([item(bytes)]) : new Response(bytes);
  } });
  assert.equal((await source.catalog())[0].version, '0.1.1'); assert.deepEqual(await source.download(id, '0.1.1'), bytes);
  assert.deepEqual(calls.map(call => call.url), [catalogURL, 'https://rivetin.dev' + path()]);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.options.headers).sort(), ['Accept', 'User-Agent']);
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'manual'); assert.equal(call.options.credentials, 'omit'); assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(call).includes('EXAMPLE_IGNORED'));
  }
  assert.equal(calls[0].options.headers.Accept, 'application/json'); assert.equal(calls[1].options.headers.Accept, 'application/octet-stream');
});

test('market exposes only published canonical downloads and retrieves a plugin without installation', async () => {
  const bytes = bundle(id, '0.1.1');
  const draft = item(bytes, { id: 'rivetin-unpublished', status: 'draft', downloadPath: null, sha256: null, compatibility: JSON.parse(bytes).manifest.compatibility });
  const source = createUpdateSource({ fetchImpl: async url => url === catalogURL ? envelope([item(bytes), draft]) : new Response(bytes) });
  assert.equal((await source.catalog()).length, 2); assert.deepEqual(await source.market(), [item(bytes)]);
  assert.deepEqual(await source.download(id, '0.1.1'), bytes);
  await assert.rejects(source.download('rivetin-unpublished', '0.1.1'), { message: 'UPDATE_PACKAGE_UNPUBLISHED' });
});

test('legacy catalog schemas and API envelopes are rejected with no domain fallback', async () => {
  for (const response of [() => envelope([], 1), () => envelope([], 2), () => envelope([], 3), () => new Response(JSON.stringify({ encoding: 'base64', content: 'EXAMPLE_NOT_A_CATALOG' }))]) {
    const calls = [], source = createUpdateSource({ fetchImpl: async url => { calls.push(url); return response(); } });
    await assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' });
    assert.deepEqual(calls, [catalogURL]);
  }
});

test('v4 requires compatibility schema two for every row including drafts and cannot downgrade to v3', async () => {
  const bytes = bundle(id, '0.1.1'), declaration = JSON.parse(bytes).manifest.compatibility;
  for (const status of ['draft', 'published']) for (const compatibility of [
    { ...declaration, schemaVersion: undefined }, { ...declaration, schemaVersion: 1 },
    { ...declaration, schemaVersion: 3 }, { frameworkApi: 1, tower: 'Legacy display only.' },
    { ...declaration, frameworkMinVersion: undefined }, { ...declaration, towerBuilds: [] },
  ]) {
    const row = item(bytes, { status, ...(status === 'draft' ? { downloadPath: null, sha256: null } : {}), compatibility }), calls = [];
    const source = createUpdateSource({ fetchImpl: async url => { calls.push(url); return envelope([row]); } });
    assert.equal((await source.probe()).reachable, false);
    assert.deepEqual(calls, [catalogURL]);
  }
  const calls = [], legacy = createUpdateSource({ fetchImpl: async url => { calls.push(url); return envelope([item(bytes)], 3); } });
  await assert.rejects(legacy.download(id, '0.1.1'), { message: 'UPDATE_CATALOG_INVALID' });
  assert.deepEqual(calls, [catalogURL]);
});

test('published rows require canonical same-origin relative paths, exact builds and complete reviewed metadata', async () => {
  const bytes = bundle(id, '0.1.1'), declaration = JSON.parse(bytes).manifest.compatibility;
  for (const patch of [
    { status: undefined }, { status: 'local' }, { status: 'published', downloadPath: null, sha256: null }, { status: 'draft' },
    { name: { 'zh-CN': 'Only one language' } }, { description: {} }, { author: '' }, { license: 'GPL' },
    { permissions: ['inventory.read', 'inventory.read'] }, { permissions: ['invalid permission'] },
    { compatibility: { ...declaration, towerBuilds: [] } }, { compatibility: { frameworkApi: 1, tower: 'Legacy text only.' } },
    { compatibility: { ...declaration, towerBuilds: ['4.9.*'] } }, { unexpectedMetadata: true }, { assetId: 123 },
    { id: [id] }, { version: ['0.1.1'] }, { version: '01.1.1' }, { frameworkApi: 99 }, { sha256: [hash(bytes)] },
    { downloadPath: 'https://rivetin.dev' + path() }, { downloadPath: '//rivetin.dev' + path() },
    { downloadPath: path() + '?download=1' }, { downloadPath: path() + '#fragment' },
    { downloadPath: path().replace('/0.1.1/', '/0.1.2/') }, { downloadPath: path().replace(id, 'rivetin-other') },
    { downloadPath: '/downloads/plugins/../' + path() }, { downloadPath: path().replace('/downloads/', '/%64ownloads/') },
  ]) await assert.rejects(publishedSource(bytes, item(bytes, patch)).market(), { message: 'UPDATE_CATALOG_INVALID' });
});

test('malformed envelopes, oversized catalogs and duplicate rows fail closed without diagnostic fragments', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const response of [
    'EXAMPLE_PRIVATE_RESPONSE', 'null', '[]', JSON.stringify({ schemaVersion: 4, plugins: [], unexpected: true }),
    JSON.stringify({ schemaVersion: 4, plugins: [null] }), JSON.stringify({ schemaVersion: 4, plugins: [item(bytes), item(bytes)] }),
    JSON.stringify({ schemaVersion: 4, plugins: Array.from({ length: 501 }, () => item(bytes)) }),
  ]) await assert.rejects(createUpdateSource({ fetchImpl: async () => new Response(response) }).catalog(), { message: 'UPDATE_CATALOG_INVALID' });
  await assert.rejects(createUpdateSource({ fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }).catalog(), { message: 'UPDATE_DOWNLOAD_TOO_LARGE' });
});

test('download validates digest, plugin identity, version and publication after fetching official bytes', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const [row, asset, code] of [
    [item(bytes, { sha256: 'a'.repeat(64) }), bytes, 'UPDATE_CHECKSUM_FAILED'],
    [item(bundle('rivetin-other', '0.1.1')), bundle('rivetin-other', '0.1.1'), 'UPDATE_IDENTITY_MISMATCH'],
    [item(bundle(id, '0.1.2')), bundle(id, '0.1.2'), 'UPDATE_IDENTITY_MISMATCH'],
    [item(bytes, { status: 'draft', downloadPath: null, sha256: null }), bytes, 'UPDATE_PACKAGE_UNPUBLISHED'],
  ]) await assert.rejects(publishedSource(asset, row).download(id, '0.1.1'), { message: code });
});

test('download requires exact reviewed metadata, permissions and machine compatibility', async () => {
  const bytes = bundle(id, '0.1.1'), declaration = JSON.parse(bytes).manifest.compatibility;
  for (const patch of [
    { name: { 'zh-CN': 'Different name', 'en-US': 'Different name' } },
    { description: { 'zh-CN': 'Different purpose', 'en-US': 'Different purpose' } },
    { author: 'Different maintainer' }, { permissions: ['inventory.read'] },
    { compatibility: { ...declaration, towerBuilds: ['4.8.0'] } },
    { compatibility: { ...declaration, frameworkMinVersion: '0.1.1' } },
  ]) await assert.rejects(publishedSource(bytes, item(bytes, patch)).download(id, '0.1.1'), { message: 'UPDATE_METADATA_MISMATCH' });
  const legacy = bundle(id, '0.1.1', value => { value.manifest.compatibility = { frameworkApi: 1, tower: 'Legacy display-only declaration.' }; return value; });
  await assert.rejects(publishedSource(legacy, item(bytes, { sha256: hash(legacy) })).download(id, '0.1.1'), { message: 'UPDATE_METADATA_MISMATCH' });
});

test('reviewed build and permission ordering does not change metadata equivalence', async () => {
  const bytes = bundle(id, '0.1.1', value => { value.manifest.permissions = ['inventory.read', 'ui.context-menu']; value.manifest.compatibility.towerBuilds = ['4.8.0', '4.9.0']; return value; });
  const row = item(bytes); row.permissions.reverse(); row.compatibility.towerBuilds.reverse();
  assert.deepEqual(await publishedSource(bytes, row).download(id, '0.1.1'), bytes);
});

test('deprecated upper metadata has no download fingerprint meaning; minimum remains exact', async () => {
  const bytes = bundle(id, '0.1.1', value => { value.manifest.compatibility.frameworkMinVersion = '0.2.4'; return value; });
  const row = item(bytes); delete row.compatibility.frameworkMaxVersionExclusive;
  assert.deepEqual(await publishedSource(bytes, row).download(id, '0.1.1'), bytes);
  const changed = item(bytes); changed.compatibility.frameworkMaxVersionExclusive = '0.0.1';
  assert.deepEqual(await publishedSource(bytes, changed).download(id, '0.1.1'), bytes);
  changed.compatibility.frameworkMinVersion = '0.2.5';
  await assert.rejects(publishedSource(bytes, changed).download(id, '0.1.1'), { message: 'UPDATE_METADATA_MISMATCH' });
});

test('catalog and package redirects cannot leave the exact official canonical path', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const location of [
    'https://untrusted.example.invalid/asset', 'http://rivetin.dev' + path(), 'https://www.rivetin.dev' + path(),
    'https://rivetin.dev:444' + path(), 'https://example@rivetin.dev' + path(), 'https://rivetin.dev@untrusted.example.invalid/asset',
    'https://rivetin.dev' + path() + '?signed=anything', 'https://rivetin.dev' + path() + '#fragment',
    'https://rivetin.dev/downloads/plugins/other/0.1.1/other.rivetin.json',
    'https://github.com/sephirothchang/rivetin/releases/download/example/asset',
    'https://raw.githubusercontent.com/sephirothchang/rivetin/main/catalog/plugins.json',
    'https://release-assets.githubusercontent.com/EXAMPLE_ASSET', 'https://api.github.com/repos/sephirothchang/rivetin',
  ]) {
    const calls = [], source = createUpdateSource({ fetchImpl: async url => { calls.push(url); return url === catalogURL ? envelope([item(bytes)]) : new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(source.download(id, '0.1.1'), { message: 'UPDATE_REDIRECT_REJECTED' }); assert.equal(calls.length, 2);
  }
  for (const location of ['https://rivetin.dev/catalog/other.json', 'https://rivetin.dev/catalog/plugins.json?ref=main', 'https://github.com/sephirothchang/rivetin']) {
    let calls = 0;
    const source = createUpdateSource({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(source.catalog(), { message: 'UPDATE_REDIRECT_REJECTED' }); assert.equal(calls, 1);
  }
});

test('same-canonical-path redirects are rejected without retry and package sizes remain bounded', async () => {
  let calls = 0;
  const source = createUpdateSource({ fetchImpl: async url => { calls++; return new Response(null, { status: 302, headers: { location: url } }); } });
  await assert.rejects(source.catalog(), { message: 'UPDATE_REDIRECT_REJECTED' }); assert.equal(calls, 1);
  const bytes = bundle(id, '0.1.1');
  const large = createUpdateSource({ fetchImpl: async url => url === catalogURL ? envelope([item(bytes)]) : new Response('x'.repeat(MAX_PACKAGE_BYTES + 1)) });
  await assert.rejects(large.download(id, '0.1.1'), { message: 'UPDATE_DOWNLOAD_TOO_LARGE' });
});

test('every redirect response is rejected once for both catalog and packages, even to the same v4 URL', async () => {
  const bytes = bundle(id, '0.1.1');
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308]) {
    const calls = [], source = createUpdateSource({ fetchImpl: async url => { calls.push(url); return new Response(null, { status, headers: { location: catalogURL } }); } });
    await assert.rejects(source.catalog(), { message: 'UPDATE_REDIRECT_REJECTED' }); assert.deepEqual(calls, [catalogURL]);
    const packageCalls = [], packageSource = createUpdateSource({ fetchImpl: async url => { packageCalls.push(url); return url === catalogURL ? envelope([item(bytes)]) : new Response(null, { status, headers: { location: url } }); } });
    await assert.rejects(packageSource.download(id, '0.1.1'), { message: 'UPDATE_REDIRECT_REJECTED' });
    assert.deepEqual(packageCalls, [catalogURL, 'https://rivetin.dev' + path()]);
  }
});

test('only validated catalogs cache for sixty seconds and concurrent callers receive independent deep clones', async () => {
  const bytes = bundle(id, '0.1.1'); let clock = 1000, calls = 0, release;
  const source = createUpdateSource({ now: () => clock, fetchImpl: async () => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : envelope([item(bytes)]); } });
  const a = source.catalog(), b = source.market(); assert.equal(calls, 1); release(envelope([item(bytes)]));
  const [first, second] = await Promise.all([a, b]);
  first[0].name['en-US'] = 'changed'; first[0].permissions.push('ui.context-menu'); second[0].compatibility.towerBuilds[0] = '4.8.0';
  assert.deepEqual(await source.catalog(), [item(bytes)]); assert.equal(calls, 1);
  clock = 60999; assert.deepEqual(await source.market(), [item(bytes)]); assert.equal(calls, 1);
  clock = 61000; assert.deepEqual(await source.catalog(), [item(bytes)]); assert.equal(calls, 2);
});

test('invalid catalogs never enter the cache and a later valid explicit request can recover', async () => {
  let valid = false, calls = 0;
  const source = createUpdateSource({ fetchImpl: async () => { calls++; return valid ? envelope([]) : envelope([], 2); } });
  await assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' });
  await assert.rejects(source.market(), { message: 'UPDATE_CATALOG_INVALID' }); assert.equal(calls, 2);
  valid = true; assert.deepEqual(await source.catalog(), []); assert.equal(calls, 3);
  await source.catalog(); assert.equal(calls, 3);
});

test('an expired catalog that becomes invalid is never served stale and concurrent failures issue one request', async () => {
  let clock = 1000, valid = true, calls = 0, release;
  const source = createUpdateSource({ now: () => clock, fetchImpl: async () => {
    calls++;
    if (calls === 2) return new Promise(resolve => { release = resolve; });
    return valid ? envelope([]) : envelope([], 2);
  } });
  assert.deepEqual(await source.catalog(), []);
  valid = false; clock = 61000;
  const a = assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' });
  const b = assert.rejects(source.market(), { message: 'UPDATE_CATALOG_INVALID' });
  assert.equal(calls, 2); release(envelope([], 2)); await Promise.all([a, b]);
  await assert.rejects(source.catalog(), { message: 'UPDATE_CATALOG_INVALID' }); assert.equal(calls, 3);
});

test('mutating returned market paths and digests cannot redirect or alter a later download', async () => {
  const bytes = bundle(id, '0.1.1'), calls = [];
  const source = createUpdateSource({ fetchImpl: async url => { calls.push(url); return url === catalogURL ? envelope([item(bytes)]) : new Response(bytes); } });
  const rows = await source.market(); rows[0].downloadPath = 'https://untrusted.example.invalid/asset'; rows[0].sha256 = 'a'.repeat(64);
  assert.deepEqual(await source.download(id, '0.1.1'), bytes);
  assert.deepEqual(calls, [catalogURL, 'https://rivetin.dev' + path()]);
});

test('expired source probes force fresh detection and invalidate cached success on failure', async () => {
  let clock = 1000, available = true, calls = 0;
  const source = createUpdateSource({ now: () => clock, fetchImpl: async () => { calls++; return available ? envelope([]) : new Response('EXAMPLE_PRIVATE', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }); } });
  assert.equal((await source.probe()).reachable, true); assert.equal(calls, 1);
  available = false; clock = 30999; assert.equal((await source.probe()).reachable, true); assert.equal(calls, 1);
  clock = 31000; assert.deepEqual(await source.probe(), { reachable: false, checkedAt: new Date(clock).toISOString(), reason: 'UPDATE_SOURCE_RATE_LIMITED' }); assert.equal(calls, 2);
  await assert.rejects(source.catalog(), { message: 'UPDATE_SOURCE_RATE_LIMITED' }); assert.equal(calls, 3, 'the previous sixty-second catalog cannot mask a failed fresh probe');
  available = true; clock = 60999; assert.equal((await source.probe()).reachable, false); assert.equal(calls, 3);
  clock = 61000; assert.equal((await source.probe()).reachable, true); assert.equal(calls, 4);
});

test('probe merges its source request with simultaneous catalog readers and protects returned results', async () => {
  let release, calls = 0;
  const source = createUpdateSource({ now: () => 1000, fetchImpl: async url => { assert.equal(url, catalogURL); calls++; return new Promise(resolve => { release = resolve; }); } });
  const a = source.probe(), b = source.probe(), c = source.catalog(); assert.equal(calls, 1); release(envelope([]));
  const [first, second, rows] = await Promise.all([a, b, c]);
  assert.deepEqual(first, { reachable: true, checkedAt: new Date(1000).toISOString() }); assert.deepEqual(second, first); assert.deepEqual(rows, []);
  first.reachable = false; assert.equal((await source.probe()).reachable, true);
});

test('rate limits are distinguished from permission failures without response text or automatic retries', async () => {
  for (const [status, headers, expected] of [[429, {}, 'UPDATE_SOURCE_RATE_LIMITED'], [403, { 'x-ratelimit-remaining': '0' }, 'UPDATE_SOURCE_RATE_LIMITED'],
    [403, { 'retry-after': '60' }, 'UPDATE_SOURCE_RATE_LIMITED'], [401, {}, 'UPDATE_SOURCE_ACCESS_REQUIRED'], [403, {}, 'UPDATE_SOURCE_ACCESS_REQUIRED'], [404, {}, 'UPDATE_SOURCE_ACCESS_REQUIRED'], [500, {}, 'UPDATE_SOURCE_UNAVAILABLE']]) {
    let calls = 0;
    const source = createUpdateSource({ fetchImpl: async () => { calls++; return new Response('EXAMPLE_PRIVATE_RESPONSE', { status, headers }); } });
    assert.deepEqual(await source.probe(), { reachable: false, checkedAt: (await source.probe()).checkedAt, reason: expected });
    assert.equal(calls, 1);
  }
});

test('transport and malformed JSON errors are sanitized and failed probes retain only the short result cache', async () => {
  for (const fetchImpl of [async () => { throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); }, async () => new Response('EXAMPLE_PRIVATE_BODY'), async () => { throw new Error('UPDATE_EXAMPLE_PRIVATE_DIAGNOSTIC'); }]) {
    const result = await createUpdateSource({ fetchImpl }).probe();
    assert.equal(result.reachable, false); assert.ok(['UPDATE_SOURCE_UNAVAILABLE', 'UPDATE_CATALOG_INVALID'].includes(result.reason));
    assert.ok(!JSON.stringify(result).includes('EXAMPLE'));
  }
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
