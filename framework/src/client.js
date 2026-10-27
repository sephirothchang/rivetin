import { validId } from '../shared/identity.js';
const base = '/api/rivetin/v1';
const loads = new WeakMap();
export function towerAuthHeaders(win) {
  try {
    const value = JSON.parse(win.localStorage?.getItem('token') || 'null')?.value;
    if (typeof value === 'string' && value.length < 8192 && !/[\r\n]/.test(value)) return { Authorization: value };
  } catch { /* Authentication remains unavailable; never fabricate an identity. */ }
  return {};
}
export function createClient(win) {
  async function request(url, method = 'GET', body, signal) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
    const cancel = () => abort.abort();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await win.fetch(url, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
        headers: { ...towerAuthHeaders(win), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
      let value;
      try { value = await response.json(); } catch { if (response.status === 404) return { response, value: null }; throw new Error('INVALID_API_RESPONSE'); }
      return { response, value };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  function checked(result) {
    if (!result.response.ok) {
      const error = new Error(/^[A-Z][A-Z0-9_]{0,99}$/.test(result.value?.error || '') ? result.value.error : result.response.status === 404 ? 'NOT_FOUND' : 'REQUEST_FAILED');
      error.code = error.message; error.status = result.response.status; throw error;
    }
    return result.value;
  }
  const client = async (route, method = 'GET', body, { signal } = {}) => {
    if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) throw new Error('INVALID_API_ROUTE');
    const pluginId = new URL(route, 'http://rivetin.invalid').searchParams.get('pluginId');
    if (pluginId !== null && !validId(pluginId) || body && typeof body === 'object' && Object.hasOwn(body, 'pluginId') && !validId(body.pluginId)) throw new Error('INVALID_PLUGIN_ID');
    // Requests use the Rivetin API once; no alternate endpoint or write retry exists.
    return checked(await request(base + route, method, body, signal));
  };
  client.assetUrl = async (record, file) => { if (!validId(record.id)) throw new Error('INVALID_PLUGIN_ID'); return `${base}/assets/${record.id}/${record.packageId}/${file}`; };
  return client;
}
export async function loadPlugin(win, record, client = createClient(win)) {
  if (!validId(record.id) || !/^[a-f0-9]{64}$/.test(record.packageId) || !/^[a-f0-9]{64}$/.test(record.frontendSha256) || !/^web\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(record.manifest?.frontend?.entry || '') || record.manifest.frontend.entry.split('/').some(part => part === '..')) throw new Error('INVALID_PLUGIN_ENTRY');
  const id = record.id, key = `${id}:${record.packageId}`;
  let cache = loads.get(win); if (!cache) { cache = new Map(); loads.set(win, cache); }
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const source = typeof client.assetUrl === 'function' ? await client.assetUrl({ ...record, id }, record.manifest.frontend.entry) : `${base}/assets/${id}/${record.packageId}/${record.manifest.frontend.entry}`;
    return new Promise((resolve, reject) => {
      const script = win.document.createElement('script');
      let settled = false;
      const finish = (error, definition) => { if (settled) return; settled = true; clearTimeout(timer); script.remove(); if (error) reject(error); else resolve(definition); };
      script.src = source; script.integrity = 'sha256-' + win.btoa(record.frontendSha256.match(/../g).map(pair => String.fromCharCode(parseInt(pair, 16))).join('')); script.crossOrigin = 'use-credentials';
      win.RivetinPlugins ||= Object.create(null); delete win.RivetinPlugins[id];
      script.onload = () => {
        const entry = win.RivetinPlugins[id], factory = entry?.default || entry;
        if (typeof factory !== 'function') return finish(new Error('PLUGIN_EXPORT_INVALID'));
        win.RivetinPlugins[id] = factory; finish(null, factory);
      };
      script.onerror = () => finish(new Error('PLUGIN_LOAD_FAILED'));
      const timer = setTimeout(() => finish(new Error('PLUGIN_LOAD_TIMEOUT')), 8000);
      win.document.head.append(script);
    });
  })();
  cache.set(key, promise);
  try { return await promise; } finally { cache.delete(key); }
}
