import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash, MAX_PACKAGE_BYTES } from '../framework/server/manifest.js';
import { candidateEntry, downloadPath, draftEntry, fail, INDEX_PATH, mergeEntries, serializeCatalog, validateCatalog, verifyReceipt } from './catalog-package.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = /^plugins\/(rivetin-[a-z0-9]+(?:-[a-z0-9]+)*)\/release\/\1-((?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7}))\.rivetin\.json$/;
function relative(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('CATALOG_PATH_REJECTED');
  return value;
}
async function safePath(root, name, { directory = false, missing = false } = {}) {
  relative(name); const base = await realpath(root), parts = name.split('/'); let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]); const last = index === parts.length - 1;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (last && !directory ? !info.isFile() : !info.isDirectory())) fail('CATALOG_PATH_REJECTED');
    } catch (error) { if (last && missing && error.code === 'ENOENT') return current; throw error; }
  }
  return current;
}
async function bytes(root, name, max) {
  const file = await safePath(root, name), handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const info = await handle.stat(); if (!info.isFile() || info.size > max) fail('CATALOG_INPUT_SIZE_LIMIT'); return await handle.readFile(); } finally { await handle.close(); }
}
function privatePath(name) { relative(name); if (!name.startsWith('.local/')) fail('CATALOG_PRIVATE_EVIDENCE_REQUIRED'); return name; }
async function catalog(root, name) {
  relative(name); if (!/^catalog\/[a-z][a-z0-9-]*\.json$/.test(name)) fail('CATALOG_PATH_REJECTED');
  const raw = await bytes(root, name, 512 * 1024); let value; try { value = JSON.parse(raw); } catch { fail('CATALOG_JSON_INVALID'); }
  return { raw, value: validateCatalog(value) };
}
async function packages(root, names, published) {
  if (!names.length || names.length > 500) fail('CATALOG_PACKAGE_REQUIRED');
  return Promise.all(names.map(async name => {
    relative(name); const match = packageName.exec(name); if (!match) fail('CATALOG_PACKAGE_PATH_INVALID');
    const raw = await bytes(root, name, MAX_PACKAGE_BYTES), entry = (published ? candidateEntry : draftEntry)(raw);
    if (entry.id !== match[1] || entry.version !== match[2]) fail('CATALOG_PACKAGE_FILENAME_MISMATCH');
    return { raw, entry };
  }));
}
async function atomicCatalog(root, name, raw, expected) {
  const target = await safePath(root, name); if (!(await bytes(root, name, 512 * 1024)).equals(expected)) fail('CATALOG_CHANGED_DURING_OPERATION');
  const temporary = path.join(path.dirname(target), '.catalog-' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', (await lstat(target)).mode & 0o777);
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    if (!(await bytes(root, name, 512 * 1024)).equals(expected)) fail('CATALOG_CHANGED_DURING_OPERATION');
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function options(args) {
  const mode = args[0], result = { mode, packages: [], catalog: 'catalog/plugins.json', check: false };
  if (!['draft', 'stage', 'verify'].includes(mode)) fail('CATALOG_MODE_INVALID');
  const mapping = { '--package': 'packages', '--catalog': 'catalog', '--stage-output': 'stage', '--proof-directory': 'proof' }, seen = new Set();
  for (let index = 1; index < args.length; index++) {
    const key = args[index]; if (key === '--check') { if (result.check) fail('CATALOG_ARGUMENT_INVALID'); result.check = true; continue; }
    if (!Object.hasOwn(mapping, key) || !args[index + 1] || args[index + 1].startsWith('--')) fail('CATALOG_ARGUMENT_INVALID');
    const value = args[++index]; if (key === '--package') result.packages.push(value); else { if (seen.has(key)) fail('CATALOG_ARGUMENT_INVALID'); seen.add(key); result[mapping[key]] = value; }
  }
  if (mode === 'stage' && (result.check || result.proof) || mode === 'draft' && (result.stage || result.proof) || mode === 'verify' && result.packages.length) fail('CATALOG_ARGUMENT_INVALID');
  return result;
}
async function exclusiveFile(file, raw) { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); } }
export async function run(args, { root = repository, stdout = process.stdout, now = Date.now() } = {}) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    stdout.write(`Offline Rivetin catalog v3 maintenance\n\n` +
      `draft --package plugins/<id>/release/<id>-<version>.rivetin.json [--package ...] [--catalog catalog/plugins.json] [--check]\n` +
      `stage --package <package> [--package ...] --stage-output .local/<new-directory> [--catalog catalog/plugins.json]\n` +
      `verify --stage-output .local/<directory> --proof-directory .local/<readback> [--catalog catalog/plugins.json] [--check]\n\n` +
      `Stage creates a candidate only; it does not publish or edit the canonical catalog.\n` +
      `Verify needs catalog.receipt.json + catalog.plugins.json and <id>-<version>.receipt.json + <id>-<version>.rivetin.json.\n` +
      `Receipts attest HTTPS readbacks from https://rivetin.dev; this offline tool validates their fields and actual downloaded bytes, not the network provenance itself.\n` +
      `--check never writes and exits 1 if canonical bytes would change. Receipt time must follow stage preparation, be at most 24 hours old, and not exceed the local clock by more than five minutes.\n`);
    return 0;
  }
  const optionsValue = options(args), { mode } = optionsValue, current = await catalog(root, optionsValue.catalog);
  if (mode === 'draft') {
    const inputs = await packages(root, optionsValue.packages, false), output = serializeCatalog(mergeEntries(current.value, inputs.map(item => item.entry))), changed = !current.raw.equals(output);
    if (changed && !optionsValue.check) await atomicCatalog(root, optionsValue.catalog, output, current.raw);
    stdout.write(JSON.stringify({ mode, checked: optionsValue.check, changed, canonicalUpdated: changed && !optionsValue.check, count: inputs.length }) + '\n');
    return optionsValue.check && changed ? 1 : 0;
  }
  if (mode === 'stage') {
    privatePath(optionsValue.stage); const inputs = await packages(root, optionsValue.packages, true), output = serializeCatalog(mergeEntries(current.value, inputs.map(item => item.entry)));
    const target = await safePath(root, optionsValue.stage, { directory: true, missing: true });
    try { await mkdir(target, { recursive: false }); } catch (error) { if (error.code === 'EEXIST') fail('CATALOG_STAGE_EXISTS'); throw error; }
    try {
      await mkdir(path.join(target, 'catalog')); await exclusiveFile(path.join(target, 'catalog/plugins.json'), output);
      const staged = [];
      for (const item of inputs.sort((a, b) => a.entry.id.localeCompare(b.entry.id, 'en'))) {
        const name = item.entry.downloadPath.slice(1), file = path.join(target, ...name.split('/')); await mkdir(path.dirname(file), { recursive: true }); await exclusiveFile(file, item.raw);
        staged.push({ id: item.entry.id, version: item.entry.version, downloadPath: item.entry.downloadPath, sha256: hash(item.raw), bytes: item.raw.length });
      }
      await exclusiveFile(path.join(target, 'stage.json'), Buffer.from(JSON.stringify({ schemaVersion: 1, preparedAt: new Date(now).toISOString(), catalogPath: optionsValue.catalog, baseCatalogSHA256: hash(current.raw), indexPath: INDEX_PATH, indexSHA256: hash(output), packages: staged, candidateOnly: true }, null, 2) + '\n'));
    } catch (error) { fail(error.code === 'EEXIST' ? 'CATALOG_STAGE_EXISTS' : 'CATALOG_STAGE_INCOMPLETE'); }
    stdout.write(JSON.stringify({ mode, candidateOnly: true, publishedVerified: false, canonicalUpdated: false, count: inputs.length }) + '\n'); return 0;
  }
  privatePath(optionsValue.stage); privatePath(optionsValue.proof); await safePath(root, optionsValue.stage, { directory: true }); await safePath(root, optionsValue.proof, { directory: true });
  const stage = JSON.parse(await bytes(root, optionsValue.stage + '/stage.json', 256 * 1024));
  if (stage.schemaVersion !== 1 || stage.candidateOnly !== true || stage.catalogPath !== optionsValue.catalog || stage.indexPath !== INDEX_PATH || !Array.isArray(stage.packages) || !stage.packages.length || stage.packages.length > 500 || !Number.isFinite(Date.parse(stage.preparedAt))) fail('CATALOG_STAGE_INVALID');
  const output = await bytes(root, optionsValue.stage + '/catalog/plugins.json', 512 * 1024); if (hash(output) !== stage.indexSHA256 || !serializeCatalog(JSON.parse(output)).equals(output)) fail('CATALOG_STAGE_CHANGED');
  const downloadedIndex = await bytes(root, optionsValue.proof + '/catalog.plugins.json', 512 * 1024), indexReceipt = JSON.parse(await bytes(root, optionsValue.proof + '/catalog.receipt.json', 16 * 1024));
  verifyReceipt(indexReceipt, downloadedIndex, output, INDEX_PATH, { notBefore: stage.preparedAt, now });
  const entries = [], ids = new Set();
  for (const item of stage.packages) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join() !== 'bytes,downloadPath,id,sha256,version' || item.downloadPath !== downloadPath(item.id, item.version) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) fail('CATALOG_STAGE_INVALID');
    const expectedPath = candidateEntry(await bytes(root, optionsValue.stage + '/' + relative(item.downloadPath.slice(1)), MAX_PACKAGE_BYTES));
    if (ids.has(item.id) || expectedPath.id !== item.id || expectedPath.version !== item.version || expectedPath.downloadPath !== item.downloadPath || expectedPath.sha256 !== item.sha256) fail('CATALOG_STAGE_INVALID'); ids.add(item.id);
    const packaged = await bytes(root, optionsValue.stage + item.downloadPath, MAX_PACKAGE_BYTES);
    if (packaged.length !== item.bytes) fail('CATALOG_STAGE_CHANGED');
    const stem = item.id + '-' + item.version, receipt = JSON.parse(await bytes(root, optionsValue.proof + '/' + stem + '.receipt.json', 16 * 1024)), downloaded = await bytes(root, optionsValue.proof + '/' + stem + '.rivetin.json', MAX_PACKAGE_BYTES);
    verifyReceipt(receipt, downloaded, packaged, item.downloadPath, { notBefore: stage.preparedAt, now }); entries.push(expectedPath);
  }
  const expected = serializeCatalog(mergeEntries(current.value, entries)); if (!expected.equals(output)) fail('CATALOG_STAGE_BASE_MISMATCH');
  const alreadyCurrent = current.raw.equals(output); if (!alreadyCurrent && hash(current.raw) !== stage.baseCatalogSHA256) fail('CATALOG_CHANGED_SINCE_STAGE');
  if (!alreadyCurrent && !optionsValue.check) await atomicCatalog(root, optionsValue.catalog, output, current.raw);
  stdout.write(JSON.stringify({ mode, offlineReceiptVerified: true, canonicalUpdated: !alreadyCurrent && !optionsValue.check, changed: !alreadyCurrent, count: entries.length }) + '\n');
  return optionsValue.check && !alreadyCurrent ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { process.stderr.write(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'CATALOG_OPERATION_FAILED\n'); process.exitCode = 2; });
}
