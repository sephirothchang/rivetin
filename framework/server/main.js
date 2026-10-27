import http from 'node:http';
import { createService } from './service.js';
import { createApi } from './http.js';
import { createTowerConnection } from './tower.js';
import { createTowerAuditSink } from './audit.js';
import { listenPort } from './options.js';
import { createUpdateSource } from './updates.js';
const data = process.env.PLUGINKIT_DATA, towerUrl = process.env.PLUGINKIT_TOWER_URL;
const origins = (process.env.PLUGINKIT_ORIGINS || '').split(',').filter(Boolean);
if (!data || !towerUrl || !origins.length) throw new Error('EXPLICIT_DEPLOYMENT_CONFIGURATION_REQUIRED');
const tower = createTowerConnection({ baseUrl: towerUrl });
const service = createService(data, { towerSink: createTowerAuditSink({ request: tower.request }), updateSource: createUpdateSource({ token: process.env.PLUGINKIT_GITHUB_TOKEN || '' }) });
const handler = createApi(service, { authenticate: tower.authenticate, origins });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
    if (await handler(req, res) === false) { res.writeHead(404); res.end(); }
  } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(listenPort(process.env), '0.0.0.0', () => console.log('PluginKit service started'));
function stop() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
