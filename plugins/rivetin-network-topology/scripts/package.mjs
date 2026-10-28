import { mkdir, mkdtemp, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hash, validatePackage } from '../../../framework/server/manifest.js';
export async function packageArtifacts(root, args = []) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(root, 'rivetin.json'), 'utf8'));
  if (metadata.name !== manifest.id || metadata.version !== manifest.version) throw new Error('PLUGIN_IDENTITY_MISMATCH');
  const files = [];
  for (const [target, source] of [['web/plugin.js', 'dist/rivetin/plugin.js'], ['LICENSE', 'LICENSE']]) {
    const content = await readFile(path.join(root, source));
    files.push({ path: target, sha256: hash(content), data: content.toString('base64') });
  }
  if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1].trim())) throw new Error('Usage: npm run package -- [--output-dir <new-candidate-directory>]');
  const release = args.length ? path.resolve(root, args[1]) : path.join(root, 'release');
  const standard = `${metadata.name}-${metadata.version}.rivetin.json`;
  const archive = `${metadata.name}-${metadata.version}-local-demo.tar.gz`;
  // Refuse all known collisions before writing any output. Exclusive writes also guard races.
  for (const name of [standard, archive, 'SHA256SUMS']) {
    try { await access(path.join(release, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('CANDIDATE_OUTPUT_EXISTS: choose a new --output-dir; fixed artifacts are never overwritten');
  }
  await mkdir(release, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest, files }));
  validatePackage(bytes);
  await writeFile(path.join(release, standard), bytes, { flag: 'wx' });
  // Explicit allowlist: no source maps, collaboration files, runtime, logs or screenshots.
  const demoFiles = ['README.md', 'LICENSE', 'package.json', 'demo/index.html', 'demo/demo.css', 'demo/server.mjs', 'dist/demo/demo.js'];
  await mkdir(path.join(root, '.packaging'), { recursive: true });
  const staging = await mkdtemp(path.join(root, '.packaging/demo-'));
  for (const name of demoFiles) {
    const target = path.join(staging, name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, name), target);
  }
  const temporaryArchive = path.join(staging, archive);
  execFileSync('tar', ['-czf', temporaryArchive, '-C', staging, ...demoFiles]);
  await copyFile(temporaryArchive, path.join(release, archive), constants.COPYFILE_EXCL);
  const archiveBytes = await readFile(path.join(release, archive));
  const checksums = `${hash(bytes)}  ${standard}\n${hash(archiveBytes)}  ${archive}\n`;
  await writeFile(path.join(release, 'SHA256SUMS'), checksums, { flag: 'wx' });
  console.log(`${standard}: ${bytes.length} bytes (dormant preview entry)`);
  console.log(`${archive}: ${archiveBytes.length} bytes (interactive local demo)`);
  console.log(checksums);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageArtifacts(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.slice(2));
}
