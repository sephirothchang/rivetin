import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureInputs, captureOutputs, assertBuildCurrent, assertNewRelease } from '../scripts/build-inputs.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rivetin-policy-build-'));
  t.after(() => {
    const target = path.resolve(temporary), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('rivetin-policy-build-'));
    return rm(target, { recursive: true, force: true });
  });
  const root = path.join(temporary, 'plugins/converter');
  const files = ['package.json', 'package-lock.json', 'rivetin.json', 'webpack.config.cjs', 'LICENSE', 'README.md',
    'src/converter.js', 'demo/bootstrap.js', 'docs/feasibility.md', 'scripts/build.mjs',
    '../../framework/src/config-store.js', '../../framework/src/client.js', '../../framework/src/personal.js',
    '../../framework/shared/identity.js', '../../framework/package.json', '../../framework/package-lock.json',
    'dist/rivetin/plugin.js', 'dist/demo/demo.js', 'dist/demo/demo.js.LICENSE.txt', 'dist/demo/THIRD_PARTY_NOTICES.txt'];
  for (const name of files) {
    const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'fixture');
  }
  const record = { format: 'rivetin-local-build-v1', inputs: await captureInputs(root), outputs: await captureOutputs(root) };
  await writeFile(path.join(root, 'dist/build-inputs.json'), JSON.stringify(record));
  return root;
}

test('packaging rejects a missing build baseline and accepts matching inputs and outputs', async t => {
  const root = await fixture(t);
  await assert.doesNotReject(assertBuildCurrent(root));
  await rm(path.join(root, 'dist/build-inputs.json'));
  await assert.rejects(assertBuildCurrent(root), /BUILD_BASELINE_MISSING/);
});
test('changes to plugin code, shared client, lockfile or demo documentation require a new build', async t => {
  for (const file of ['src/converter.js', '../../framework/src/client.js', '../../framework/package-lock.json', 'docs/feasibility.md']) {
    const root = await fixture(t); await writeFile(path.join(root, file), 'changed');
    await assert.rejects(assertBuildCurrent(root), /BUILD_INPUTS_CHANGED/);
  }
});
test('a new source file and a modified built bundle cannot be silently packaged', async t => {
  const added = await fixture(t); await writeFile(path.join(added, 'src/new.js'), 'new source');
  await assert.rejects(assertBuildCurrent(added), /BUILD_INPUTS_CHANGED/);
  const changed = await fixture(t); await writeFile(path.join(changed, 'dist/rivetin/plugin.js'), 'stale bundle');
  await assert.rejects(assertBuildCurrent(changed), /BUILD_OUTPUTS_CHANGED/);
});
test('existing standard, archive or checksum file rejects the entire same-version release without overwriting', async t => {
  const names = ['converter-0.1.1.rivetin.json', 'converter-0.1.1-local-demo.tar.gz', 'converter-0.1.1-SHA256SUMS'];
  for (const name of names) {
    const root = await fixture(t); await mkdir(path.join(root, 'release')); await writeFile(path.join(root, 'release', name), 'fixed bytes');
    await assert.rejects(assertNewRelease(root, names), /RELEASE_ALREADY_EXISTS/);
    assert.equal(await readFile(path.join(root, 'release', name), 'utf8'), 'fixed bytes');
  }
});
