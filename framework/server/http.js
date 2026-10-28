import { MAX_PACKAGE_BYTES } from './manifest.js';

export const PREFIX = '/api/rivetin/v1';
export function createApi(service, { authenticate, origins = [] } = {}) {
  if (typeof authenticate !== 'function') throw new Error('AUTHENTICATOR_REQUIRED');
  const allowed = new Set(origins);
  async function body(req, max = 1024 * 1024) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('CONTENT_TYPE_REQUIRED');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(PREFIX + '/')) return false;
    const route = url.pathname.slice(PREFIX.length);
    const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
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
        const parameters = names => {
          const keys = [...url.searchParams.keys()];
          if (keys.some(key => !names.includes(key)) || new Set(keys).size !== keys.length || [...url.searchParams.values()].some(value => value.length > 4096)) throw new Error('INVALID_REQUEST');
          return Object.fromEntries(url.searchParams);
        };
        if (route === '/components/status') {
          const values = parameters(['fresh']);
          if (values.fresh !== undefined && values.fresh !== 'true') throw new Error('INVALID_REQUEST');
          return send(res, 200, await service.components.status(actor, { fresh: values.fresh === 'true' }));
        }
        if (route === '/components/support') { parameters([]); return send(res, 200, await service.components.support(actor)); }
        if (route.startsWith('/data/disk-smart/')) {
          const operation = route.slice('/data/disk-smart/'.length);
          if (operation === 'inventory') {
            const values = parameters(['pluginId', 'diskId']);
            if (Object.keys(values).sort().join() !== 'diskId,pluginId') throw new Error('INVALID_REQUEST');
            return send(res, 200, await service.smartData.readInventory({ ...values, actor }));
          }
          if (operation === 'collection-all') {
            const values = parameters(['pluginId', 'operationId']);
            if (Object.keys(values).sort().join() !== 'operationId,pluginId') throw new Error('INVALID_REQUEST');
            return send(res, 200, await service.smartData.collectionAll({ ...values, actor }));
          }
          if (!['identity', 'latest', 'history', 'collection'].includes(operation)) return send(res, 404, { error: 'NOT_FOUND' });
          const values = parameters(operation === 'identity' ? ['pluginId', 'diskId'] : operation === 'latest' ? ['pluginId', 'diskId', 'generation'] : operation === 'collection' ? ['pluginId', 'diskId', 'generation', 'operationId'] : ['pluginId', 'diskId', 'generation', 'limit', 'cursor']);
          if (Object.hasOwn(values, 'limit')) { if (!/^[1-9][0-9]?$/.test(values.limit)) throw new Error('INVALID_REQUEST'); values.limit = Number(values.limit); }
          const input = { ...values, actor };
          if (operation === 'identity') return send(res, 200, { schemaVersion: 1, identity: await service.smartData.resolveDisk(input) });
          if (operation === 'collection') return send(res, 200, await service.smartData.collection(input));
          return send(res, 200, await service.smartData[operation === 'latest' ? 'readLatest' : 'readHistory'](input));
        }
        if (route === '/inventory/disk-bindings') return send(res, 200, await service.smartData.bindings(actor));
        if (route === '/ssh-channel/connections') return send(res, 200, await service.sshConnections(actor));
        if (route === '/ssh-channel/inventory') return send(res, 200, await service.sshInventory(actor));
        if (route === '/resource-actions/read') {
          const { pluginId, type, id } = parameters(['pluginId', 'type', 'id']);
          return send(res, 200, await service.resourceActions.read({ pluginId, resource: { type, id }, actor }));
        }
        if (route === '/resource-actions/task') {
          const { pluginId, operationId } = parameters(['pluginId', 'operationId']);
          return send(res, 200, await service.resourceActions.task({ pluginId, operationId, actor }));
        }
        if (route === '/marketplace') {
          if (!actor.admin) return send(res, 403, { error: 'ADMIN_REQUIRED' });
          return send(res, 200, await service.marketplace(actor));
        }
        if (route === '/updates/status') {
          if (!actor.admin) return send(res, 403, { error: 'ADMIN_REQUIRED' });
          return send(res, 200, await service.updateStatus(actor));
        }
        if (route === '/ssh-channel' || route === '/ssh-channel/results') {
          if (!actor.admin) return send(res, 403, { error: 'ADMIN_REQUIRED' });
          return send(res, 200, route === '/ssh-channel' ? await service.sshChannel.status(actor) : await service.sshChannel.results(url.searchParams.get('pluginId'), actor));
        }
        if (route === '/runtime') return send(res, 200, await service.runtime());
        if (route === '/plugins') return send(res, 200, { items: await service.plugins(actor), packages: actor.admin ? await service.packages() : [] });
        if (route === '/config') return send(res, 200, await service.loadConfig());
        if (route === '/logs') {
          if (!actor.admin) return send(res, 403, { error: 'ADMIN_REQUIRED' });
          return send(res, 200, await service.logs({ pluginId: url.searchParams.get('pluginId'), limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
        }
      }
      if (req.method === 'POST' && ['/components/repair', '/components/reset'].includes(route)) {
        return send(res, 200, await service.components.maintain(route.split('/').at(-1), JSON.parse(await body(req, 4096)), actor));
      }
      if (req.method === 'POST' && route === '/disable') return send(res, 200, await service.disable(actor));
      if (req.method === 'POST' && route === '/ssh-channel/preflight') {
        const value = JSON.parse(await body(req, 4096));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
        const { action, ...input } = value;
        const fields = Object.keys(value).sort().join();
        if (action === 'discover' && fields === 'action,address,hostId,port') return send(res, 200, await service.sshPreflight.discover({ ...input, actor }));
        if (action === 'confirm' && fields === 'acknowledged,action,address,challenge,hostId,port') return send(res, 200, await service.sshPreflight.confirm({ ...input, actor }));
        if (action === 'verify' && fields === 'action,hostId') return send(res, 200, await service.sshPreflight.verify({ ...input, actor }));
        throw new Error('INVALID_REQUEST');
      }
      if (req.method === 'POST' && route === '/data/disk-smart/collect-all') {
        const value = JSON.parse(await body(req, 4096));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'pluginId,requestId') throw new Error('INVALID_REQUEST');
        const result = await service.smartData.collectAll({ ...value, actor });
        return send(res, result.status === 'running' ? 202 : 200, result);
      }
      if (req.method === 'POST' && route === '/data/disk-smart/collect') {
        const value = JSON.parse(await body(req, 8192));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'diskId,generation,pluginId,requestId') throw new Error('INVALID_REQUEST');
        const result = await service.smartData.collect({ ...value, actor });
        return send(res, result.status === 'running' ? 202 : 200, result);
      }
      if (req.method === 'PUT' && route === '/ssh-channel/connections') {
        const { audit, ...summary } = await service.sshSaveConnections(JSON.parse(await body(req, 1024 * 1024)), actor);
        return send(res, 200, summary);
      }
      if (req.method === 'POST' && route === '/inventory/disk-bindings') {
        const value = JSON.parse(await body(req, 8192));
        if (value?.action === 'bind' && Object.keys(value).sort().join() === 'action,deviceId,diskId,profileHostId') {
          const { action, ...input } = value; return send(res, 200, await service.smartBind(input, actor));
        }
        if (value?.action === 'unbind' && Object.keys(value).sort().join() === 'action,diskId') return send(res, 200, await service.smartUnbind(value.diskId, actor));
        throw new Error('INVALID_REQUEST');
      }
      if (req.method === 'POST' && route === '/resource-actions/execute') {
        const value = JSON.parse(await body(req, 16384));
        if (!value || Object.keys(value).sort().join() !== 'actionId,pluginId,requestId,resource,values') throw new Error('INVALID_REQUEST');
        return send(res, 200, await service.resourceActions.execute({ ...value, actor }));
      }
      if (req.method === 'POST' && route === '/resource-actions/console') {
        const value = JSON.parse(await body(req, 4096));
        if (!value || Object.keys(value).sort().join() !== 'pluginId,resource') throw new Error('INVALID_REQUEST');
        return send(res, 200, await service.resourceActions.openConsole({ ...value, actor }));
      }
      if (req.method === 'POST' && route === '/enable') return send(res, 200, await service.enable(actor));
      if (req.method === 'POST' && route === '/packages') return send(res, 201, await service.upload(await body(req, MAX_PACKAGE_BYTES), actor));
      if (req.method === 'POST' && route === '/ssh-channel') {
        const value = JSON.parse(await body(req, 65536));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
        if (value.action === 'review' && Object.keys(value).sort().join() === 'action,pluginId') return send(res, 200, await service.sshChannel.review(value.pluginId, actor));
        if (value.action === 'revoke' && Object.keys(value).sort().join() === 'action,pluginId') return send(res, 200, await service.sshChannel.revoke(value.pluginId, actor));
        if (value.action === 'approve' && Object.keys(value).sort().join() === 'acknowledged,action,challenge,digest,pluginId') {
          const { action, ...approval } = value;
          return send(res, 200, await service.sshChannel.approve(approval, actor));
        }
        throw new Error('INVALID_REQUEST');
      }
      if (req.method === 'POST' && route === '/ssh-channel/hosts') {
        const value = JSON.parse(await body(req, 65536));
        if (value?.action === 'put' && Object.keys(value).sort().join() === 'action,profile') return send(res, 200, await service.sshSaveHost(value.profile, actor));
        if (value?.action === 'remove' && Object.keys(value).sort().join() === 'action,hostId') return send(res, 200, await service.sshRemoveHost(value.hostId, actor));
        throw new Error('INVALID_REQUEST');
      }
      if (req.method === 'POST' && route === '/updates') {
        const value = JSON.parse(await body(req));
        if (value.action === 'check' && Object.keys(value).join() === 'action') return send(res, 200, await service.checkUpdates(actor));
        if (value.action === 'download' && Object.keys(value).sort().join() === 'action,pluginId,version') return send(res, 201, await service.downloadUpdate(value.pluginId, value.version, actor));
        throw new Error('INVALID_REQUEST');
      }
      if (req.method === 'POST' && route === '/marketplace') {
        const value = JSON.parse(await body(req, 65536));
        if (!value || Object.keys(value).sort().join() !== 'action,pluginId,version' || value.action !== 'install') throw new Error('INVALID_REQUEST');
        return send(res, 200, await service.installFromMarket(value.pluginId, value.version, actor));
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
      const code = /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message) ? error.message : 'REQUEST_FAILED';
      const status = [401, 403, 404, 409, 429, 503, 504].includes(error.status) ? error.status : ['BODY_TOO_LARGE', 'PACKAGE_TOO_LARGE'].includes(code) ? 413 : ['STORE_BUSY', 'DATA_UNAVAILABLE'].includes(code) ? 503 : 400;
      return send(res, status, { error: code });
    }
  };
}
