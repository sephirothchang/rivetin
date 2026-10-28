import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../catalog-update.mjs';
import { candidateEntry, draftEntry, INDEX_PATH, V4_INDEX_PATH, mergeEntries, serializeCatalog } from '../catalog-package.mjs';
import { fixturePackage, fixtureV4Package, receipt, sha } from './catalog-fixtures.mjs';

const scratch = fileURLToPath(new URL('../../.local/catalog-tool-tests/', import.meta.url));
const preparedAt = Date.parse('2026-10-28T12:00:00.000Z'), verifiedAt = '2026-10-28T12:01:00.000Z', now = Date.parse('2026-10-28T12:02:00.000Z');
async function fixture(t, schemaVersion = 3) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(scratch)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await mkdir(path.join(root, 'catalog')); await mkdir(path.join(root, '.local')); await writeFile(path.join(root, 'catalog/plugins.json'), serializeCatalog({ schemaVersion: 3, plugins: [] }));
  const catalogName = schemaVersion === 4 ? 'catalog/v4/plugins.json' : 'catalog/plugins.json';
  if (schemaVersion === 4) { await mkdir(path.join(root, 'catalog/v4')); await writeFile(path.join(root, catalogName), serializeCatalog({ schemaVersion: 4, plugins: [] }, 4)); }
  const output = []; const call = (args, clock = now) => run(args, { root, now: clock, stdout: { write: value => output.push(JSON.parse(value)) } });
  const add = async (id = 'rivetin-example', version = '0.1.0') => { const name = `plugins/${id}/release/${id}-${version}.rivetin.json`, bytes = (schemaVersion === 4 ? fixtureV4Package : fixturePackage)(id, version); await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); return name; };
  return { root, call, output, add, catalogName, catalog: () => readFile(path.join(root, catalogName)), v3Catalog: () => readFile(path.join(root, 'catalog/plugins.json')) };
}
async function proofs(f) {
  const stage = JSON.parse(await readFile(path.join(f.root, '.local/drop/stage.json'))); await mkdir(path.join(f.root, '.local/proof'));
  const index = await readFile(path.join(f.root, '.local/drop', stage.indexPath.slice(1)));
  await writeFile(path.join(f.root, '.local/proof/catalog.plugins.json'), index); await writeFile(path.join(f.root, '.local/proof/catalog.receipt.json'), JSON.stringify(receipt(index, stage.indexPath, verifiedAt)));
  for (const item of stage.packages) {
    const bytes = await readFile(path.join(f.root, '.local/drop', item.downloadPath.slice(1))), stem = `${item.id}-${item.version}`;
    await writeFile(path.join(f.root, `.local/proof/${stem}.rivetin.json`), bytes); await writeFile(path.join(f.root, `.local/proof/${stem}.receipt.json`), JSON.stringify(receipt(bytes, item.downloadPath, verifiedAt)));
  }
}
const verifyArgs = ['verify', '--stage-output', '.local/drop', '--proof-directory', '.local/proof'];

test('draft --check does not write, explicit write is deterministic and subsequent check is clean', async t => {
  const f = await fixture(t), name = await f.add(), before = await f.catalog();
  assert.equal(await f.call(['draft', '--package', name, '--check']), 1); assert.deepEqual(await f.catalog(), before);
  assert.equal(await f.call(['draft', '--package', name]), 0); const after = await f.catalog();
  assert.equal(await f.call(['draft', '--package', name, '--check']), 0); assert.deepEqual(await f.catalog(), after);
});

