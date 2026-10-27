import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validId } from '../framework/shared/identity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const task = process.argv[2], selected = process.argv[3], npm = process.env.npm_execpath;
if (!npm || !['ci', 'test', 'build', 'package', 'demo'].includes(task)) throw new Error('Run this command through npm.');
const plugins = [];
if (selected && selected !== 'rivetin' && !validId(selected)) throw new Error('Invalid plugin ID');
if (!selected || selected === 'rivetin') {
  const directory = path.join(root, 'framework'), pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (task === 'ci' || pkg.scripts?.[task]) plugins.push({ id: 'rivetin', directory });
}
for (const entry of await readdir(path.join(root, 'plugins'), { withFileTypes: true })) {
  if (selected === 'rivetin') continue;
  if (!entry.isDirectory() || !validId(entry.name) || (selected && selected !== entry.name)) continue;
  const directory = path.join(root, 'plugins', entry.name);
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (pkg.name !== entry.name) throw new Error(`Plugin identity mismatch: ${entry.name}`);
  if (task === 'ci' || pkg.scripts?.[task]) plugins.push({ id: entry.name, directory });
}
if (!plugins.length) throw new Error(`No npm plugins provide task: ${task}`);
if (task === 'demo' && plugins.length !== 1) throw new Error('Select one plugin: npm run demo -- <plugin-id>');
for (const plugin of plugins) {
  process.stdout.write(`\n${plugin.id}: ${task}\n`);
  const args = task === 'ci' ? ['ci'] : ['run', task];
  const result = spawnSync(process.execPath, [npm, '--prefix', plugin.directory, ...args], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
