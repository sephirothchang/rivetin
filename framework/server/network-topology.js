import { createHash } from 'node:crypto';
import { supportsWorkPages } from '../shared/work-pages.js';
import { TOPOLOGY_LIMITS, topologyId, validateTopologyClusters, validateTopologySnapshot } from '../shared/network-topology.js';

const plugin = 'rivetin-network-topology';
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { status }); };
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const relation = value => typeof value === 'object' && value !== null && topologyId(value.id) ? value.id : null;
const sort = rows => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const purpose = row => row.internal === true ? 'system' : ({ VM: 'workload', MIGRATION: 'migration', MANAGEMENT: 'management', STORAGE: 'storage', STORAGE_ACCESS: 'storage' })[row.type] || null;

export function createNetworkTopology({ request, pluginStatus, towerBuildProvider } = {}) {
  if (typeof request !== 'function' || typeof pluginStatus !== 'function' || typeof towerBuildProvider !== 'function') throw new Error('TOPOLOGY_PROVIDER_INVALID');
  async function gate(pluginId, actor) {
    if (pluginId !== plugin || actor?.admin !== true || actor.source !== 'tower' || !actor.auth || !['Authorization', 'Cookie'].some(key => typeof actor.auth[key] === 'string' && actor.auth[key])) fail('TOPOLOGY_PERMISSION_REQUIRED', 403);
    const status = await pluginStatus(pluginId, actor);
    if (status?.frameworkEnabled !== true || status.installed !== true || status.enabled !== true || status.compatible !== true || !status.manifest?.permissions?.includes('inventory.read') || !supportsWorkPages(status.manifest)) fail('TOPOLOGY_PLUGIN_UNAVAILABLE', 403);
    if (await towerBuildProvider() !== '4.9.0') fail('TOPOLOGY_TOWER_UNSUPPORTED');
  }
  async function readScope(input, action) {
    if (input.signal?.aborted) fail('TOPOLOGY_READ_CANCELLED');
    await gate(input.pluginId, input.actor);
    const abort = new AbortController(), end = Date.now() + 6000, timer = setTimeout(() => abort.abort(), 6000);
    const cancel = () => abort.abort(); input.signal?.addEventListener('abort', cancel, { once: true }); if (input.signal?.aborted) abort.abort();
    let calls = 0;
    function live() { if (abort.signal.aborted || Date.now() >= end) fail('TOPOLOGY_READ_CANCELLED'); }
    async function list(route, where, limit) {
      const values = [], ids = new Set();
      while (true) {
        live(); if (++calls > 32) fail('TOPOLOGY_READ_LIMIT');
        const first = Math.min(100, limit + 1 - values.length);
        let page;
        try { page = await request('/v2/api/' + route, { first, skip: values.length, orderBy: 'id_ASC', ...(where ? { where } : {}) }, input.actor, { signal: abort.signal, timeoutMs: Math.max(1, Math.min(4000, end - Date.now())) }); }
        catch (error) { fail([401, 403].includes(error?.status) ? 'TOPOLOGY_PERMISSION_DENIED' : 'TOPOLOGY_READ_FAILED', [401, 403].includes(error?.status) ? 403 : 503); }
        live(); if (!Array.isArray(page) || page.length > first) fail('TOPOLOGY_SOURCE_INVALID');
        for (const row of page) {
          if (!topologyId(row?.id) || !label(row.name) || ids.has(row.id)) fail('TOPOLOGY_SOURCE_INVALID');
          ids.add(row.id); values.push(row); if (values.length > limit) fail('TOPOLOGY_RESOURCE_LIMIT');
        }
        if (page.length < first) return values;
      }
    }
    try { const result = await action(list, live); live(); await gate(input.pluginId, input.actor); live(); return result; }
    finally { abort.abort(); clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); }
  }
  return {
    listClusters(input = {}) {
      return readScope(input, async list => {
        const rows = await list('get-clusters', null, TOPOLOGY_LIMITS.clusters);
        return validateTopologyClusters({ schemaVersion: 1, source: 'cloudtower', observedAt: new Date().toISOString(), complete: true, clusters: sort(rows.map(({ id, name }) => ({ id, name }))) });
      });
    },
    read(input = {}) {
      if (!topologyId(input.clusterId)) fail('TOPOLOGY_CLUSTER_INVALID', 400);
      return readScope(input, async list => {
        const clusters = await list('get-clusters', { id: input.clusterId }, 1);
        if (clusters.length !== 1 || clusters[0].id !== input.clusterId) fail('TOPOLOGY_CLUSTER_UNAVAILABLE', 404);
        const [hosts, switches, networks, nics] = await Promise.all([
          list('get-hosts', { cluster: { id: input.clusterId } }, TOPOLOGY_LIMITS.hosts),
          list('get-vdses', { cluster: { id: input.clusterId } }, TOPOLOGY_LIMITS.switches),
          list('get-vlans', { vds: { cluster: { id: input.clusterId } } }, TOPOLOGY_LIMITS.networks),
          list('get-nics', { host: { cluster: { id: input.clusterId } } }, TOPOLOGY_LIMITS.nics),
        ]);
        const hostIds = new Set(hosts.map(row => row.id)), switchIds = new Set(switches.map(row => row.id));
        if ([...hosts, ...switches].some(row => relation(row.cluster) !== input.clusterId) || networks.some(row => !switchIds.has(relation(row.vds))) || nics.some(row => !hostIds.has(relation(row.host)) || typeof row.physical !== 'boolean')) fail('TOPOLOGY_RELATIONSHIP_INVALID');
        const membership = new Map();
        for (const sw of switches) {
          if (sw.nics !== undefined && sw.nics !== null && !Array.isArray(sw.nics)) fail('TOPOLOGY_SOURCE_INVALID');
          for (const nic of sw.nics || []) {
            if (!topologyId(nic?.id) || membership.has(nic.id) && membership.get(nic.id) !== sw.id || !nics.some(row => row.id === nic.id)) fail('TOPOLOGY_RELATIONSHIP_INVALID'); membership.set(nic.id, sw.id);
          }
        }
        let complete = [...hosts, ...switches, ...networks, ...nics].every(row => row.entityAsyncStatus == null);
        const normalized = { cluster: { id: clusters[0].id, name: clusters[0].name }, hosts: sort(hosts.map(({ id, name }) => ({ id, name }))),
          switches: sort(switches.map(row => {
            const items = networks.filter(net => relation(net.vds) === row.id);
            if (Number.isSafeInteger(row.vlans_num) && row.vlans_num !== items.length) complete = false;
            return { id: row.id, name: row.name, mtu: null, purpose: row.internal === true ? 'system' : row.internal === false ? purpose(row) : null, networks: sort(items.map(net => {
              if (net.vlan_id != null && (!Number.isInteger(net.vlan_id) || net.vlan_id < 0 || net.vlan_id > 4094)) fail('TOPOLOGY_SOURCE_INVALID');
              return { id: net.id, name: net.name, vlan: net.vlan_id ?? null, purpose: purpose(net) };
            })) };
          })),
          nics: sort(nics.filter(row => row.physical).map(row => {
            const direct = row.vds == null ? null : relation(row.vds), attached = membership.get(row.id) || null;
            if (row.vds != null && !direct || direct && (!switchIds.has(direct) || attached && attached !== direct)) fail('TOPOLOGY_RELATIONSHIP_INVALID');
            // Unit, bond membership, active port and LLDP are not established by
            // the source contract. Never infer them from names or shared VDSs.
            return { id: row.id, name: row.name, hostId: row.host.id, switchId: direct || attached, link: 'unknown', speedMbps: null, bond: null, bondMode: null, peerId: null, peerPort: null };
          })), vmGroups: [], peers: [] };
        const revision = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        return validateTopologySnapshot({ schemaVersion: 1, source: 'cloudtower', observedAt: new Date().toISOString(), complete, revision, ...normalized }, input.clusterId);
      });
    },
  };
}
