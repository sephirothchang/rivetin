import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnownDigestConsistency, candidateEntry, draftEntry, downloadPath, mergeEntries, serializeCatalog, validateCatalog, verifyReceipt } from '../catalog-package.mjs';
import { fixturePackage, fixtureV4Package, receipt, sha, v4Compatibility } from './catalog-fixtures.mjs';
const empty = () => ({ schemaVersion: 3, plugins: [] });

test('draft derives exact manifest metadata and candidate uses canonical v3 path without claiming a publication proof', () => {
  const bytes = fixturePackage(), manifest = JSON.parse(bytes).manifest, draft = draftEntry(bytes), candidate = candidateEntry(bytes);
  for (const key of ['name', 'description', 'author', 'license', 'permissions', 'compatibility']) assert.deepEqual(draft[key], manifest[key]);
  assert.equal(draft.downloadPath, null); assert.equal(draft.sha256, null); assert.equal(Object.hasOwn(draft, 'assetId'), false);
  assert.equal(candidate.downloadPath, '/downloads/plugins/rivetin-example/0.1.0/rivetin-example-0.1.0.rivetin.json'); assert.equal(candidate.sha256, sha(bytes));
  draft.name['en-US'] = 'CHANGED'; assert.equal(JSON.parse(bytes).manifest.name['en-US'], 'Example plugin');
});

test('v3 exact envelope rejects v2, unknown fields, duplicate IDs, missing builds and draft publication attributes', () => {
  const entry = draftEntry(fixturePackage());
  for (const value of [{ schemaVersion: 2, plugins: [] }, { schemaVersion: 3, plugins: [], extra: true }, { schemaVersion: 3, plugins: [entry, entry] }, { schemaVersion: 3, plugins: [{ ...entry, assetId: null }] }, { schemaVersion: 3, plugins: [{ ...entry, downloadPath: '/downloads/unsafe' }] }]) assert.throws(() => validateCatalog(value));
  const published = candidateEntry(fixturePackage()); published.compatibility.towerBuilds = []; assert.throws(() => validateCatalog({ schemaVersion: 3, plugins: [published] }));
  for (const [id, version] of [['../outside', '0.1.0'], ['rivetin-example', '01.1.0'], ['rivetin-example', '0.1.0?query']]) assert.throws(() => downloadPath(id, version));
});

test('merge replaces one ID, sorts deterministically, rejects downgrades and immutable published version changes', () => {
  const a = draftEntry(fixturePackage('rivetin-a')), z = draftEntry(fixturePackage('rivetin-z'));
  const result = mergeEntries(empty(), [z, a]); assert.deepEqual(result.plugins.map(value => value.id), ['rivetin-a', 'rivetin-z']);
  assert.deepEqual(serializeCatalog(result), serializeCatalog(mergeEntries(empty(), [a, z])));
  const upgrade = draftEntry(fixturePackage('rivetin-a', '0.2.0')); const updated = mergeEntries(result, [upgrade]); assert.equal(updated.plugins.length, 2); assert.equal(updated.plugins[0].version, '0.2.0');
  assert.throws(() => mergeEntries(updated, [a]), /CATALOG_DOWNGRADE_REJECTED/); assert.throws(() => mergeEntries(result, [a, upgrade]), /CATALOG_DUPLICATE_INPUT/);
  const published = candidateEntry(fixturePackage('rivetin-a')); const canonical = mergeEntries(empty(), [published]);
  for (const change of [{ ...published, sha256: 'f'.repeat(64) }, { ...published, name: { ...published.name, 'en-US': 'CHANGED' } }]) assert.throws(() => mergeEntries(canonical, [change]), /CATALOG_SAME_VERSION_IMMUTABLE/);
  assert.throws(() => mergeEntries(canonical, [a]), /CATALOG_PUBLICATION_DOWNGRADE_REJECTED/);
  assert.throws(() => mergeEntries(canonical, [upgrade]), /CATALOG_PUBLICATION_DOWNGRADE_REJECTED/);
  assert.deepEqual(mergeEntries(canonical, [published]), canonical);
});

