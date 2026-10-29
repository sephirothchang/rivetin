// Injected local fixture only. These are not observed CloudTower resources.
export function workspaceSnapshot(clusterId = 'cluster-fixture', now = Date.now()) {
  return {
    schemaVersion: 1, source: 'cloudtower', revision: 'a'.repeat(64), observedAt: new Date(now).toISOString(), complete: true,
    cluster: { id: clusterId, name: 'Fixture Cluster' }, hosts: [{ id: 'host-fixture', name: 'Fixture Host' }],
    switches: [
      { id: 'vds-management', name: 'Management', purpose: 'management', mtu: 9000, networks: [{ id: 'net-management', name: 'Management network', purpose: 'management', vlan: 10 }] },
      { id: 'vds-workload', name: 'Workload A', purpose: 'workload', mtu: 9000, networks: [{ id: 'net-workload', name: 'Workload network', purpose: 'workload', vlan: 110 }] },
      { id: 'vds-target', name: 'Workload B', purpose: 'workload', mtu: 9000, networks: [] }
    ],
    nics: [{ id: 'nic-fixture', name: 'eth-fixture', hostId: 'host-fixture', switchId: 'vds-workload', peerId: 'peer-fixture', peerPort: 'Ethernet1', link: 'unknown', speedMbps: null, bond: null, bondMode: null }],
    peers: [{ id: 'peer-fixture', name: 'Fixture LLDP peer' }], vmGroups: [{ networkId: 'net-workload', count: 2 }]
  };
}