test('stage produces only an ignored candidate drop; actual website index and package receipts precede canonical publication', async t => {
  const f = await fixture(t), a = await f.add('rivetin-a'), z = await f.add('rivetin-z'); const before = await f.catalog();
  assert.equal(await f.call(['stage', '--package', z, '--package', a, '--stage-output', '.local/drop'], preparedAt), 0); assert.deepEqual(await f.catalog(), before);
  assert.equal(f.output.at(-1).candidateOnly, true); assert.equal(f.output.at(-1).publishedVerified, false);
  await proofs(f); assert.equal(await f.call([...verifyArgs, '--check']), 1); assert.deepEqual(await f.catalog(), before);
  assert.equal(await f.call(verifyArgs), 0); const value = JSON.parse(await f.catalog()); assert.deepEqual(value.plugins.map(item => item.id), ['rivetin-a', 'rivetin-z']); assert.ok(value.plugins.every(item => item.status === 'published'));
  assert.equal(await f.call([...verifyArgs, '--check']), 0);
});

test('missing, stale, private-field or byte-mismatched receipts cannot publish and leave canonical bytes unchanged', async t => {
  const f = await fixture(t), name = await f.add(); await f.call(['stage', '--package', name, '--stage-output', '.local/drop'], preparedAt); const before = await f.catalog();
  await assert.rejects(f.call(verifyArgs)); await proofs(f);
  const proof = path.join(f.root, '.local/proof/catalog.receipt.json'), original = JSON.parse(await readFile(proof));
  for (const change of [{ ...original, status: 404 }, { ...original, verifiedAt: '2026-10-27T12:00:00Z' }, { ...original, token: 'EXAMPLE_NOT_A_REAL_TOKEN' }]) { await writeFile(proof, JSON.stringify(change)); await assert.rejects(f.call(verifyArgs)); assert.deepEqual(await f.catalog(), before); }
  await writeFile(proof, JSON.stringify(original)); await writeFile(path.join(f.root, '.local/proof/rivetin-example-0.1.0.rivetin.json'), 'EXAMPLE_CHANGED_READBACK'); await assert.rejects(f.call(verifyArgs)); assert.deepEqual(await f.catalog(), before);
});

test('concurrent canonical change, staged mutation and an existing stage directory are refused', async t => {
  const f = await fixture(t), name = await f.add(); await f.call(['stage', '--package', name, '--stage-output', '.local/drop'], preparedAt);
  await assert.rejects(f.call(['stage', '--package', name, '--stage-output', '.local/drop']), /CATALOG_STAGE_EXISTS/); await proofs(f);
  const changed = serializeCatalog(mergeEntries({ schemaVersion: 3, plugins: [] }, [draftEntry(fixturePackage('rivetin-unrelated'))])); await writeFile(path.join(f.root, 'catalog/plugins.json'), changed);
  await assert.rejects(f.call(verifyArgs), /CATALOG_STAGE_BASE_MISMATCH|CATALOG_CHANGED_SINCE_STAGE/); assert.deepEqual(await f.catalog(), changed);
  await writeFile(path.join(f.root, '.local/drop/catalog/plugins.json'), 'EXAMPLE_CHANGED_STAGE'); await assert.rejects(f.call(verifyArgs), /CATALOG_STAGE_CHANGED|SyntaxError/);
});

test('path traversal, nonignored evidence, v2 input and package filename mismatches fail closed', async t => {
  const f = await fixture(t), name = await f.add();
  for (const args of [['draft', '--package', '../outside'], ['draft', '--package', name, '--catalog', '../outside.json'], ['stage', '--package', name, '--stage-output', 'public-drop'], ['verify', '--stage-output', '.local/../outside', '--proof-directory', '.local/proof']]) await assert.rejects(f.call(args));
  await writeFile(path.join(f.root, name), fixturePackage('rivetin-other')); await assert.rejects(f.call(['draft', '--package', name]), /CATALOG_PACKAGE_FILENAME_MISMATCH/);
  await writeFile(path.join(f.root, 'catalog/plugins.json'), '{"schemaVersion":2,"plugins":[]}'); await assert.rejects(f.call(['draft', '--package', name]), /CATALOG_V3_REQUIRED/);
});

