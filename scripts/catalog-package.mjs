import { isDeepStrictEqual } from 'node:util';
import { validatePackage, hash } from '../framework/server/manifest.js';
import { validateCompatibility } from '../framework/server/compatibility.js';
import { validId } from '../framework/shared/identity.js';

export const SITE = 'https://rivetin.dev';
export const INDEX_PATH = '/catalog/plugins.json';
const version = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const digest = /^[a-f0-9]{64}$/;
const fields = ['id', 'version', 'frameworkApi', 'status', 'downloadPath', 'sha256', 'name', 'description', 'author', 'license', 'permissions', 'compatibility'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const text = (value, max) => typeof value === 'string' && value.trim().length && value.length <= max;
const language = (value, max) => exact(value, ['zh-CN', 'en-US']) && ['zh-CN', 'en-US'].every(key => text(value[key], max));
export function fail(code) { throw Object.assign(new Error(code), { code }); }
export function downloadPath(id, release) {
  if (!validId(id) || !version.test(release || '')) fail('CATALOG_IDENTITY_INVALID');
  return `/downloads/plugins/${id}/${release}/${id}-${release}.rivetin.json`;
}
function entry(value) {
  if (!exact(value, fields) || !validId(value.id) || !version.test(value.version || '') || value.frameworkApi !== 1 || !['draft', 'published'].includes(value.status) ||
      !language(value.name, 120) || !language(value.description, 500) || !text(value.author, 120) || value.license !== 'MIT' ||
      !Array.isArray(value.permissions) || value.permissions.length > 20 || new Set(value.permissions).size !== value.permissions.length || value.permissions.some(item => typeof item !== 'string' || item.length > 100 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(item))) fail('CATALOG_ENTRY_INVALID');
  const compatibility = validateCompatibility(value.compatibility);
  if (value.status === 'published' ? value.downloadPath !== downloadPath(value.id, value.version) || !digest.test(value.sha256 || '') || !compatibility.towerBuilds?.length : value.downloadPath !== null || value.sha256 !== null) fail('CATALOG_PUBLICATION_INVALID');
  return { id: value.id, version: value.version, frameworkApi: 1, status: value.status, downloadPath: value.downloadPath, sha256: value.sha256,
    name: { 'zh-CN': value.name['zh-CN'], 'en-US': value.name['en-US'] }, description: { 'zh-CN': value.description['zh-CN'], 'en-US': value.description['en-US'] },
    author: value.author, license: value.license, permissions: [...value.permissions], compatibility: {
      frameworkApi: compatibility.frameworkApi, tower: compatibility.tower, ...(compatibility.towerBuilds === undefined ? {} : { towerBuilds: [...compatibility.towerBuilds] }),
      ...(compatibility.frameworkMinVersion === undefined ? {} : { frameworkMinVersion: compatibility.frameworkMinVersion }),
      ...(compatibility.frameworkMaxVersionExclusive === undefined ? {} : { frameworkMaxVersionExclusive: compatibility.frameworkMaxVersionExclusive }),
    } };
}
export function validateCatalog(value) {
  if (!exact(value, ['schemaVersion', 'plugins']) || value.schemaVersion !== 3 || !Array.isArray(value.plugins) || value.plugins.length > 500) fail('CATALOG_V3_REQUIRED');
  const ids = new Set(), plugins = value.plugins.map(item => { const result = entry(item); if (ids.has(result.id)) fail('CATALOG_DUPLICATE_ID'); ids.add(result.id); return result; });
  return { schemaVersion: 3, plugins: plugins.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
function fromPackage(bytes, status) {
  const { manifest } = validatePackage(bytes);
  return entry({ id: manifest.id, version: manifest.version, frameworkApi: manifest.compatibility.frameworkApi, status,
    downloadPath: status === 'draft' ? null : downloadPath(manifest.id, manifest.version), sha256: status === 'draft' ? null : hash(bytes),
    ...Object.fromEntries(['name', 'description', 'author', 'license', 'permissions', 'compatibility'].map(key => [key, structuredClone(manifest[key])])) });
}
export const draftEntry = bytes => fromPackage(bytes, 'draft');
// This is an unpublished deployment candidate. Only verifyReceipt can authorize
// committing the staged published entry into the canonical repository catalog.
export const candidateEntry = bytes => fromPackage(bytes, 'published');
function compare(a, b) { return a.split('.').map(Number).map((part, index) => part - Number(b.split('.')[index])).find(part => part !== 0) || 0; }
export function mergeEntries(catalog, entries) {
  const result = validateCatalog(catalog), incoming = new Set();
  for (const value of entries) {
    const next = entry(value); if (incoming.has(next.id)) fail('CATALOG_DUPLICATE_INPUT'); incoming.add(next.id);
    const index = result.plugins.findIndex(item => item.id === next.id), previous = result.plugins[index];
    if (previous && compare(next.version, previous.version) < 0) fail('CATALOG_DOWNGRADE_REJECTED');
    if (previous?.status === 'published' && next.status === 'draft') fail('CATALOG_PUBLICATION_DOWNGRADE_REJECTED');
    if (previous && next.version === previous.version && previous.status === 'published' && !isDeepStrictEqual(next, previous)) fail('CATALOG_SAME_VERSION_IMMUTABLE');
    if (index < 0) result.plugins.push(next); else result.plugins[index] = next;
  }
  return validateCatalog(result);
}
export function serializeCatalog(value) {
  const bytes = Buffer.from(JSON.stringify(validateCatalog(value), null, 2) + '\n');
  if (bytes.length > 512 * 1024) fail('CATALOG_SIZE_LIMIT');
  return bytes;
}
export function verifyReceipt(receipt, downloaded, expected, path, { notBefore, now = Date.now() } = {}) {
  if (!exact(receipt, ['schemaVersion', 'site', 'path', 'status', 'sha256', 'bytes', 'verifiedAt']) || receipt.schemaVersion !== 1 || receipt.site !== SITE || receipt.path !== path || receipt.status !== 200 ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes !== expected.length || receipt.sha256 !== hash(expected) || !Buffer.isBuffer(downloaded) || !downloaded.equals(expected)) fail('SITE_READBACK_MISMATCH');
  const stamp = receipt.verifiedAt, parts = typeof stamp === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(stamp), time = parts ? Date.parse(stamp) : NaN, boundary = Date.parse(notBefore);
  const calendar = parts && new Date(Date.UTC(...[Number(parts[1]), Number(parts[2]) - 1, ...parts.slice(3, 7).map(Number)]));
  const validDate = parts && calendar.getUTCFullYear() === Number(parts[1]) && calendar.getUTCMonth() + 1 === Number(parts[2]) && calendar.getUTCDate() === Number(parts[3]) && Number(parts[4]) < 24 && Number(parts[5]) < 60 && Number(parts[6]) < 60;
  if (!validDate || !Number.isFinite(time) || !Number.isFinite(boundary) || !Number.isFinite(now) || time < boundary || now - time > 86400000 || time > now + 300000) fail('SITE_READBACK_TIME_INVALID');
  return true;
}
