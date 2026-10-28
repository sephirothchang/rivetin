import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../catalog-release.mjs';
import { run as catalogRun } from '../catalog-update.mjs';
import { serializeCatalog } from '../catalog-package.mjs';
import { fixtureV4Package, receipt, sha } from './catalog-fixtures.mjs';

const scratch = fileURLToPath(new URL('../../.local/catalog-release-tests/', import.meta.url));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const prepared = Date.parse('2026-10-28T16:00:00.000Z'), published = '2026-10-28T16:01:00.000Z', verified = '2026-10-28T16:02:00.000Z', now = Date.parse('2026-10-28T16:03:00.000Z');
const indexPath = '/catalog/v4/plugins.json', id = 'ML-V4-261029.0';
const args = ['verify-release', '--stage-output', '.local/drop', '--proof-directory', '.local/proof', '--publication-output', '.local/publication-output.json', '--ledger', '.local/ledger.json'];
async function fixture(withPackage = true) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, 'run-'));
  const output = [], io = { root, now, stdout: { write: text => output.push(JSON.parse(text)) } };
  const write = async (name, value) => { const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.isBuffer(value) ? value : encode(value)); };
  const read = name => readFile(path.join(root, name));
  await write('catalog/v4/plugins.json', serializeCatalog({ schemaVersion: 4, plugins: [] }, 4));
  const packageName = 'plugins/rivetin-example/release/rivetin-example-0.2.0.rivetin.json';
  if (withPackage) await write(packageName, fixtureV4Package());
  await mkdir(path.join(root, '.local'), { recursive: true });
  await catalogRun(['stage', '--catalog', 'catalog/v4/plugins.json', '--stage-output', '.local/drop', ...(withPackage ? ['--package', packageName] : [])], { ...io, now: prepared });
  const before = await read('catalog/v4/plugins.json');
  await run(['release-stage', '--stage-output', '.local/drop', '--first-release'], io);
  const stageRaw = await read('.local/drop/stage.json'), stage = JSON.parse(stageRaw), reqRaw = await read('.local/drop/release-stage.json'), req = JSON.parse(reqRaw), index = await read('.local/drop' + indexPath);
  const meta = { metadataSchemaVersion: 1, publicationId: id, catalogSchemaVersion: 4, catalogPath: indexPath, catalogSHA256: sha(index), catalogBytes: index.length, snapshotPath: `/catalog/v4/releases/${id}/plugins.json`, publishedAt: published }, metaRaw = encode(meta);
  const ledger = { schemaVersion: 1, currentPublicationId: id, releases: [{ publicationId: id, catalogSchemaVersion: 4, catalogSHA256: sha(index), catalogBytes: index.length, snapshotPath: meta.snapshotPath, publishedAt: published, metadataSHA256: sha(metaRaw), metadataBytes: metaRaw.length, status: 'local-committed', verifiedAt: null }] };
  const ledgerRaw = encode(ledger); await write('.local/ledger.json', ledgerRaw);
  const bodies = [index, metaRaw, index, metaRaw], paths = [indexPath, '/catalog/v4/release.json', meta.snapshotPath, meta.snapshotPath.replace('plugins.json', 'release.json')], names = [['catalog.plugins.json', 'catalog.receipt.json'], ['catalog.release.json', 'catalog.release.receipt.json'], ['catalog.snapshot.plugins.json', 'catalog.snapshot.receipt.json'], ['catalog.snapshot.release.json', 'catalog.snapshot.release.receipt.json']];
  for (const [i, pair] of names.entries()) { await write('.local/proof/' + pair[0], bodies[i]); await write('.local/proof/' + pair[1], receipt(bodies[i], paths[i], verified)); }
  const packages = [];
  for (const p of stage.packages) { const bytes = await read('.local/drop' + p.downloadPath), stem = p.id + '-' + p.version; await write('.local/proof/' + stem + '.rivetin.json', bytes); await write('.local/proof/' + stem + '.receipt.json', receipt(bytes, p.downloadPath, verified)); packages.push({ path: p.downloadPath, sha256: sha(bytes), bytes: bytes.length }); }
  const manifest = { schemaVersion: 1, requestId: req.requestId, stageSHA256: sha(stageRaw), releaseRequestSHA256: sha(reqRaw), publicationId: id, publicationState: 'local-committed', files: paths.map((p, i) => ({ path: p, sha256: sha(bodies[i]), bytes: bodies[i].length })), ledger: { path: 'catalog-release-ledger.json', sha256: sha(ledgerRaw), bytes: ledgerRaw.length }, packages };
  await write('.local/publication-output.json', manifest);
  const call = async (check = false, pinned) => run([...args, '--publication-output-sha256', pinned ?? sha(await read('.local/publication-output.json')), ...(check ? ['--check'] : [])], io);
  return { root, read, write, call, before, manifest, meta, ledger, names, paths, bodies, io };
}

