import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root = path.resolve(cli, '..');
const args = process.argv.slice(2), goIndex = args.indexOf('--go');
const go = goIndex >= 0 ? args[goIndex + 1] : process.env.RIVETIN_GO;
if (goIndex >= 0 && (!go || go.startsWith('--'))) throw new Error('Provide the Go executable after --go.');
const known = new Set(['--notices-only', '--go']);
for (let index = 0; index < args.length; index++) {
  if (!known.has(args[index])) throw new Error('Unknown preparation option.');
  if (args[index] === '--go') index++;
}
const noticesPath = path.join(cli, 'THIRD_PARTY_NOTICES.txt');
if (go) {
  const env = JSON.parse(execFileSync(go, ['env', '-json', 'GOROOT', 'GOMODCACHE', 'GOVERSION'], { cwd: cli, encoding: 'utf8' }));
  const sections = ['Rivetin portable CLI — third-party notices\n\nGenerated from the selected Go toolchain and the exact modules in go.mod.\nToolchain: ' + env.GOVERSION + '\nFull upstream copyright, license and patent texts follow.'];
  async function include(label, directory, name) {
    const text = (await readFile(path.join(directory, name), 'utf8')).trimEnd();
    sections.push(`${label} — ${name}\n\n${text}`);
  }
  await include('Go standard library and runtime', env.GOROOT, 'LICENSE');
  await include('Go standard library and runtime', env.GOROOT, 'PATENTS');
  const moduleFile = await readFile(path.join(cli, 'go.mod'), 'utf8');
  const modules = [...moduleFile.matchAll(/\b(golang\.org\/x\/(?:crypto|term|sys))\s+(v[^\s)]+)/g)];
  if (modules.length !== 3) throw new Error('Expected the three locked CLI runtime modules.');
  for (const [, name, version] of modules.sort((a, b) => a[1].localeCompare(b[1]))) {
    const directory = path.join(env.GOMODCACHE, `${name}@${version}`);
    for (const file of ['LICENSE', 'PATENTS']) await include(`${name} ${version}`, directory, file);
  }
  const vendorModules = await readFile(path.join(env.GOROOT, 'src/vendor/modules.txt'), 'utf8');
  for (const [, name, version] of vendorModules.matchAll(/^# (golang\.org\/x\/(?:crypto|net|sys|text)) (\S+)/gm)) {
    const directory = path.join(env.GOROOT, 'src/vendor', name);
    for (const file of ['LICENSE', 'PATENTS']) await include(`Go standard-library vendor: ${name} ${version}`, directory, file);
  }
  await writeFile(noticesPath, sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
  console.log('Generated portable CLI notices from locked modules and selected Go toolchain.');
}
if (args.includes('--notices-only')) {
  if (!go) throw new Error('--notices-only requires --go or RIVETIN_GO.');
  process.exit(0);
}
const version = JSON.parse(await readFile(path.join(root, 'framework/package.json'), 'utf8')).version;
const files = {
  'service.tar.gz': path.join(root, `framework/release/rivetin-${version}-service.tar.gz`),
  'island.tar.gz': path.join(root, `framework/release/rivetin-${version}-island.tar.gz`),
  'remoteEntry.js': path.join(root, 'framework/dist/production/build/remoteEntry.js'),
};
const output = path.join(cli, 'payload'); await mkdir(output, { recursive: true });
const bundle = { version, files: {} };
for (const [name, source] of Object.entries(files)) {
  const bytes = await readFile(source);
  bundle.files[name] = createHash('sha256').update(bytes).digest('hex'); await writeFile(path.join(output, name), bytes);
}
await writeFile(path.join(output, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
const notices = await readFile(noticesPath, 'utf8');
if (!notices.includes('Go standard library and runtime') || !notices.includes('golang.org/x/crypto')) throw new Error('Generate complete CLI notices with --go before packaging.');
for (const [, name, version] of (await readFile(path.join(cli, 'go.mod'), 'utf8')).matchAll(/\b(golang\.org\/x\/(?:crypto|term|sys))\s+(v[^\s)]+)/g)) {
  if (!notices.includes(`${name} ${version} — LICENSE`) || !notices.includes(`${name} ${version} — PATENTS`)) throw new Error('CLI module versions changed; regenerate notices with --go.');
}
await writeFile(path.join(output, 'NOTICES.txt'), Buffer.concat([
  await readFile(path.join(root, 'LICENSE')),
  Buffer.from('\n\n' + notices + '\n\nEmbedded Rivetin framework runtime dependencies\n\n'),
  await readFile(path.join(root, 'framework/THIRD_PARTY_NOTICES.txt')),
]));
console.log('Prepared explicit framework release inputs for Go embedding.');
