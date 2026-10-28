import { hash, validatePackage, MAX_PACKAGE_BYTES, FRAMEWORK_VERSION } from './manifest.js';
import { validateCompatibility } from './compatibility.js';
import { validId, assertId } from '../shared/identity.js';
const repository = '/repos/sephirothchang/rivetin';
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const languageText = (value, max) => value && typeof value === 'object' && !Array.isArray(value) && ['zh-CN', 'en-US'].every(locale => text(value[locale], max));
const catalogFields = new Set(['id', 'version', 'frameworkApi', 'assetId', 'sha256', 'status', 'name', 'description', 'author', 'license', 'permissions', 'compatibility']);
function metadata(value) {
  const compatibility = validateCompatibility(value.compatibility);
  return { name: ['zh-CN', 'en-US'].map(locale => value.name[locale]), description: ['zh-CN', 'en-US'].map(locale => value.description[locale]), author: value.author,
    license: value.license, permissions: [...value.permissions].sort(), compatibility: { frameworkApi: compatibility.frameworkApi, tower: compatibility.tower,
      towerBuilds: [...(compatibility.towerBuilds || [])].sort(), frameworkMinVersion: compatibility.frameworkMinVersion ?? null, frameworkMaxVersionExclusive: compatibility.frameworkMaxVersionExclusive ?? null } };
}
export function newer(candidate, current) {
  if (!versionPattern.test(candidate || '') || !versionPattern.test(current || '')) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export function createUpdateSource({ fetchImpl = fetch, token = '', now = Date.now } = {}) {
  if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new Error('UPDATE_CREDENTIAL_INVALID');
  async function request(path, max, binary = false) {
    let url = new URL(path, 'https://api.github.com'), response;
    const signal = AbortSignal.timeout(8000);
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const api = url.hostname === 'api.github.com';
        if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !(api && url.pathname.startsWith(repository + '/') || binary && url.hostname === 'release-assets.githubusercontent.com')) throw new Error('UPDATE_REDIRECT_REJECTED');
        response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal,
          headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': `Rivetin/${FRAMEWORK_VERSION}`, ...(api && token ? { Authorization: `Bearer ${token}` } : {}) } });
        if ([301, 302, 303, 307, 308].includes(response.status)) { const next = response.headers.get('location'); await response.body?.cancel(); if (!next) throw new Error('UPDATE_REDIRECT_REJECTED'); url = new URL(next, url); continue; }
        break;
      }
      if (!response?.ok) throw new Error([401, 403, 404].includes(response?.status) ? 'UPDATE_SOURCE_ACCESS_REQUIRED' : 'UPDATE_SOURCE_UNAVAILABLE');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('UPDATE_DOWNLOAD_TOO_LARGE'); } chunks.push(Buffer.from(chunk)); }
      return Buffer.concat(chunks);
    } catch (error) { throw new Error(/^UPDATE_[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_SOURCE_UNAVAILABLE'); }
  }
  async function readCatalog() {
    try {
      const envelope = JSON.parse(await request(repository + '/contents/catalog/plugins.json?ref=main', 512 * 1024));
      if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string' || envelope.content.length > 400000) throw new Error('UPDATE_CATALOG_INVALID');
      const data = JSON.parse(Buffer.from(envelope.content.replace(/\n/g, ''), 'base64').toString());
      if (data.schemaVersion !== 2 || !Array.isArray(data.plugins) || data.plugins.length > 500) throw new Error('UPDATE_CATALOG_INVALID');
      const seen = new Set();
      for (const item of data.plugins) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !catalogFields.has(key)) ||
            !validId(item.id) || typeof item.version !== 'string' || !versionPattern.test(item.version) || item.frameworkApi !== 1 || seen.has(item.id) ||
            !['draft', 'published'].includes(item.status) || !languageText(item.name, 120) || !languageText(item.description, 500) || !text(item.author, 120) || item.license !== 'MIT' ||
            !Array.isArray(item.permissions) || item.permissions.length > 20 || item.permissions.some(permission => !text(permission, 100) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(permission)) ||
            new Set(item.permissions).size !== item.permissions.length) throw new Error('UPDATE_CATALOG_INVALID');
        const compatibility = validateCompatibility(item.compatibility);
        if (item.status === 'published' ? !Number.isSafeInteger(item.assetId) || item.assetId <= 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !compatibility.towerBuilds?.length : item.assetId !== null || item.sha256 !== null) throw new Error('UPDATE_CATALOG_INVALID');
        seen.add(item.id);
      }
      return data.plugins;
    } catch (error) {
      // JSON parser diagnostics can contain response fragments; never surface them.
      throw new Error(/^UPDATE_[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_CATALOG_INVALID');
    }
  }
  let catalogRequest = null, probeRequest = null, probeResult = null, probeExpires = 0;
  function catalog() {
    if (!catalogRequest) catalogRequest = readCatalog().finally(() => { catalogRequest = null; });
    return catalogRequest;
  }
  async function probe() {
    if (probeResult && now() < probeExpires) return { ...probeResult };
    if (!probeRequest) probeRequest = (async () => {
      let reachable = true, reason;
      try { await catalog(); }
      catch (error) {
        reachable = false;
        const allowed = new Set(['UPDATE_SOURCE_ACCESS_REQUIRED', 'UPDATE_SOURCE_UNAVAILABLE', 'UPDATE_CATALOG_INVALID', 'UPDATE_REDIRECT_REJECTED', 'UPDATE_DOWNLOAD_TOO_LARGE']);
        reason = allowed.has(error.message) ? error.message : 'UPDATE_SOURCE_UNAVAILABLE';
      }
      const checked = now();
      probeResult = { reachable, checkedAt: new Date(checked).toISOString(), ...(reason ? { reason } : {}) };
      probeExpires = checked + 30000;
      return probeResult;
    })().finally(() => { probeRequest = null; });
    return { ...await probeRequest };
  }
  async function market() { return (await catalog()).filter(item => item.status === 'published').map(item => structuredClone(item)); }
  return { catalog, probe, market, async download(id, version) {
    assertId(id);
    const item = (await market()).find(entry => entry.id === id && entry.version === version);
    if (!item?.assetId) throw new Error('UPDATE_PACKAGE_UNPUBLISHED');
    const bytes = await request(`${repository}/releases/assets/${item.assetId}`, MAX_PACKAGE_BYTES, true);
    if (hash(bytes) !== item.sha256) throw new Error('UPDATE_CHECKSUM_FAILED');
    const pkg = validatePackage(bytes);
    if (pkg.manifest.id !== id || pkg.manifest.version !== version) throw new Error('UPDATE_IDENTITY_MISMATCH');
    if (JSON.stringify(metadata(pkg.manifest)) !== JSON.stringify(metadata(item))) throw new Error('UPDATE_METADATA_MISMATCH');
    return bytes;
  } };
}
