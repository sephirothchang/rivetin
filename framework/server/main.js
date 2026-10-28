import http from 'node:http';
import { createService } from './service.js';
import { createApi } from './http.js';
import { createTowerConnection } from './tower.js';
import { createTowerAuditSink } from './audit.js';
import { listenPort } from './options.js';
import { createUpdateSource } from './updates.js';
import { createSshTransport } from './ssh-transport.js';
import { createTowerVersionProvider } from './tower-version.js';
import { createTowerDiskReader, createTowerDiskInventoryReader } from './tower-disks.js';
import { createDeploymentProbes } from './deployment-probes.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';

const data = process.env.RIVETIN_DATA, towerUrl = process.env.RIVETIN_TOWER_URL;
const origins = (process.env.RIVETIN_ORIGINS || '').split(',').filter(Boolean);
const port = process.env.RIVETIN_LISTEN_PORT;
if (!data || !towerUrl || !origins.length) throw new Error('EXPLICIT_DEPLOYMENT_CONFIGURATION_REQUIRED');
const tower = createTowerConnection({ baseUrl: towerUrl });
const sshTransport = createSshTransport();
const componentProbes = createDeploymentProbes({ registry: tower.islandRegistry, origins, version: FRAMEWORK_VERSION,
  certificatePin: process.env.RIVETIN_GATEWAY_CERT_SHA256 });
const service = createService(data, { towerSink: createTowerAuditSink({ request: tower.request }), updateSource: createUpdateSource(), sshRun: sshTransport.run, sshPreflightTransport: sshTransport, towerVersionProvider: createTowerVersionProvider({ request: tower.request }), readDisk: createTowerDiskReader({ request: tower.request }), readDiskInventory: createTowerDiskInventoryReader({ request: tower.request }), towerRequest: tower.request, componentProbes });
service.sshChannel.start();
// No saved browser authentication is used by the monitor. Unknown product evidence fails closed.
let checkingCompatibility = false;
async function reconcileCompatibility() {
  if (checkingCompatibility) return;
  checkingCompatibility = true;
  try { await service.reconcileCompatibility(); } catch { console.error('Rivetin compatibility check unavailable'); }
  finally { checkingCompatibility = false; }
}
await reconcileCompatibility();
const compatibilityTimer = setInterval(reconcileCompatibility, 20000); compatibilityTimer.unref();
const handler = createApi(service, { authenticate: tower.authenticate, origins });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
    if (await handler(req, res) === false) { res.writeHead(404); res.end(); }
  } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(listenPort({ RIVETIN_LISTEN_PORT: port }), '0.0.0.0', () => console.log('Rivetin service started'));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(compatibilityTimer);
  const timer = setTimeout(() => process.exit(1), 5000); timer.unref();
  try { await Promise.all([service.sshPreflight.stop(), service.smartBatch.stop(), service.smartCollection.stop(), service.sshChannel.stop(), new Promise(resolve => server.close(resolve))]); clearTimeout(timer); process.exit(0); }
  catch { process.exit(1); }
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
