import { createHash } from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const shared = ['../../framework/src/config-store.js', '../../framework/src/client.js', '../../framework/src/personal.js',
  '../../framework/shared/identity.js', '../../framework/package.json', '../../framework/package-lock.json'];

export async function captureInputs(root) {
  const names = ['package.json', 'package-lock.json', 'rivetin.json', 'webpack.config.cjs', 'LICENSE', 'README.md', ...shared];
  async function collect(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  for (const directory of ['src', 'demo', 'docs', 'scripts']) await collect(directory);
  const files = {};
  for (const name of names.sort()) files[name] = hash(await readFile(path.join(root, name)));
  return { node: process.version, files };
}

export function assertSameInputs(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('BUILD_INPUTS_CHANGED: run npm run build before packaging');
}

export async function captureOutputs(root) {
  const files = {};
  for (const name of ['dist/rivetin/plugin.js', 'dist/demo/demo.js', 'dist/demo/demo.js.LICENSE.txt', 'dist/demo/THIRD_PARTY_NOTICES.txt']) {
    files[name] = hash(await readFile(path.join(root, name)));
  }
  return files;
}

export async function assertBuildCurrent(root) {
  let record;
  try { record = JSON.parse(await readFile(path.join(root, 'dist/build-inputs.json'), 'utf8')); }
  catch { throw new Error('BUILD_BASELINE_MISSING: run npm run build before packaging'); }
  if (record.format !== 'rivetin-local-build-v1') throw new Error('BUILD_BASELINE_INVALID');
  assertSameInputs(record.inputs, await captureInputs(root));
  if (JSON.stringify(record.outputs) !== JSON.stringify(await captureOutputs(root))) throw new Error('BUILD_OUTPUTS_CHANGED: run npm run build before packaging');
}

export async function assertNewRelease(root, names) {
  for (const name of names) {
    try { await access(path.join(root, 'release', name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`RELEASE_ALREADY_EXISTS: ${name}; use a new version`);
  }
}
