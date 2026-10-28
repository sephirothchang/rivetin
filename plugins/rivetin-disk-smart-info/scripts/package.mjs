import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hash, validatePackage } from '../../../framework/server/manifest.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'rivetin.json'), 'utf8'));
if (metadata.name !== manifest.id || metadata.version !== manifest.version) throw new Error('PLUGIN_IDENTITY_MISMATCH');
const files = [];
for (const [target, source] of [['web/plugin.js', 'dist/rivetin/plugin.js'], ['LICENSE', 'LICENSE']]) {
  const content = await readFile(path.join(root, source));
  files.push({ path: target, sha256: hash(content), data: content.toString('base64') });
}
const bytes = Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest, files }));
validatePackage(bytes);
await mkdir(path.join(root, 'release'), { recursive: true });
const output = path.join(root, 'release', `${metadata.name}-${metadata.version}.rivetin.json`);
await writeFile(output, bytes, { flag: 'wx' });
console.log(`Local Rivetin package: ${output}\nSHA-256: ${hash(bytes)}; ${bytes.length} bytes. No upload or deployment performed.`);
