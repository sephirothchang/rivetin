import { mkdir, copyFile, mkdtemp, lstat, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { validatePackage, FRAMEWORK_VERSION } from '../server/manifest.js';
import { runtimeFiles } from './runtime-files.mjs';
import { buildIntegrity } from './release-integrity.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.packaging'), output = path.join(root, 'release');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const seaMap = JSON.parse(await readFile(path.join(root, 'sea-map.json'), 'utf8'));
if (metadata.version !== FRAMEWORK_VERSION || seaMap.metadata?.info?.version !== FRAMEWORK_VERSION) throw new Error('FRAMEWORK_VERSION_MISMATCH');
await mkdir(stage, { recursive: true }); await mkdir(output, { recursive: true });
const channel = path.resolve(root, '../plugins/rivetin-ssh-channel');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--builtin-package')) throw new Error('INVALID_PACKAGE_ARGUMENTS');
if (!args.length) {
  execFileSync(process.execPath, [path.join(channel, 'scripts/build.mjs')], { cwd: channel, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(channel, 'scripts/package.mjs')], { cwd: channel, stdio: 'inherit' });
}
const channelManifest = JSON.parse(await readFile(path.join(channel, 'rivetin.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(channelManifest.version)) throw new Error('INVALID_BUILTIN_VERSION');
const builtin = args.length ? path.resolve(args[1]) : path.join(channel, `release/rivetin-ssh-channel-${channelManifest.version}.rivetin.json`);
const builtinPackage = validatePackage(await readFile(builtin));
if (builtinPackage.manifest.id !== 'rivetin-ssh-channel' || builtinPackage.manifest.configuration.defaults.enabled !== false) throw new Error('INVALID_BUILTIN_PLUGIN');
await mkdir(path.join(root, 'server/builtins'), { recursive: true });
await copyFile(builtin, path.join(root, 'server/builtins/rivetin-ssh-channel.json'));
await copyFile(path.join(root, '../LICENSE'), path.join(root, 'dist/production/build/LICENSE'));
await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(root, 'dist/production/build/THIRD_PARTY_NOTICES.txt'));
await copyFile(path.join(root, 'sea-map.json'), path.join(stage, 'sea-map.json'));
execFileSync('tar', ['-czf', path.join(stage, 'build.tar.gz'), '-C', path.join(root, 'dist/production'), 'build']);
execFileSync('tar', ['-czf', path.join(output, `rivetin-${FRAMEWORK_VERSION}-island.tar.gz`), '-C', stage, 'sea-map.json', 'build.tar.gz']);
// Stage explicit source and runtime files; stale local builtins are not release inputs.
const serviceStage = await mkdtemp(path.join(stage, 'service-'));
for (const directory of ['server', 'server/vendor', 'server/builtins', 'shared', 'deploy']) await mkdir(path.join(serviceStage, directory), { recursive: true });
const sourceFiles = await runtimeFiles(root);
const deployFiles = ['deploy/install.sh', 'deploy/rivetin.yaml'];
const releaseFiles = [...new Set([...sourceFiles, ...deployFiles, 'server/vendor/ssh2.cjs', 'server/builtins/rivetin-ssh-channel.json', 'package.json', 'THIRD_PARTY_NOTICES.txt', 'LICENSE'])].sort();
if (releaseFiles.length > 200) throw new Error('RELEASE_INPUT_LIMIT');
for (const file of releaseFiles.filter(file => file !== 'LICENSE')) {
  const source = path.join(root, file), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(source) !== source) throw new Error('RELEASE_INPUT_INVALID');
  await mkdir(path.dirname(path.join(serviceStage, file)), { recursive: true });
  await copyFile(source, path.join(serviceStage, file));
}
const licenseInfo = await lstat(path.join(root, '../LICENSE'));
if (!licenseInfo.isFile() || licenseInfo.isSymbolicLink() || await realpath(path.join(root, '../LICENSE')) !== path.resolve(root, '../LICENSE')) throw new Error('RELEASE_INPUT_INVALID');
await copyFile(path.join(root, '../LICENSE'), path.join(serviceStage, 'LICENSE'));
let releaseBytes = 0;
for (const file of releaseFiles) {
  const info = await lstat(path.join(serviceStage, file));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || (releaseBytes += info.size) > 32 * 1024 * 1024) throw new Error('RELEASE_INPUT_LIMIT');
}
const integrity = buildIntegrity({ frameworkVersion: FRAMEWORK_VERSION, files: await Promise.all(releaseFiles.map(async file => ({ path: file, content: await readFile(path.join(serviceStage, file)) }))) });
await writeFile(path.join(serviceStage, 'integrity.json'), JSON.stringify(integrity, null, 2) + '\n', { flag: 'wx' });
execFileSync('tar', ['-czf', path.join(output, `rivetin-${FRAMEWORK_VERSION}-service.tar.gz`), '-C', serviceStage, ...releaseFiles, 'integrity.json']);
console.log('Local framework Island and service packages built.');
