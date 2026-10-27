import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/service.js';
import { createTowerVersionProvider } from '../server/tower-version.js';
import { fixture, bundle, actor } from './helpers.js';
import { hash } from '../server/manifest.js';

async function marketFixture(t) {
  const { directory } = await fixture(t), bytes = bundle(), manifest = JSON.parse(bytes).manifest;
  const item = { ...manifest, sha256: hash(bytes), status: 'published', assetId: 123 };
  let version = '4.9.0', available = true, calls = 0, payload = bytes;
  const source = { market: async () => available ? [item] : [], download: async () => { calls++; return payload; } };
  const service = createService(directory, { updateSource: source, towerVersionProvider: async () => version });
  return { service, item, bytes, setVersion: value => { version = value; }, unpublished: () => { available = false; }, replacePayload: value => { payload = value; }, downloads: () => calls };
}

test('market install verifies published identity and remains disabled until separate enable', async t => {
  const f = await marketFixture(t);
  const listing = await f.service.marketplace(actor);
  assert.equal(listing.items[0].compatible, true); assert.equal(listing.items[0].installed, false);
  const installed = await f.service.installFromMarket(f.item.id, f.item.version, actor);
  assert.equal(installed.installed, true); assert.equal(installed.enabled, false);
  await f.service.enable(actor);
  assert.equal((await f.service.plugins())[0].active, false);
  assert.equal((await f.service.marketplace(actor)).items[0].installed, true);
  await assert.rejects(f.service.installFromMarket(f.item.id, f.item.version, actor), /INVALID_TRANSITION/);
});

test('all package entry paths reject undeclared, incompatible and unknown Tower versions', async t => {
  for (const version of [null, '4.10.0']) {
    const f = await marketFixture(t); f.setVersion(version);
    assert.equal((await f.service.marketplace(actor)).items[0].compatible, false);
    await assert.rejects(f.service.installFromMarket(f.item.id, f.item.version, actor), /TOWER_BUILD_UNKNOWN|PLUGIN_INCOMPATIBLE/);
    assert.equal(f.downloads(), 0);
    const uploaded = await f.service.upload(f.bytes, actor);
    await assert.rejects(f.service.change('install', f.item.id, uploaded.packageId, actor), /TOWER_BUILD_UNKNOWN|PLUGIN_INCOMPATIBLE/);
  }
  const f = await marketFixture(t);
  const legacy = bundle('rivetin-legacy', '0.1.0', pkg => { delete pkg.manifest.compatibility.towerBuilds; return pkg; });
  const uploaded = await f.service.upload(legacy, actor);
  await assert.rejects(f.service.change('install', 'rivetin-legacy', uploaded.packageId, actor), /PLUGIN_COMPATIBILITY_UNDECLARED/);
});

test('host version drift pauses active code and blocks assets and enable without altering plugin config', async t => {
  const f = await marketFixture(t);
  await f.service.installFromMarket(f.item.id, f.item.version, actor); await f.service.enable(actor); await f.service.change('enable', f.item.id, null, actor);
  const before = await f.service.loadConfig(); assert.equal((await f.service.plugins())[0].active, true);
  f.setVersion('4.10.0');
  assert.equal((await f.service.plugins())[0].active, false);
  await assert.rejects(f.service.asset(f.item.id, f.item.sha256, 'web/plugin.js'), /PLUGIN_INCOMPATIBLE/);
  await assert.rejects(f.service.change('enable', f.item.id, null, actor), /PLUGIN_INCOMPATIBLE/);
  assert.deepEqual(await f.service.loadConfig(), before);
});

test('market refuses unpublished and swapped payloads before committing an installed pointer', async t => {
  const f = await marketFixture(t); f.unpublished();
  await assert.rejects(f.service.installFromMarket(f.item.id, f.item.version, actor), /UPDATE_PACKAGE_UNPUBLISHED/);
  assert.equal(f.downloads(), 0);
  const other = await marketFixture(t); other.replacePayload(bundle('rivetin-another'));
  await assert.rejects(other.service.installFromMarket(other.item.id, other.item.version, actor), /UPDATE_METADATA_MISMATCH/);
  assert.equal((await other.service.plugins()).some(item => item.installed), false);
});

test('market status and source connectivity require administrators', async t => {
  const f = await marketFixture(t), reader = { ...actor, admin: false };
  await assert.rejects(f.service.marketplace(reader), /ADMIN_REQUIRED/);
  await assert.rejects(f.service.updateStatus(reader), /ADMIN_REQUIRED/);
});

test('Tower version detection uses observed public query, bounded cache and fails closed after drift or errors', async () => {
  let at = 0, calls = 0, value = '4.9.0', fail = false;
  const get = createTowerVersionProvider({ now: () => at, request: async (route, body, caller) => {
    calls++; assert.equal(route, '/api'); assert.match(body.query, /deploys\(first: 1\)/); assert.equal(caller, undefined);
    if (fail) throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC');
    return { data: { deploys: [{ version: value }] } };
  } });
  assert.deepEqual(await Promise.all([get(), get()]), ['4.9.0', '4.9.0']); assert.equal(calls, 1);
  value = '4.10.0'; at = 30000; assert.equal(await get(), '4.10.0'); assert.equal(calls, 2);
  fail = true; at += 30000; assert.equal(await get(), null);
  fail = false; value = 'wildcard*'; at += 30000; assert.equal(await get(), null);
});
