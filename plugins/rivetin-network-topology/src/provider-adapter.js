import { normalizeClusters, normalizeSnapshot } from './snapshot.js';

export function createTopologySource(provider, now = () => Date.now()) {
  function available() {
    if (typeof provider?.listClusters !== 'function' || typeof provider?.read !== 'function') throw new Error('TOPOLOGY_SOURCE_UNAVAILABLE');
  }
  return {
    async listClusters({ signal }) {
      available(); const value = await provider.listClusters({ signal });
      if (!value || value.schemaVersion !== 1 || value.source !== 'cloudtower' || value.complete !== true || typeof value.observedAt !== 'string' ||
          !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > now() + 5000 || now() - Date.parse(value.observedAt) >= 60000) throw new Error('TOPOLOGY_CLUSTERS_INVALID');
      return normalizeClusters(value.clusters);
    },
    async read({ clusterId, signal }) {
      available(); return normalizeSnapshot(await provider.read({ clusterId, signal }), clusterId, now());
    }
  };
}
