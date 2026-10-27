import { createPluginHub } from '../src/plugin-hub.js';
import { createHttpConfigurationBackend } from '../src/config-store.js';

const gateway = 'http://127.0.0.1:43171';
export default createPluginHub({
  demo: true,
  configurationBackend: () => createHttpConfigurationBackend(window),
  async inventoryProvider() {
    return {
      clusters: [{ id: 'demo-cluster-1', name: 'Demo-Cluster-01' }, { id: 'demo-cluster-2', name: '示例混合厂商集群' }],
      hosts: ['1', '2', '3'].map(number => ({ id: `demo-node-${number}`, name: `Demo-Node-0${number}`, cluster: { id: 'demo-cluster-1', name: 'Demo-Cluster-01' } })),
    };
  },
  resolveDirectUrl: ({ hostId }) => `${gateway}/login?host=${encodeURIComponent(hostId)}`,
  async requestLaunch({ hostId, vendor }) {
    const response = await fetch(`${gateway}/api/launch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId, vendor }), credentials: 'omit',
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('Demo gateway refused the launch');
    const result = await response.json(), url = new URL(result.launchUrl);
    if (url.origin !== gateway || !/^\/launch\/[a-f0-9]{48}$/.test(url.pathname)) throw new Error('Invalid launch URL');
    return url.href;
  },
});
