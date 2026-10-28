export const sampleInventory = [
  { id: 'vm-web', name: 'demo-web', clusterId: 'demo-cluster', ips: ['192.0.2.10'], labels: [{ key: 'application', value: 'web' }] },
  { id: 'vm-db', name: 'demo-db', clusterId: 'demo-cluster', ips: ['192.0.2.20'], labels: [{ key: 'application', value: 'database' }] },
  { id: 'vm-web-2', name: 'demo-web-2', clusterId: 'demo-cluster', ips: ['192.0.2.11'], labels: [{ key: 'application', value: 'web' }] }
];
export const sampleTraffic = 'src_ip,dst_ip,dst_port,protocol\n192.0.2.10,192.0.2.20,5432,TCP\n198.51.100.5,192.0.2.10,443,TCP\n192.0.2.10,203.0.113.53,53,UDP\n192.0.2.10,192.0.2.20,5432,TCP\n';
export const sampleExternal = '198.51.100.5\n203.0.113.53';
