import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../catalog-update.mjs';
import { draftEntry, INDEX_PATH, mergeEntries, serializeCatalog } from '../catalog-package.mjs';
import { fixturePackage, receipt } from './catalog-fixtures.mjs';

const scratch = fileURLToPath(new URL('../../.local/catalog-tool-tests/', import.meta.url));
const preparedAt = Date.parse('2026-10-28T12:00:00.000Z'), verifiedAt = '2026-10-28T12:01:00.000Z', now = Date.parse('2026-10-28T12:02:00.000Z');
async function fixture(t) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(scratch)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await mkdir(path.join(root, 'catalog')); await mkdir(path.join(root, '.local')); await writeFile(path.join(root, 'catalog/plugins.json'), serializeCatalog({ schemaVersion: 3, plugins: [] }));
  const output = []; const call = (args, clock = now) => run(args, { root, now: clock, stdout: { write: value => output.push(JSON.parse(value)) } });
  const add = async (id = 'rivetin-example', version = '0.1.0') => { const name = `plugins/${id}/release/${id}-${version}.rivetin.json`, bytes = fixturePackage(id, version); await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); return name; };
  return { root, call, output, add, catalog: () => readFile(path.join(root, 'catalog/plugins.json')) };
}
async function proofs(f) {
  const stage = JSON.parse(await readFile(path.join(f.root, '.local/drop/stage.json'))); await mkdir(path.join(f.root, '.local/proof'));
  const index = await readFile(path.join(f.root, '.local/drop/catalog/plugins.json'));
  await writeFile(path.join(f.root, '.local/proof/catalog.plugins.json'), index); await writeFile(path.join(f.root, '.local/proof/catalog.receipt.json'), JSON.stringify(receipt(index, INDEX_PATH, verifiedAt)));
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
