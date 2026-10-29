// Plugin-local validation of the framework 0.2.5 read-only resource DTO.
export const SNAPSHOT_LIMITS = Object.freeze({ clusters: 200, hosts: 128, switches: 128, networks: 512, nics: 1024, vmGroups: 512, peers: 256 });
const invalid = () => { throw new Error('TOPOLOGY_SNAPSHOT_INVALID'); };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; };
const text = (value, max = 256) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(); return value; };
const optionalText = value => value === null || value === undefined ? null : text(value);
const number = (value, max) => { if (value === null || value === undefined) return null; if (!Number.isInteger(value) || value < 0 || value > max) invalid(); return value; };
const rows = (value, limit) => { if (!Array.isArray(value) || value.length > limit) invalid(); return value; };
function unique(items) {
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return items;
}
function timestamp(value) {
  text(value, 64);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
export function normalizeClusters(value) {
  return unique(rows(value, SNAPSHOT_LIMITS.clusters).map(item => {
    object(item); return { id: text(item.id), name: text(item.name) };
  }));
}
export function normalizeSnapshot(input, clusterId, now = Date.now()) {
  object(input);
  if (input.schemaVersion !== 1 || input.source !== 'cloudtower' || typeof input.complete !== 'boolean') invalid();
  const cluster = object(input.cluster);
  if (text(cluster.id) !== clusterId) invalid();
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) invalid();
  const observedAt = timestamp(input.observedAt);
  if (Date.parse(observedAt) > now + 5000) invalid();
  const hosts = unique(rows(input.hosts, SNAPSHOT_LIMITS.hosts).map(item => {
    object(item); return { id: text(item.id), name: text(item.name) };
  }));
  let networkCount = 0;
  const switches = unique(rows(input.switches, SNAPSHOT_LIMITS.switches).map(item => {
    object(item);
    const networks = rows(item.networks, SNAPSHOT_LIMITS.networks).map(net => {
      object(net); networkCount++;
      return { id: text(net.id), name: text(net.name), vlan: number(net.vlan, 4094), purpose: optionalText(net.purpose) };
    });
    if (networkCount > SNAPSHOT_LIMITS.networks) invalid();
    return { id: text(item.id), name: text(item.name), mtu: number(item.mtu, 65535), purpose: optionalText(item.purpose), networks };
  }));
  const networkIds = switches.flatMap(item => item.networks.map(net => net.id));
  if (new Set(networkIds).size !== networkIds.length) invalid();
  const hostIds = new Set(hosts.map(item => item.id)), switchIds = new Set(switches.map(item => item.id));
  const peers = unique(rows(input.peers, SNAPSHOT_LIMITS.peers).map(item => {
    object(item); return { id: text(item.id), name: text(item.name) };
  }));
  const peerIds = new Set(peers.map(item => item.id));
  const nics = unique(rows(input.nics, SNAPSHOT_LIMITS.nics).map(item => {
    object(item);
    if (!hostIds.has(item.hostId) || item.switchId !== null && !switchIds.has(item.switchId) || item.peerId !== null && !peerIds.has(item.peerId)) invalid();
    if (!['up', 'down', 'unknown'].includes(item.link)) invalid();
    return { id: text(item.id), name: text(item.name), hostId: item.hostId, switchId: item.switchId,
      peerId: item.peerId, peerPort: optionalText(item.peerPort), link: item.link, speedMbps: number(item.speedMbps, 10000000),
      bond: optionalText(item.bond), bondMode: optionalText(item.bondMode) };
  }));
  const vmGroups = rows(input.vmGroups, SNAPSHOT_LIMITS.vmGroups).map(item => {
    object(item); if (!networkIds.includes(item.networkId)) invalid();
    return { networkId: item.networkId, count: number(item.count, 1000000) };
  });
  if (new Set(vmGroups.map(item => item.networkId)).size !== vmGroups.length) invalid();
  return { schemaVersion: 1, source: 'cloudtower', revision: text(input.revision, 512), observedAt,
    complete: input.complete, cluster: { id: clusterId, name: text(cluster.name) }, hosts, switches, peers, nics, vmGroups };
}
export function snapshotIsStale(snapshot, now = Date.now()) {
  return now - Date.parse(snapshot.observedAt) >= 60000;
}