test('offline website receipt requires exact site/path, actual readback bytes, digest/size, sanitized fields and fresh ISO time after stage', () => {
  const bytes = fixturePackage(), path = downloadPath('rivetin-example', '0.1.0'), proof = receipt(bytes, path), clock = { notBefore: '2026-10-28T12:00:00.000Z', now: Date.parse('2026-10-28T12:02:00.000Z') };
  assert.equal(verifyReceipt(proof, Buffer.from(bytes), bytes, path, clock), true);
  for (const change of [{ ...proof, site: 'https://untrusted.example.invalid' }, { ...proof, path: path + '?secret=EXAMPLE' }, { ...proof, status: 302 }, { ...proof, sha256: 'a'.repeat(64) }, { ...proof, bytes: bytes.length + 1 }, { ...proof, authorization: 'EXAMPLE_NOT_A_REAL_TOKEN' }, { ...proof, verifiedAt: 'invalid' }, { ...proof, verifiedAt: '2026-10-28T11:00:00Z' }, { ...proof, verifiedAt: '2026-10-29T12:00:00Z' }]) assert.throws(() => verifyReceipt(change, bytes, bytes, path, clock));
  assert.throws(() => verifyReceipt(proof, Buffer.concat([bytes, Buffer.from('CHANGED')]), bytes, path, clock));
  assert.throws(() => verifyReceipt(proof, bytes, bytes, path, { now: clock.now }), /SITE_READBACK_TIME_INVALID/);
  assert.throws(() => verifyReceipt({ ...proof, verifiedAt: '2026-02-30T12:00:00Z' }, bytes, bytes, path, { notBefore: '2026-01-01T00:00:00Z', now: Date.parse('2026-03-03T12:00:00Z') }), /SITE_READBACK_TIME_INVALID/);
});

test('v4 is explicitly selected, preserves strict schema 2 metadata and never converts v3 in place', () => {
  for (const patch of [{}, { smtx: 'none' }, { smtx: { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: ['6.3.0'] } }]) {
    const bytes = fixtureV4Package('rivetin-example', '0.2.0', patch), entry = candidateEntry(bytes, 4);
    assert.deepEqual(entry.compatibility, JSON.parse(bytes).manifest.compatibility);
    assert.equal(validateCatalog({ schemaVersion: 4, plugins: [entry] }, 4).plugins[0].compatibility.schemaVersion, 2);
    assert.deepEqual(serializeCatalog({ schemaVersion: 4, plugins: [] }, 4), Buffer.from('{\n  "schemaVersion": 4,\n  "plugins": []\n}\n'));
    assert.throws(() => candidateEntry(bytes), /CATALOG_V4_REQUIRED/);
  }
  assert.throws(() => validateCatalog({ schemaVersion: 3, plugins: [] }, 4), /CATALOG_V4_REQUIRED/);
  assert.throws(() => validateCatalog({ schemaVersion: 4, plugins: [] }), /CATALOG_V3_REQUIRED/);
  assert.throws(() => draftEntry(fixturePackage(), 4), /CATALOG_V4_COMPATIBILITY_REQUIRED/);
  for (const patch of [{ frameworkMinVersion: undefined }, { frameworkMaxVersionExclusive: undefined }, { towerBuilds: [] }, { smtx: { mode: 'none' } }, { smtx: { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: [] } }]) {
    const entry = { ...candidateEntry(fixtureV4Package(), 4), compatibility: v4Compatibility(patch) };
    assert.throws(() => validateCatalog({ schemaVersion: 4, plugins: [entry] }, 4));
  }
});

test('known v3/v4 same identity digest checks reject conflicts without inventing a global release ledger', () => {
  const a = candidateEntry(fixturePackage()), b = candidateEntry(fixtureV4Package('rivetin-example', '0.1.0'), 4);
  assert.throws(() => assertKnownDigestConsistency([{ schemaVersion: 3, plugins: [a] }, { schemaVersion: 4, plugins: [b] }]), /CATALOG_KNOWN_DIGEST_CONFLICT/);
  assert.equal(assertKnownDigestConsistency([{ schemaVersion: 3, plugins: [a] }], [{ ...a }]), true);
  assert.throws(() => assertKnownDigestConsistency([{ schemaVersion: 3, plugins: [a] }], [{ ...a, status: 'draft', sha256: 'f'.repeat(64) }]), /CATALOG_KNOWN_DIGEST_CONFLICT/);
  assert.equal(assertKnownDigestConsistency([{ schemaVersion: 3, plugins: [a] }], [candidateEntry(fixtureV4Package('rivetin-example', '0.2.0'), 4)]), true);
});
