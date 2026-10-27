const base = '/api/pluginkit/v1';
export function towerAuthHeaders(win) {
  try {
    const value = JSON.parse(win.localStorage?.getItem('token') || 'null')?.value;
    if (typeof value === 'string' && value.length < 8192 && !/[\r\n]/.test(value)) return { Authorization: value };
  } catch { /* Authentication remains unavailable; never fabricate an identity. */ }
  return {};
}
export function createClient(win) {
  return async (route, method = 'GET', body) => {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await win.fetch(base + route, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
        headers: { ...towerAuthHeaders(win), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'REQUEST_FAILED');
      return value;
    } finally { clearTimeout(timer); }
  };
}
export function loadPlugin(win, record) {
  const id = record.id;
  if (!/^pluginkit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !/^[a-f0-9]{64}$/.test(record.packageId) || !/^[a-f0-9]{64}$/.test(record.frontendSha256)) return Promise.reject(new Error('INVALID_PLUGIN_ENTRY'));
  return new Promise((resolve, reject) => {
    const script = win.document.createElement('script');
    let settled = false;
    const finish = (error, definition) => {
      if (settled) return; settled = true; clearTimeout(timer); script.remove();
      if (error) reject(error); else resolve(definition);
    };
    script.src = `${base}/assets/${id}/${record.packageId}/${record.manifest.frontend.entry}`;
    script.integrity = 'sha256-' + win.btoa(record.frontendSha256.match(/../g).map(pair => String.fromCharCode(parseInt(pair, 16))).join(''));
    script.crossOrigin = 'use-credentials';
    win.PluginKitPlugins ||= Object.create(null); delete win.PluginKitPlugins[id];
    script.onload = () => {
      const factory = win.PluginKitPlugins[id]?.default || win.PluginKitPlugins[id];
      if (typeof factory !== 'function') return finish(new Error('PLUGIN_EXPORT_INVALID'));
      finish(null, factory);
    };
    script.onerror = () => finish(new Error('PLUGIN_LOAD_FAILED'));
    const timer = setTimeout(() => finish(new Error('PLUGIN_LOAD_TIMEOUT')), 8000);
    win.document.head.append(script);
  });
}
