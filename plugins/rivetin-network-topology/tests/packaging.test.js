import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hash, validatePackage } from '../../../framework/server/manifest.js';
import { packageArtifacts } from '../scripts/package.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const snapshot = async directory => Object.fromEntries(await Promise.all((await readdir(directory, { withFileTypes: true })).filter(f => f.isFile()).map(async f => [f.name, hash(await readFile(path.join(directory, f.name)))])));
const allowed = ['README.md', 'LICENSE', 'package.json', 'demo/index.html', 'demo/demo.css', 'demo/server.mjs', 'dist/demo/demo.js'];
async function fixture() {
  await mkdir(path.join(root, '.packaging'), { recursive: true });
  const folder = await mkdtemp(path.join(root, '.packaging/package-fixture-'));
  for (const file of [...allowed, 'rivetin.json', 'dist/rivetin/plugin.js']) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    const data = ['package.json', 'rivetin.json'].includes(file) ? await readFile(path.join(root, file)) : `/* isolated fixture ${file} */\n`;
    await writeFile(path.join(folder, file), data);
  }
  return folder;
}

test('packaging refuses fixed releases and occupied candidates without modifying their bytes', async () => {
  const folder = await fixture(), release = path.join(folder, 'release');
  await mkdir(release);
  await writeFile(path.join(release, `${metadata.name}-${metadata.version}.rivetin.json`), 'fixed package sentinel');
  const before = await snapshot(release);
  await assert.rejects(packageArtifacts(folder), /CANDIDATE_OUTPUT_EXISTS/);
  assert.deepEqual(await snapshot(release), before);
  const output = await mkdtemp(path.join(folder, 'collision-'));
  await writeFile(path.join(output, 'SHA256SUMS'), 'preserved checksum sentinel\n');
  const occupied = await snapshot(output);
  await assert.rejects(packageArtifacts(folder, ['--output-dir', output]), /CANDIDATE_OUTPUT_EXISTS/);
  assert.deepEqual(await snapshot(output), occupied);
});

test('an independent candidate contains current build bytes and exactly the allowed demo files', async () => {
  const folder = await fixture(), output = path.join(folder, 'candidate');
  await packageArtifacts(folder, ['--output-dir', output]);
  const name = `${metadata.name}-${metadata.version}`;
  const bytes = await readFile(path.join(output, `${name}.rivetin.json`));
  const pkg = validatePackage(bytes);
  assert.deepEqual(pkg.manifest.compatibility.towerBuilds, ['4.9.0']);
  const raw = JSON.parse(bytes);
  assert.deepEqual(raw.files.map(f => f.path).sort(), ['LICENSE', 'web/plugin.js']);
  assert.deepEqual(Buffer.from(raw.files.find(f => f.path === 'web/plugin.js').data, 'base64'), await readFile(path.join(folder, 'dist/rivetin/plugin.js')));
  const archive = path.join(output, `${name}-local-demo.tar.gz`);
  assert.deepEqual(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).sort(), allowed.sort());
  for (const file of allowed) assert.deepEqual(execFileSync('tar', ['-xOzf', archive, file]), await readFile(path.join(folder, file)));
  for (const line of (await readFile(path.join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const [expected, file] = line.split(/\s+/); assert.equal(hash(await readFile(path.join(output, file))), expected);
  }
});
