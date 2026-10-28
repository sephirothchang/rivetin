import { validId } from '../shared/identity.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const generation = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)).toString();
function live(signal) { if (signal?.aborted) throw Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED', name: 'AbortError' }); }
function collectionResult(value, operationId) {
  if (value?.schemaVersion !== 1 || !uuid(value.operationId) || operationId && value.operationId !== operationId || !['running', 'succeeded', 'failed', 'unknown'].includes(value.status) || value.code !== undefined && !/^(?:SMART|SSH)_[A-Z_]+$/.test(value.code)) fail('SMART_COLLECTION_RESPONSE_INVALID');
  return value;
}

// These adapters expose data contracts, never the caller's authentication material.
export function createDataProviders(api, pluginId) {
  if (typeof api !== 'function' || !validId(pluginId)) fail('INVALID_PLUGIN_ID');
  function identity(value) {
    if (!value || !id(value.diskId) || !id(value.hostId) || !generation(value.generation) || value.deviceId !== value.generation) fail('SMART_IDENTITY_INVALID');
    return { pluginId, diskId: value.diskId, generation: value.generation };
  }
  async function smart(route, values, signal) {
    live(signal);
    const result = await api(`/data/disk-smart/${route}?${query(values)}`, 'GET', undefined, { signal });
    live(signal); return result;
  }
  return {
    diskSmart: Object.freeze({
      async resolveDisk({ diskId, signal } = {}) {
        if (!id(diskId)) fail('SMART_IDENTITY_INVALID');
        const result = await smart('identity', { pluginId, diskId }, signal);
        if (result?.schemaVersion !== 1 || result.identity?.diskId !== diskId) fail('SMART_IDENTITY_INVALID');
        identity(result.identity); return result.identity;
      },
      readLatest({ identity: value, signal } = {}) { return smart('latest', identity(value), signal); },
      async collect({ identity: value, requestId, signal } = {}) {
        live(signal); if (!uuid(requestId)) fail('SMART_COLLECTION_REQUEST_INVALID');
        const result = await api('/data/disk-smart/collect', 'POST', { ...identity(value), requestId }, { signal });
        live(signal); return collectionResult(result);
      },
      async collection({ identity: value, operationId, signal } = {}) {
        if (!uuid(operationId)) fail('SMART_COLLECTION_REQUEST_INVALID');
        return collectionResult(await smart('collection', { ...identity(value), operationId }, signal), operationId);
      },
      readHistory({ identity: value, limit = 30, cursor = null, signal } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 30 || cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096)) fail('SMART_HISTORY_REQUEST_INVALID');
        return smart('history', { ...identity(value), limit, cursor }, signal);
      },
    }),
    resourceActions: Object.freeze({
      async read(resource, { signal } = {}) {
        live(signal);
        if (!resource || !id(resource.id) || !id(resource.type)) fail('RESOURCE_REQUEST_INVALID');
        const result = await api(`/resource-actions/read?${query({ pluginId, type: resource.type, id: resource.id })}`, 'GET', undefined, { signal });
        live(signal); return result;
      },
      async execute({ resource, actionId, values, requestId } = {}, { signal } = {}) {
        live(signal);
        const result = await api('/resource-actions/execute', 'POST', { pluginId, resource, actionId, values, requestId }, { signal });
        live(signal); return result;
      },
      async task(operationId, { signal } = {}) {
        live(signal);
        if (!id(operationId)) fail('RESOURCE_REQUEST_INVALID');
        const result = await api(`/resource-actions/task?${query({ pluginId, operationId })}`, 'GET', undefined, { signal });
        live(signal); return result;
      },
      async openConsole(resource, { signal } = {}) {
        live(signal);
        const result = await api('/resource-actions/console', 'POST', { pluginId, resource }, { signal });
        live(signal); return result;
      },
    }),
  };
}