test('new request is exact, private, has no publication ID and never changes canonical; package proof then original CAS', async () => {
  const f = await fixture(); const request = JSON.parse(await f.read('.local/drop/release-stage.json'));
  assert.equal(Object.keys(request).length, 8); assert.equal(request.baseReleaseSHA256, null); assert.equal(Object.hasOwn(request, 'publicationId'), false); assert.deepEqual(await f.read('catalog/v4/plugins.json'), f.before);
  assert.equal(await f.call(true), 1); assert.deepEqual(await f.read('catalog/v4/plugins.json'), f.before);
  assert.equal(await f.call(), 0); assert.equal(JSON.parse(await f.read('catalog/v4/plugins.json')).plugins[0].status, 'published'); assert.equal(await f.call(true), 0);
  await assert.rejects(run(['release-stage', '--stage-output', '.local/drop', '--first-release'], f.io));
});
test('unchanged empty v4 can verify metadata without rewriting canonical', async () => { const f = await fixture(false); assert.equal(await f.call(true), 0); assert.equal(await f.call(), 0); assert.deepEqual(await f.read('catalog/v4/plugins.json'), f.before); });

for (const [label, mutate] of [
  ['coordinator output pin', async f => { f.manifest.extra = true; await f.write('.local/publication-output.json', f.manifest); }],
  ['current metadata bytes', f => f.write('.local/proof/catalog.release.json', { ...f.meta, publishedAt: '2026-10-28T16:01:01.000Z' })],
  ['immutable metadata bytes', f => f.write('.local/proof/catalog.snapshot.release.json', { ...f.meta, publicationId: 'ML-V4-261029.1' })],
  ['snapshot index', f => f.write('.local/proof/catalog.snapshot.plugins.json', Buffer.from('{}'))],
  ['ledger raw binding', f => f.write('.local/ledger.json', { ...f.ledger, currentPublicationId: null })],
  ['receipt origin', f => f.write('.local/proof/catalog.release.receipt.json', { ...receipt(f.bodies[1], f.paths[1], verified), site: 'https://example.invalid' })],
  ['receipt before publication', f => f.write('.local/proof/catalog.snapshot.receipt.json', receipt(f.bodies[2], f.paths[2], '2026-10-28T16:00:30.000Z'))],
  ['package bytes', f => f.write('.local/proof/rivetin-example-0.2.0.rivetin.json', Buffer.from('EXAMPLE_CHANGED_PACKAGE'))],
  ['package receipt before publication', f => f.write('.local/proof/rivetin-example-0.2.0.receipt.json', receipt(Buffer.from('x'), f.manifest.packages[0].path, '2026-10-28T16:00:30.000Z'))],
  ['request raw bytes', async f => { const request = JSON.parse(await f.read('.local/drop/release-stage.json')); request.baseReleaseSHA256 = 'a'.repeat(64); await f.write('.local/drop/release-stage.json', request); }],
  ['canonical CAS', f => f.write('catalog/v4/plugins.json', Buffer.from('{"schemaVersion":4,"plugins":[]}'))],
]) test(label + ' mismatch refuses publication and preserves canonical', async () => { const f = await fixture(); const pin = sha(await f.read('.local/publication-output.json')); await mutate(f); const before = await f.read('catalog/v4/plugins.json'); await assert.rejects(f.call(false, pin)); assert.deepEqual(await f.read('catalog/v4/plugins.json'), before); });

