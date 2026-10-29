import { hash, validatePackage, MAX_PACKAGE_BYTES, FRAMEWORK_VERSION } from './manifest.js';
import { validateCompatibility } from './compatibility.js';
import { validId, assertId } from '../shared/identity.js';
const origin = 'https://rivetin.dev';
const catalogPath = '/catalog/v4/plugins.json';
const sourceErrors = new Set(['UPDATE_SOURCE_ACCESS_REQUIRED', 'UPDATE_SOURCE_RATE_LIMITED', 'UPDATE_SOURCE_UNAVAILABLE', 'UPDATE_REDIRECT_REJECTED', 'UPDATE_DOWNLOAD_TOO_LARGE', 'UPDATE_CATALOG_INVALID']);
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const languageText = (value, max) => value && typeof value === 'object' && !Array.isArray(value) && ['zh-CN', 'en-US'].every(locale => text(value[locale], max));
const catalogFields = new Set(['id', 'version', 'frameworkApi', 'downloadPath', 'sha256', 'status', 'name', 'description', 'author', 'license', 'permissions', 'compatibility']);
const packagePath = (id, version) => `/downloads/plugins/${id}/${version}/${id}-${version}.rivetin.json`;
function metadata(value) {
  const compatibility = validateCompatibility(value.compatibility);
  return { name: ['zh-CN', 'en-US'].map(locale => value.name[locale]), description: ['zh-CN', 'en-US'].map(locale => value.description[locale]), author: value.author,
    license: value.license, permissions: [...value.permissions].sort(), compatibility: { schemaVersion: compatibility.schemaVersion ?? 1, frameworkApi: compatibility.frameworkApi, tower: compatibility.tower,
      smtx: compatibility.smtx && compatibility.smtx !== 'none' ? { product: compatibility.smtx.product, scope: compatibility.smtx.scope, builds: [...compatibility.smtx.builds].sort() } : 'none',
      towerBuilds: [...(compatibility.towerBuilds || [])].sort(), frameworkMinVersion: compatibility.frameworkMinVersion ?? null } };
}
export function newer(candidate, current) {
  if (!versionPattern.test(candidate || '') || !versionPattern.test(current || '')) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export function createUpdateSource({ fetchImpl = fetch, now = Date.now } = {}) {
  async function request(path, max, binary = false) {
    const url = new URL(path, origin);
    const signal = AbortSignal.timeout(8000);
    try {
      if (url.origin !== origin || url.username || url.password || url.port || url.search || url.hash) throw new Error('UPDATE_REDIRECT_REJECTED');
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal,
        headers: { Accept: binary ? 'application/octet-stream' : 'application/json', 'User-Agent': `Rivetin/${FRAMEWORK_VERSION}` } });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('UPDATE_REDIRECT_REJECTED'); }
      if (!response?.ok) {
        const limited = response?.status === 429 || response?.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'));
        try { await response?.body?.cancel(); } catch { /* Keep response diagnostics private. */ }
        throw new Error(limited ? 'UPDATE_SOURCE_RATE_LIMITED' : [401, 403, 404].includes(response?.status) ? 'UPDATE_SOURCE_ACCESS_REQUIRED' : 'UPDATE_SOURCE_UNAVAILABLE');
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('UPDATE_DOWNLOAD_TOO_LARGE'); } chunks.push(Buffer.from(chunk)); }
      return Buffer.concat(chunks);
    } catch (error) { throw new Error(sourceErrors.has(error.message) ? error.message : 'UPDATE_SOURCE_UNAVAILABLE'); }
  }
  async function readCatalog() {
    try {
      const data = JSON.parse(await request(catalogPath, 512 * 1024));
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['schemaVersion', 'plugins'].includes(key)) || data.schemaVersion !== 4 || !Array.isArray(data.plugins) || data.plugins.length > 500) throw new Error('UPDATE_CATALOG_INVALID');
      const seen = new Set();
      for (const item of data.plugins) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !catalogFields.has(key)) ||
            !validId(item.id) || typeof item.version !== 'string' || !versionPattern.test(item.version) || item.frameworkApi !== 1 || seen.has(item.id) ||
            !['draft', 'published'].includes(item.status) || !languageText(item.name, 120) || !languageText(item.description, 500) || !text(item.author, 120) || item.license !== 'MIT' ||
            !Array.isArray(item.permissions) || item.permissions.length > 20 || item.permissions.some(permission => !text(permission, 100) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(permission)) ||
            new Set(item.permissions).size !== item.permissions.length) throw new Error('UPDATE_CATALOG_INVALID');
        if (item.compatibility?.schemaVersion !== 2) throw new Error('UPDATE_CATALOG_INVALID');
        const compatibility = validateCompatibility(item.compatibility);
        if (item.status === 'published' ? item.downloadPath !== packagePath(item.id, item.version) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !compatibility.towerBuilds?.length : item.downloadPath !== null || item.sha256 !== null) throw new Error('UPDATE_CATALOG_INVALID');
        seen.add(item.id);
      }
      return data.plugins;
    } catch (error) {
      // JSON parser diagnostics can contain response fragments; never surface them.
      throw new Error(sourceErrors.has(error.message) ? error.message : 'UPDATE_CATALOG_INVALID');
    }
  }
  let catalogRequest = null, catalogResult = null, catalogExpires = 0, probeRequest = null, probeResult = null, probeExpires = 0;
  async function getCatalog(fresh = false) {
    if (!catalogRequest && !fresh && catalogResult && now() < catalogExpires) return structuredClone(catalogResult);
    if (!catalogRequest) catalogRequest = (async () => {
      try {
        const value = await readCatalog();
        catalogResult = structuredClone(value); catalogExpires = now() + 60000;
        return value;
      } catch (error) { catalogResult = null; catalogExpires = 0; throw error; }
    })().finally(() => { catalogRequest = null; });
    return structuredClone(await catalogRequest);
  }
  const catalog = () => getCatalog();
  async function probe() {
    if (probeResult && now() < probeExpires) return { ...probeResult };
    if (!probeRequest) probeRequest = (async () => {
      let reachable = true, reason;
      // An expired reachability probe checks the source, not a still-cached catalog.
      try { await getCatalog(true); }
      catch (error) {
        reachable = false;
        reason = sourceErrors.has(error.message) ? error.message : 'UPDATE_SOURCE_UNAVAILABLE';
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
    if (!item?.downloadPath) throw new Error('UPDATE_PACKAGE_UNPUBLISHED');
    const bytes = await request(item.downloadPath, MAX_PACKAGE_BYTES, true);
    if (hash(bytes) !== item.sha256) throw new Error('UPDATE_CHECKSUM_FAILED');
    const pkg = validatePackage(bytes);
    if (pkg.manifest.id !== id || pkg.manifest.version !== version) throw new Error('UPDATE_IDENTITY_MISMATCH');
    if (JSON.stringify(metadata(pkg.manifest)) !== JSON.stringify(metadata(item))) throw new Error('UPDATE_METADATA_MISMATCH');
    return bytes;
  } };
}
