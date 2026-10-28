import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hash, validatePackage } from '../../../framework/server/manifest.js';
import { assertBuildCurrent, assertNewRelease } from './build-inputs.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'rivetin.json'), 'utf8'));
if (metadata.name !== manifest.id || metadata.version !== manifest.version) throw new Error('PLUGIN_IDENTITY_MISMATCH');
const standard = `${metadata.name}-${metadata.version}.rivetin.json`;
const archive = `${metadata.name}-${metadata.version}-local-demo.tar.gz`;
const checksums = `${metadata.name}-${metadata.version}-SHA256SUMS`;
await assertNewRelease(root, [standard, archive, checksums]);
await assertBuildCurrent(root);
const files = [];
for (const [target, source] of [['web/plugin.js', 'dist/rivetin/plugin.js'], ['LICENSE', 'LICENSE']]) {
  const content = await readFile(path.join(root, source));
  files.push({ path: target, sha256: hash(content), data: content.toString('base64') });
}
const release = path.join(root, 'release'); await mkdir(release, { recursive: true });
const bytes = Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest, files })); validatePackage(bytes);
const demoFiles = ['README.md', 'docs/feasibility.md', 'LICENSE', 'demo/index.html', 'demo/demo.css', 'demo/server.mjs', 'dist/demo/demo.js', 'dist/demo/demo.js.LICENSE.txt', 'dist/demo/THIRD_PARTY_NOTICES.txt'];
const staging = path.join(root, `.packaging/${metadata.name}-${metadata.version}`);
for (const name of demoFiles) {
  const target = path.join(staging, name); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(root, name), target);
}
const stagedArchive = path.join(staging, archive);
execFileSync('tar', ['-czf', stagedArchive, '-C', staging, ...demoFiles], { timeout: 30000 });
const archiveBytes = await readFile(stagedArchive);
await assertBuildCurrent(root);
await writeFile(path.join(release, standard), bytes, { flag: 'wx' });
await writeFile(path.join(release, archive), archiveBytes, { flag: 'wx' });
await writeFile(path.join(release, checksums), `${hash(bytes)}  ${standard}\n${hash(archiveBytes)}  ${archive}\n`, { flag: 'wx' });
console.log(`${standard}: ${bytes.length} bytes; SHA-256 ${hash(bytes)}`);
console.log(`${archive}: ${archiveBytes.length} bytes; SHA-256 ${hash(archiveBytes)}`);