test('valid coordinator pin cannot hide contradictory metadata and ledger', async () => {
  const f = await fixture(false); f.ledger.releases[0].status = 'abandoned'; const raw = encode(f.ledger); await f.write('.local/ledger.json', raw); f.manifest.ledger = { path: 'catalog-release-ledger.json', sha256: sha(raw), bytes: raw.length }; await f.write('.local/publication-output.json', f.manifest); await assert.rejects(f.call(), /CATALOG_RELEASE_LEDGER_BINDING/); assert.deepEqual(await f.read('catalog/v4/plugins.json'), f.before);
});
test('request requires explicit first-release or exact previous metadata, and rejects public output paths', async () => {
  const f = await fixture(false);
  for (const a of [['release-stage', '--stage-output', '.local/drop'], ['release-stage', '--stage-output', '.local/drop', '--first-release', '--base-release', '.local/old.json'], ['release-stage', '--stage-output', 'public/drop', '--first-release'], [...args, '--publication-output-sha256', 'invalid']]) await assert.rejects(run(a, f.io));
});
test('subsequent request binds previous raw sidecar, and does not reuse an existing request', async () => {
  const f = await fixture(false);
  await catalogRun(['stage', '--catalog', 'catalog/v4/plugins.json', '--stage-output', '.local/next'], { ...f.io, now: prepared });
  await run(['release-stage', '--stage-output', '.local/next', '--base-release', '.local/proof/catalog.release.json'], f.io);
  assert.equal(JSON.parse(await f.read('.local/next/release-stage.json')).baseReleaseSHA256, sha(f.bodies[1]));
  await assert.rejects(run(['release-stage', '--stage-output', '.local/next', '--base-release', '.local/proof/catalog.release.json'], f.io), /EEXIST/);
});
test('ledger accepts more than 512 KiB within its 2 MiB bound; over-limit input refuses before canonical write', async () => {
  const f = await fixture(false);
  for (let n = 1; n < 1200; n++) f.ledger.releases.push({ ...f.ledger.releases[0], publicationId: `ML-V4-261029.${n}`, snapshotPath: `/catalog/v4/releases/ML-V4-261029.${n}/plugins.json`, status: 'abandoned' });
  let body = encode(f.ledger); assert.ok(body.length > 512 * 1024 && body.length < 2 * 1024 * 1024);
  await f.write('.local/ledger.json', body); f.manifest.ledger = { path: 'catalog-release-ledger.json', sha256: sha(body), bytes: body.length }; await f.write('.local/publication-output.json', f.manifest); assert.equal(await f.call(true), 0);
  body = Buffer.alloc(2 * 1024 * 1024 + 1, ' '); await f.write('.local/ledger.json', body); await assert.rejects(f.call(), /CATALOG_INPUT_SIZE_LIMIT/); assert.deepEqual(await f.read('catalog/v4/plugins.json'), f.before);
});
test('package receipt at stage time but before publication is rejected even with correct package bytes', async () => {
  const f = await fixture(); const bytes = await f.read('.local/proof/rivetin-example-0.2.0.rivetin.json'); await f.write('.local/proof/rivetin-example-0.2.0.receipt.json', receipt(bytes, f.manifest.packages[0].path, '2026-10-28T16:00:30.000Z')); await assert.rejects(f.call(), /SITE_READBACK_TIME_INVALID/); assert.deepEqual(await f.read('catalog/v4/plugins.json'), f.before);
});
