import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hash, MAX_PACKAGE_BYTES } from '../framework/server/manifest.js';
import { candidateEntry, downloadPath, fail, mergeEntries, serializeCatalog, validateCatalog, verifyReceipt } from './catalog-package.mjs';
import { run as catalogRun } from './catalog-update.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const INDEX = '/catalog/v4/plugins.json', META = '/catalog/v4/release.json';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const descriptor = (name, raw) => ({ path: name, sha256: hash(raw), bytes: raw.length });
function need(condition, code) { if (!condition) fail(code); }
function privateName(name) {
  need(typeof name === 'string' && name.startsWith('.local/') && !/[\\:\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'CATALOG_PRIVATE_EVIDENCE_REQUIRED');
  return name;
}
async function safe(root, name, missing = false) {
  need(typeof name === 'string' && !path.posix.isAbsolute(name) && !/[\\:\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'CATALOG_PATH_REJECTED');
  let current = await realpath(root); const parts = name.split('/');
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    try { const info = await lstat(current); need(!info.isSymbolicLink() && (i === parts.length - 1 ? info.isFile() : info.isDirectory()), 'CATALOG_PATH_REJECTED'); }
    catch (error) { if (missing && i === parts.length - 1 && error.code === 'ENOENT') return current; throw error; }
  }
  return current;
}
async function raw(root, name, max) {
  const file = await open(await safe(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const info = await file.stat(); need(info.isFile() && info.size <= max, 'CATALOG_INPUT_SIZE_LIMIT'); const result = await file.readFile(); need(result.length <= max, 'CATALOG_INPUT_SIZE_LIMIT'); return result; }
  finally { await file.close(); }
}
async function json(root, name, max) { const bytes = await raw(root, name, max); try { return { raw: bytes, value: JSON.parse(bytes) }; } catch { fail('CATALOG_JSON_INVALID'); } }
function snapshot(id) { need(typeof id === 'string' && /^ML-V4-\d{6}\.(0|[1-9]\d{0,14})$/.test(id) && Number.isSafeInteger(Number(id.split('.')[1])), 'CATALOG_RELEASE_ID_INVALID'); return `/catalog/v4/releases/${id}/plugins.json`; }
function metadata(value, index) {
  need(exact(value, ['metadataSchemaVersion', 'publicationId', 'catalogSchemaVersion', 'catalogPath', 'catalogSHA256', 'catalogBytes', 'snapshotPath', 'publishedAt']) && value.metadataSchemaVersion === 1 && value.catalogSchemaVersion === 4 && value.catalogPath === INDEX && iso(value.publishedAt), 'CATALOG_RELEASE_METADATA_INVALID');
  const day = new Date(Date.parse(value.publishedAt) + 8 * 3600000).toISOString().slice(2, 10).replaceAll('-', '');
  need(value.publicationId.split('.')[0] === 'ML-V4-' + day && value.snapshotPath === snapshot(value.publicationId) && value.catalogSHA256 === hash(index) && value.catalogBytes === index.length, 'CATALOG_RELEASE_METADATA_BINDING');
  return value;
}
async function drop(root, name) {
  privateName(name); const stage = await json(root, name + '/stage.json', 256 * 1024), s = stage.value;
  need(exact(s, ['schemaVersion', 'preparedAt', 'catalogPath', 'baseCatalogSHA256', 'indexPath', 'indexSHA256', 'packages', 'candidateOnly']) && s.schemaVersion === 1 && s.candidateOnly === true && s.catalogPath === INDEX.slice(1) && s.indexPath === INDEX && iso(s.preparedAt) && digest(s.baseCatalogSHA256) && digest(s.indexSHA256) && Array.isArray(s.packages) && s.packages.length <= 500, 'CATALOG_STAGE_INVALID');
  const index = await raw(root, name + INDEX, 512 * 1024);
  need(hash(index) === s.indexSHA256 && serializeCatalog(validateCatalog(JSON.parse(index), 4), 4).equals(index), 'CATALOG_STAGE_CHANGED');
  const packages = [], entries = [], ids = new Set();
  for (const item of s.packages) {
    need(exact(item, ['id', 'version', 'downloadPath', 'sha256', 'bytes']) && item.downloadPath === downloadPath(item.id, item.version) && !ids.has(item.id), 'CATALOG_STAGE_INVALID'); ids.add(item.id);
    const bytes = await raw(root, name + item.downloadPath, MAX_PACKAGE_BYTES), entry = candidateEntry(bytes, 4);
    need(entry.id === item.id && entry.version === item.version && item.sha256 === hash(bytes) && item.bytes === bytes.length, 'CATALOG_STAGE_CHANGED');
    packages.push(descriptor(item.downloadPath, bytes)); entries.push(entry);
  }
  return { stage, index, packages, entries };
}
function request(value, d) {
  need(exact(value, ['schemaVersion', 'requestId', 'stageSHA256', 'catalogPath', 'indexSHA256', 'indexBytes', 'baseReleaseSHA256', 'candidateOnly']) && value.schemaVersion === 1 && value.candidateOnly === true && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId) && value.catalogPath === INDEX && value.stageSHA256 === hash(d.stage.raw) && value.indexSHA256 === hash(d.index) && value.indexBytes === d.index.length && (value.baseReleaseSHA256 === null || digest(value.baseReleaseSHA256)), 'CATALOG_RELEASE_REQUEST_INVALID');
}
function ledger(value, m, metaRaw) {
  need(exact(value, ['schemaVersion', 'currentPublicationId', 'releases']) && value.schemaVersion === 1 && value.currentPublicationId === m.publicationId && Array.isArray(value.releases) && value.releases.length <= 5000, 'CATALOG_RELEASE_LEDGER_INVALID');
  const ids = new Set(); let pending = 0;
  for (const r of value.releases) {
    need(exact(r, ['publicationId', 'catalogSchemaVersion', 'catalogSHA256', 'catalogBytes', 'snapshotPath', 'publishedAt', 'metadataSHA256', 'metadataBytes', 'status', 'verifiedAt']) && !ids.has(r.publicationId) && digest(r.metadataSHA256) && Number.isSafeInteger(r.metadataBytes) && r.metadataBytes > 0 && r.metadataBytes <= 8192 && ['reserved', 'local-committed', 'verified', 'abandoned'].includes(r.status) && (r.status === 'verified' ? iso(r.verifiedAt) : r.verifiedAt === null), 'CATALOG_RELEASE_LEDGER_INVALID');
    need(digest(r.catalogSHA256) && Number.isSafeInteger(r.catalogBytes) && r.catalogBytes > 0 && r.catalogBytes <= 512 * 1024 && r.catalogSchemaVersion === 4 && iso(r.publishedAt) && r.snapshotPath === snapshot(r.publicationId) && r.publicationId.split('.')[0] === 'ML-V4-' + new Date(Date.parse(r.publishedAt) + 8 * 3600000).toISOString().slice(2, 10).replaceAll('-', ''), 'CATALOG_RELEASE_LEDGER_INVALID');
    ids.add(r.publicationId); if (r.status === 'reserved') pending++;
  }
  const current = value.releases.find(r => r.publicationId === m.publicationId);
  need(pending <= 1 && current && ['local-committed', 'verified'].includes(current.status) && current.catalogSHA256 === m.catalogSHA256 && current.catalogBytes === m.catalogBytes && current.snapshotPath === m.snapshotPath && current.publishedAt === m.publishedAt && current.metadataSHA256 === hash(metaRaw) && current.metadataBytes === metaRaw.length, 'CATALOG_RELEASE_LEDGER_BINDING');
}
function options(args) {
  const mode = args[0], o = { mode, check: false, first: false };
  need(['release-stage', 'verify-release'].includes(mode), 'CATALOG_MODE_INVALID');
  const map = { '--stage-output': 'stage', '--base-release': 'base', '--proof-directory': 'proof', '--publication-output': 'output', '--publication-output-sha256': 'outputHash', '--ledger': 'ledger' };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === '--check' || key === '--first-release') { const field = key === '--check' ? 'check' : 'first'; need(!o[field], 'CATALOG_ARGUMENT_INVALID'); o[field] = true; continue; }
    need(Object.hasOwn(map, key) && !o[map[key]] && args[i + 1] && !args[i + 1].startsWith('--'), 'CATALOG_ARGUMENT_INVALID'); o[map[key]] = args[++i];
  }
  privateName(o.stage);
  need(mode === 'release-stage' ? !o.proof && !o.output && !o.outputHash && !o.ledger && !o.check && (o.first !== !!o.base) : !o.base && !o.first && digest(o.outputHash), 'CATALOG_ARGUMENT_INVALID');
  if (o.base) privateName(o.base);
  if (mode === 'verify-release') for (const key of ['proof', 'output', 'ledger']) privateName(o[key]);
  return o;
}
export async function run(args, { root = repository, stdout = process.stdout, now = Date.now() } = {}) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    stdout.write('Offline v4 release metadata verification\n\nrelease-stage --stage-output .local/<drop> (--first-release | --base-release .local/<previous-release.json>)\nverify-release --stage-output .local/<drop> --proof-directory .local/<readback> --publication-output .local/<publication-output.json> --publication-output-sha256 <coordinator-frozen-sha256> --ledger .local/<committed-ledger.json> [--check]\n\nStage allocates no ML ID. Verify checks offline raw bytes and receipts; it does not fetch HTTPS or prove receipt provenance. --check never writes canonical and exits 1 if it would change.\n'); return 0;
  }
  const o = options(args), d = await drop(root, o.stage);
  if (o.mode === 'release-stage') {
    const current = await raw(root, INDEX.slice(1), 512 * 1024); validateCatalog(JSON.parse(current), 4);
    need(hash(current) === d.stage.value.baseCatalogSHA256, 'CATALOG_CHANGED_SINCE_STAGE');
    need(serializeCatalog(mergeEntries(JSON.parse(current), d.entries, 4), 4).equals(d.index), 'CATALOG_STAGE_BASE_MISMATCH');
    let baseReleaseSHA256 = null;
    if (o.base) { const base = await json(root, o.base, 8192); metadata(base.value, current); baseReleaseSHA256 = hash(base.raw); }
    const value = { schemaVersion: 1, requestId: randomUUID(), stageSHA256: hash(d.stage.raw), catalogPath: INDEX, indexSHA256: hash(d.index), indexBytes: d.index.length, baseReleaseSHA256, candidateOnly: true };
    const file = await open(await safe(root, o.stage + '/release-stage.json', true), 'wx', 0o600);
    try { await file.writeFile(encode(value)); await file.sync(); } finally { await file.close(); }
    stdout.write(JSON.stringify({ mode: o.mode, candidateOnly: true, officialIdAllocated: false, canonicalUpdated: false }) + '\n'); return 0;
  }
  const req = await json(root, o.stage + '/release-stage.json', 8192); request(req.value, d);
  const output = await json(root, o.output, 256 * 1024), m = output.value;
  need(hash(output.raw) === o.outputHash, 'CATALOG_RELEASE_OUTPUT_CHANGED');
  need(exact(m, ['schemaVersion', 'requestId', 'stageSHA256', 'releaseRequestSHA256', 'publicationId', 'publicationState', 'files', 'ledger', 'packages']) && m.schemaVersion === 1 && m.publicationState === 'local-committed' && m.requestId === req.value.requestId && m.stageSHA256 === hash(d.stage.raw) && m.releaseRequestSHA256 === hash(req.raw) && isDeepStrictEqual(m.packages, d.packages), 'CATALOG_RELEASE_OUTPUT_INVALID');
  const snap = snapshot(m.publicationId), paths = [INDEX, META, snap, snap.replace(/plugins\.json$/, 'release.json')];
  need(Array.isArray(m.files) && m.files.length === 4, 'CATALOG_RELEASE_OUTPUT_INVALID');
  const names = [['catalog.plugins.json', 'catalog.receipt.json'], ['catalog.release.json', 'catalog.release.receipt.json'], ['catalog.snapshot.plugins.json', 'catalog.snapshot.receipt.json'], ['catalog.snapshot.release.json', 'catalog.snapshot.release.receipt.json']];
  const bodies = [];
  for (const [i, namesPair] of names.entries()) {
    const body = await raw(root, o.proof + '/' + namesPair[0], i % 2 ? 8192 : 512 * 1024);
    need(isDeepStrictEqual(m.files[i], descriptor(paths[i], body)), 'CATALOG_RELEASE_OUTPUT_BINDING'); bodies.push(body);
  }
  need(bodies[0].equals(d.index) && bodies[0].equals(bodies[2]) && bodies[1].equals(bodies[3]), 'CATALOG_RELEASE_PROOF_BINDING');
  const meta = metadata(JSON.parse(bodies[1]), d.index); need(meta.publicationId === m.publicationId, 'CATALOG_RELEASE_PROOF_BINDING');
  const notBefore = new Date(Math.max(Date.parse(d.stage.value.preparedAt), Date.parse(meta.publishedAt))).toISOString();
  for (const [i, pair] of names.entries()) verifyReceipt((await json(root, o.proof + '/' + pair[1], 16384)).value, bodies[i], bodies[i], paths[i], { notBefore, now });
  const l = await json(root, o.ledger, 2 * 1024 * 1024);
  need(isDeepStrictEqual(m.ledger, descriptor('catalog-release-ledger.json', l.raw)), 'CATALOG_RELEASE_LEDGER_BINDING'); ledger(l.value, meta, bodies[1]);
  for (const item of d.stage.value.packages) {
    const stem = item.id + '-' + item.version, expected = await raw(root, o.stage + item.downloadPath, MAX_PACKAGE_BYTES);
    verifyReceipt((await json(root, o.proof + '/' + stem + '.receipt.json', 16384)).value, await raw(root, o.proof + '/' + stem + '.rivetin.json', MAX_PACKAGE_BYTES), expected, item.downloadPath, { notBefore, now });
  }
  // The original verifier retains package validation, cross-catalog checks and canonical CAS.
  let canonical;
  const result = await catalogRun(['verify', '--catalog', INDEX.slice(1), '--stage-output', o.stage, '--proof-directory', o.proof, ...(o.check ? ['--check'] : [])], { root, now, stdout: { write(value) { canonical = JSON.parse(value); } } });
  stdout.write(JSON.stringify({ ...canonical, mode: o.mode, publicationId: m.publicationId, check: o.check, result }) + '\n'); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { process.stderr.write(/^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code + '\n' : 'CATALOG_RELEASE_OPERATION_FAILED\n'); process.exitCode = 2; });
