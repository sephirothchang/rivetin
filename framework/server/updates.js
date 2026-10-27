import { hash, validatePackage, MAX_PACKAGE_BYTES } from './manifest.js';
const repository = '/repos/sephirothchang/smartx-extensions';
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
export function newer(candidate, current) {
  if (!versionPattern.test(candidate || '') || !versionPattern.test(current || '')) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export function createUpdateSource({ fetchImpl = fetch, token = '' } = {}) {
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
          headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'PluginKit/0.1.0', ...(api && token ? { Authorization: `Bearer ${token}` } : {}) } });
        if ([301, 302, 303, 307, 308].includes(response.status)) { const next = response.headers.get('location'); await response.body?.cancel(); if (!next) throw new Error('UPDATE_REDIRECT_REJECTED'); url = new URL(next, url); continue; }
        break;
      }
      if (!response?.ok) throw new Error([401, 403, 404].includes(response?.status) ? 'UPDATE_SOURCE_ACCESS_REQUIRED' : 'UPDATE_SOURCE_UNAVAILABLE');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('UPDATE_DOWNLOAD_TOO_LARGE'); } chunks.push(Buffer.from(chunk)); }
      return Buffer.concat(chunks);
    } catch (error) { throw new Error(/^UPDATE_[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_SOURCE_UNAVAILABLE'); }
  }
  async function catalog() {
    try {
      const envelope = JSON.parse(await request(repository + '/contents/catalog/plugins.json?ref=main', 512 * 1024));
      if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string' || envelope.content.length > 400000) throw new Error('UPDATE_CATALOG_INVALID');
      const data = JSON.parse(Buffer.from(envelope.content.replace(/\n/g, ''), 'base64').toString());
      if (data.schemaVersion !== 1 || !Array.isArray(data.plugins) || data.plugins.length > 500) throw new Error('UPDATE_CATALOG_INVALID');
      const seen = new Set();
      for (const item of data.plugins) {
        if (!item || typeof item !== 'object' || !/^pluginkit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || !versionPattern.test(item.version || '') || item.frameworkApi !== 1 || seen.has(item.id)) throw new Error('UPDATE_CATALOG_INVALID');
        if (item.assetId !== null && (!Number.isSafeInteger(item.assetId) || item.assetId <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || ''))) throw new Error('UPDATE_CATALOG_INVALID');
        seen.add(item.id);
      }
      return data.plugins;
    } catch (error) {
      // JSON parser diagnostics can contain response fragments; never surface them.
      throw new Error(/^UPDATE_[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_CATALOG_INVALID');
    }
  }
  return { catalog, async download(id, version) {
    const item = (await catalog()).find(entry => entry.id === id && entry.version === version);
    if (!item?.assetId) throw new Error('UPDATE_PACKAGE_UNPUBLISHED');
    const bytes = await request(`${repository}/releases/assets/${item.assetId}`, MAX_PACKAGE_BYTES, true);
    if (hash(bytes) !== item.sha256) throw new Error('UPDATE_CHECKSUM_FAILED');
    const pkg = validatePackage(bytes);
    if (pkg.manifest.id !== id || pkg.manifest.version !== version) throw new Error('UPDATE_IDENTITY_MISMATCH');
    return bytes;
  } };
}
