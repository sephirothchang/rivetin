export const TOPOLOGY_LIMITS = Object.freeze({ clusters: 200, hosts: 128, switches: 128, networks: 512, nics: 1024, vmGroups: 512, peers: 256 });
const fail = () => { throw new Error('TOPOLOGY_RESPONSE_INVALID'); };
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(' ').sort().join()) fail(); };
export const topologyId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const array = (value, limit) => Array.isArray(value) && value.length <= limit;
const optional = value => value === null || text(value);
const integer = (value, max) => value === null || Number.isSafeInteger(value) && value >= 0 && value <= max;
const time = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 5000;
function unique(values) { if (new Set(values).size !== values.length) fail(); }
export function validateTopologyClusters(value) {
  exact(value, 'schemaVersion source complete observedAt clusters');
  if (value?.schemaVersion !== 1 || value.source !== 'cloudtower' || value.complete !== true || !time(value.observedAt) || !array(value.clusters, TOPOLOGY_LIMITS.clusters) || value.clusters.some(row => !topologyId(row?.id) || !text(row.name))) fail();
  for (const row of value.clusters) exact(row, 'id name');
  unique(value.clusters.map(row => row.id)); return structuredClone(value);
}
export function validateTopologySnapshot(value, clusterId) {
  exact(value, 'schemaVersion source cluster revision observedAt complete hosts switches nics vmGroups peers'); exact(value.cluster, 'id name');
  if (!topologyId(clusterId) || value?.schemaVersion !== 1 || value.source !== 'cloudtower' || value.cluster?.id !== clusterId || !text(value.cluster.name) || !/^[a-f0-9]{64}$/.test(value.revision || '') || !time(value.observedAt) || typeof value.complete !== 'boolean') fail();
  for (const key of ['hosts', 'switches', 'nics', 'vmGroups', 'peers']) if (!array(value[key], TOPOLOGY_LIMITS[key])) fail();
  if ([...value.hosts, ...value.peers].some(row => !topologyId(row?.id) || !text(row.name))) fail();
  for (const row of [...value.hosts, ...value.peers]) exact(row, 'id name');
  const networks = [];
  for (const row of value.switches) {
    exact(row, 'id name mtu purpose networks');
    if (!topologyId(row?.id) || !text(row.name) || !integer(row.mtu, 65535) || !optional(row.purpose) || !array(row.networks, TOPOLOGY_LIMITS.networks)) fail();
    for (const net of row.networks) { exact(net, 'id name vlan purpose'); if (!topologyId(net?.id) || !text(net.name) || !integer(net.vlan, 4094) || !optional(net.purpose)) fail(); networks.push(net); }
  }
  if (networks.length > TOPOLOGY_LIMITS.networks) fail();
  const hosts = new Set(value.hosts.map(row => row.id)), switches = new Set(value.switches.map(row => row.id)), peers = new Set(value.peers.map(row => row.id)), nets = new Set(networks.map(row => row.id));
  for (const row of value.nics) if (!topologyId(row?.id) || !text(row.name) || !hosts.has(row.hostId) || row.switchId !== null && !switches.has(row.switchId) || !['up', 'down', 'unknown'].includes(row.link) || !integer(row.speedMbps, 10000000) || !optional(row.bond) || !optional(row.bondMode) || row.peerId !== null && !peers.has(row.peerId) || !optional(row.peerPort)) fail();
  for (const row of value.nics) exact(row, 'id name hostId switchId link speedMbps bond bondMode peerId peerPort');
  for (const row of value.vmGroups) { exact(row, 'networkId count'); if (!nets.has(row?.networkId) || !integer(row.count, 1000000)) fail(); }
  for (const list of [value.hosts, value.switches, value.nics, value.peers, networks]) unique(list.map(row => row.id));
  unique(value.vmGroups.map(row => row.networkId)); return structuredClone(value);
}
