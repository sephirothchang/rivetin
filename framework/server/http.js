import { MAX_PACKAGE_BYTES } from './manifest.js';

export const PREFIX = '/api/pluginkit/v1';
export function createApi(service, { authenticate, origins = [] } = {}) {
  if (typeof authenticate !== 'function') throw new Error('AUTHENTICATOR_REQUIRED');
  const allowed = new Set(origins);
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  async function body(req, max = 1024 * 1024) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('CONTENT_TYPE_REQUIRED');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(PREFIX + '/')) return false;
    try {
      const route = url.pathname.slice(PREFIX.length);
      // Executable frontend assets are public code, like Tower's own Island bundles.
      // No settings, credentials, manifests or runtime files are served here.
      if (req.method === 'GET' && route.startsWith('/assets/')) {
        const [, , id, digest, ...parts] = route.split('/'), file = parts.join('/');
        const asset = await service.asset(id, digest, file);
        if (!file.startsWith('web/') || !/\.(js|css)$/.test(file)) throw new Error('ASSET_NOT_FOUND');
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/css', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(asset.content); return true;
      }
      const actor = await authenticate(req);
      if (!actor) return send(res, 401, { error: 'AUTHENTICATION_REQUIRED' });
      if (!['GET', 'POST', 'PUT'].includes(req.method)) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (req.method !== 'GET' && (!actor.admin || !allowed.has(req.headers.origin))) return send(res, 403, { error: 'ADMIN_OR_ORIGIN_REQUIRED' });
      if (req.method === 'GET') {
        if (route === '/runtime') return send(res, 200, await service.runtime());
        if (route === '/plugins') return send(res, 200, { items: await service.plugins(), packages: actor.admin ? await service.packages() : [] });
        if (route === '/config') return send(res, 200, await service.loadConfig());
        if (route === '/logs') {
          if (!actor.admin) return send(res, 403, { error: 'ADMIN_REQUIRED' });
          return send(res, 200, await service.logs({ pluginId: url.searchParams.get('pluginId'), limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
        }
      }
      if (req.method === 'POST' && route === '/disable') return send(res, 200, await service.disable(actor));
      if (req.method === 'POST' && route === '/enable') return send(res, 200, await service.enable(actor));
      if (req.method === 'POST' && route === '/packages') return send(res, 201, await service.upload(await body(req, MAX_PACKAGE_BYTES), actor));
      if (req.method === 'POST' && route === '/updates') {
        const value = JSON.parse(await body(req));
        if (value.action === 'check' && Object.keys(value).join() === 'action') return send(res, 200, await service.checkUpdates(actor));
        if (value.action === 'download' && Object.keys(value).sort().join() === 'action,pluginId,version') return send(res, 201, await service.downloadUpdate(value.pluginId, value.version, actor));
        throw new Error('INVALID_REQUEST');
      }
      if (req.method === 'POST' && route === '/plugins') {
        const value = JSON.parse(await body(req));
        if (Object.keys(value).some(key => !['action', 'pluginId', 'packageId'].includes(key))) throw new Error('INVALID_REQUEST');
        return send(res, 200, await service.change(value.action, value.pluginId, value.packageId, actor));
      }
      if (req.method === 'PUT' && route === '/config') {
        const value = JSON.parse(await body(req));
        if (Object.keys(value).sort().join() !== 'pluginId,settings') throw new Error('INVALID_REQUEST');
        const saved = await service.saveConfig(value.pluginId, value.settings, actor);
        return send(res, 200, { ...await service.loadConfig(), audit: saved.audit });
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'REQUEST_FAILED';
      const status = ['BODY_TOO_LARGE', 'PACKAGE_TOO_LARGE'].includes(code) ? 413 : ['STORE_BUSY', 'DATA_UNAVAILABLE'].includes(code) ? 503 : 400;
      return send(res, status, { error: code });
    }
  };
}
