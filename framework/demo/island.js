import { createFrameworkHub } from '../src/hub.js';
const gateway = 'http://127.0.0.1:43171';
export default createFrameworkHub({
  demo: true,
  async inventoryProvider() {
    return { clusters: [{ id: 'demo-cluster-1', name: 'Demo-Cluster-01' }, { id: 'demo-cluster-2', name: 'Demo mixed-vendor cluster' }],
      hosts: ['1', '2', '3'].map(number => ({ id: `demo-node-${number}`, name: `Demo-Node-0${number}`, cluster: { id: 'demo-cluster-1' } })) };
  },
  resolveDirectUrl: ({ hostId }) => `${gateway}/login?host=${encodeURIComponent(hostId)}`,
  async requestLaunch({ hostId, vendor }) {
    const response = await fetch(`${gateway}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId, vendor }), credentials: 'omit', signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('DEMO_LAUNCH_FAILED');
    const result = await response.json(), url = new URL(result.launchUrl);
    if (url.origin !== gateway || !/^\/launch\/[a-f0-9]{48}$/.test(url.pathname)) throw new Error('INVALID_LAUNCH');
    return url.href;
  },
});
