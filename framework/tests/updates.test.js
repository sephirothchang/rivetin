import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateSource, newer } from '../server/updates.js';
import { bundle, fixture, actor } from './helpers.js';
import { hash } from '../server/manifest.js';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { Readable } from 'node:stream';

const id = 'pluginkit-example', token = 'EXAMPLE_UPDATE_TOKEN';
const item = (bytes, patch = {}) => ({ id, version: '0.1.1', frameworkApi: 1, assetId: 123, sha256: hash(bytes), ...patch });
function envelope(plugins) {
  return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify({ schemaVersion: 1, plugins })).toString('base64') }), { status: 200 });
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
  assert.equal(calls[0].url, 'https://api.github.com/repos/sephirothchang/smartx-extensions/contents/catalog/plugins.json?ref=main');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(rows).includes(token), false);
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
    [item(bundle('pluginkit-other', '0.1.1')), bundle('pluginkit-other', '0.1.1'), 'UPDATE_IDENTITY_MISMATCH'],
    [item(bundle(id, '0.1.2')), bundle(id, '0.1.2'), 'UPDATE_IDENTITY_MISMATCH'],
    [item(bytes, { assetId: null, sha256: null }), bytes, 'UPDATE_PACKAGE_UNPUBLISHED'],
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
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req, { url: '/api/pluginkit/v1/updates', method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' } });
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
