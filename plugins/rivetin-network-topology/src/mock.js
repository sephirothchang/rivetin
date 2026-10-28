// Synthetic identities and documentation-only addresses; no live inventory is embedded.
export function createMockTopology() {
  const hosts = ['host-a', 'host-b', 'host-c'].map((id, index) => ({
    id, name: `Demo-Node-0${index + 1}`, address: `192.0.2.${21 + index}`
  }));
  return {
    revision: 1, complete: true,
    switches: [
      { id: 'system', name: 'VDS-Management', bridge: 'ovsbr-management', roles: ['management'], mtu: 9000, vlans: [10],
        networks: [{ id: 'net-management', name: 'management-network', role: 'management', vlan: 10 }, { id: 'net-default', name: 'default', role: 'workload', vlan: 10 }] },
      { id: 'storage', name: 'VDS-Storage', bridge: 'ovsbr-storage', roles: ['storage'], mtu: 9000, vlans: [20],
        networks: [{ id: 'net-storage', name: 'storage-network', role: 'storage', vlan: 20 }] },
      { id: 'internal', name: 'vds-local-internal', bridge: 'ovsbr-internal', roles: ['workload'], mtu: 1500, vlans: [1], uplinkEditable: false,
        networks: [{ id: 'net-internal', name: 'internal-default-network', role: 'workload', vlan: 1 }] },
      { id: 'migration', name: 'VDS-Migration', bridge: 'ovsbr-migration', roles: ['migration'], mtu: 1500, vlans: [210],
        networks: [{ id: 'net-migration', name: 'migration-network', role: 'migration', vlan: 210 }] },
      { id: 'workload', name: 'VDS-Workload', bridge: 'ovsbr-workload', roles: ['workload'], mtu: 9000, vlans: [110, 120],
        networks: [{ id: 'net-production', name: 'production-network', role: 'workload', vlan: 110 }] }
    ], hosts,
    vmGroups: [{ networkId: 'net-default', name: 'default', count: 1 }, { networkId: 'net-production', name: 'production-network', count: 4 }],
    peers: [{ id: 'peer-a', name: 'Demo-Leaf-A', address: '198.51.100.11' }, { id: 'peer-b', name: 'Demo-Leaf-B', address: '198.51.100.12' }],
    nics: hosts.flatMap((host, hostIndex) => Array.from({ length: 10 }, (_, index) => ({
      id: `${host.id}-eth${index}`, hostId: host.id, name: `eth${index}`,
      switchId: index < 2 ? 'system' : index < 4 ? 'storage' : index < 6 ? 'workload' : index < 8 ? 'migration' : null,
      speed: index < 2 ? 10 : index < 6 ? 25 : 10, fabric: index % 2 ? 'B' : 'A',
      mtu: index === 9 ? 1500 : 9000, vlans: index < 2 ? [10] : index < 4 ? [20] : [110, 120, 210], link: 'up',
      peerId: index % 2 ? 'peer-b' : 'peer-a', peerPort: `Ethernet${hostIndex * 5 + Math.floor(index / 2) + 1}`
    })))
  };
}