test('symlinked package/catalog/evidence paths are rejected', async t => {
  const f = await fixture(t), name = await f.add(); await mkdir(path.join(f.root, '.local/actual'));
  try { await symlink(path.join(f.root, '.local/actual'), path.join(f.root, '.local/alias'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Local symlink permission unavailable'); return; } throw error; }
  await assert.rejects(f.call(['stage', '--package', name, '--stage-output', '.local/alias/drop']), /CATALOG_PATH_REJECTED/);
});

const v4Args = ['--catalog', 'catalog/v4/plugins.json'];
async function dropFiles(root) {
  const output = [];
  async function visit(directory, prefix = '') { for (const row of await readdir(directory, { withFileTypes: true })) { const name = prefix + row.name; if (row.isDirectory()) await visit(path.join(directory, row.name), name + '/'); else output.push(name); } }
  await visit(root); return output.sort();
}

test('an explicit empty v4 stage has exactly eight proposal fields, only index files, and keeps v3 bytes', async t => {
  const f = await fixture(t, 4), before = await f.v3Catalog();
  await f.call(['stage', ...v4Args, '--stage-output', '.local/drop'], preparedAt);
  const stage = JSON.parse(await readFile(path.join(f.root, '.local/drop/stage.json')));
  assert.deepEqual(Object.keys(stage).sort(), ['schemaVersion', 'preparedAt', 'catalogPath', 'baseCatalogSHA256', 'indexPath', 'indexSHA256', 'packages', 'candidateOnly'].sort());
  assert.equal(stage.catalogPath, 'catalog/v4/plugins.json'); assert.equal(stage.indexPath, V4_INDEX_PATH); assert.deepEqual(stage.packages, []);
  assert.deepEqual(await dropFiles(path.join(f.root, '.local/drop')), ['catalog/v4/plugins.json', 'stage.json']);
  await proofs(f); assert.equal(await f.call([...verifyArgs, ...v4Args, '--check']), 0); assert.deepEqual(await f.v3Catalog(), before);
  await assert.rejects(f.call(verifyArgs), /CATALOG_STAGE_INVALID/);
  await assert.rejects(f.call(['stage', '--stage-output', '.local/legacy-empty']), /CATALOG_PACKAGE_REQUIRED/);
});

test('v4 publishes only after exact receipts and subsequent unchanged packages are omitted from the drop', async t => {
  const f = await fixture(t, 4), name = await f.add('rivetin-example', '0.2.0'), before = await f.v3Catalog();
  assert.equal(await f.call(['draft', ...v4Args, '--package', name, '--check']), 1);
  await assert.rejects(f.call(['draft', '--package', name]), /CATALOG_V4_REQUIRED/);
  await f.call(['stage', ...v4Args, '--package', name, '--stage-output', '.local/drop'], preparedAt); await proofs(f);
  assert.equal(await f.call([...verifyArgs, ...v4Args, '--check']), 1);
  assert.equal(await f.call([...verifyArgs, ...v4Args]), 0);
  const value = JSON.parse(await f.catalog()); assert.equal(value.schemaVersion, 4); assert.equal(value.plugins[0].status, 'published'); assert.equal(value.plugins[0].compatibility.schemaVersion, 2);
  assert.deepEqual(await f.v3Catalog(), before);
  await f.call(['stage', ...v4Args, '--package', name, '--stage-output', '.local/repeated'], preparedAt);
  const repeated = JSON.parse(await readFile(path.join(f.root, '.local/repeated/stage.json'))); assert.deepEqual(repeated.packages, []);
  assert.deepEqual(await dropFiles(path.join(f.root, '.local/repeated')), ['catalog/v4/plugins.json', 'stage.json']);
});

test('known canonical v3/v4 identity digest conflicts reject draft and stage without touching either index', async t => {
  const f = await fixture(t, 4), name = await f.add('rivetin-example', '0.1.0');
  const legacy = serializeCatalog({ schemaVersion: 3, plugins: [candidateEntry(fixturePackage('rivetin-example', '0.1.0'))] });
  await writeFile(path.join(f.root, 'catalog/plugins.json'), legacy); const before = await f.catalog();
  for (const mode of ['draft', 'stage']) {
    const args = [mode, ...v4Args, '--package', name, ...(mode === 'stage' ? ['--stage-output', '.local/drop'] : [])];
    await assert.rejects(f.call(args), /CATALOG_KNOWN_DIGEST_CONFLICT/);
    assert.deepEqual(await f.catalog(), before); assert.deepEqual(await f.v3Catalog(), legacy);
  }
  await assert.rejects(readFile(path.join(f.root, '.local/drop/stage.json')), failure => failure.code === 'ENOENT');
});

test('v4 receipts require the v4 index path and the proposal cannot carry extra fields', async t => {
  const f = await fixture(t, 4), name = await f.add(); await f.call(['stage', ...v4Args, '--package', name, '--stage-output', '.local/drop'], preparedAt); await proofs(f);
  const before = await f.catalog(), receiptFile = path.join(f.root, '.local/proof/catalog.receipt.json'), original = JSON.parse(await readFile(receiptFile));
  await writeFile(receiptFile, JSON.stringify({ ...original, path: INDEX_PATH })); await assert.rejects(f.call([...verifyArgs, ...v4Args]), /SITE_READBACK_MISMATCH/);
  await writeFile(receiptFile, JSON.stringify(original));
  const proposal = path.join(f.root, '.local/drop/stage.json'), stage = JSON.parse(await readFile(proposal));
  for (const change of [{ ...stage, privateNote: 'EXAMPLE_NOT_FOR_PUBLICATION' }, { ...stage, catalogPath: 'catalog/plugins.json' }, { ...stage, candidateOnly: false }]) {
    await writeFile(proposal, JSON.stringify(change)); await assert.rejects(f.call([...verifyArgs, ...v4Args]), /CATALOG_STAGE_INVALID/); assert.deepEqual(await f.catalog(), before);
  }
});

test('empty v4 package evidence cannot authorize a changed published entry even with matching index receipt', async t => {
  const f = await fixture(t, 4); await f.call(['stage', ...v4Args, '--stage-output', '.local/drop'], preparedAt); await proofs(f); const before = await f.catalog();
  const output = serializeCatalog({ schemaVersion: 4, plugins: [candidateEntry(fixtureV4Package(), 4)] }, 4);
  const stageFile = path.join(f.root, '.local/drop/stage.json'), stage = JSON.parse(await readFile(stageFile)); stage.indexSHA256 = sha(output);
  await writeFile(stageFile, JSON.stringify(stage)); await writeFile(path.join(f.root, '.local/drop/catalog/v4/plugins.json'), output);
  await writeFile(path.join(f.root, '.local/proof/catalog.plugins.json'), output); await writeFile(path.join(f.root, '.local/proof/catalog.receipt.json'), JSON.stringify(receipt(output, V4_INDEX_PATH, verifiedAt)));
  await assert.rejects(f.call([...verifyArgs, ...v4Args]), /CATALOG_STAGE_BASE_MISMATCH/); assert.deepEqual(await f.catalog(), before);
});

test('v4 verify rechecks known canonical digest conflicts introduced after staging', async t => {
  const f = await fixture(t, 4), name = await f.add('rivetin-example', '0.1.0');
  await f.call(['stage', ...v4Args, '--package', name, '--stage-output', '.local/drop'], preparedAt); await proofs(f); const before = await f.catalog();
  const changedPeer = serializeCatalog({ schemaVersion: 3, plugins: [candidateEntry(fixturePackage('rivetin-example', '0.1.0'))] });
  await writeFile(path.join(f.root, 'catalog/plugins.json'), changedPeer);
  await assert.rejects(f.call([...verifyArgs, ...v4Args]), /CATALOG_KNOWN_DIGEST_CONFLICT/);
  assert.deepEqual(await f.catalog(), before); assert.deepEqual(await f.v3Catalog(), changedPeer);
});
