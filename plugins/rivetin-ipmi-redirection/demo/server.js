import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoGateway } from './gateway.js';
import { createService } from '../../../framework/server/service.js';
import { createApi } from '../../../framework/server/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.map': 'application/json' };
const gateway = createDemoGateway();
const profile = process.env.RIVETIN_DEMO_PROFILE || 'rivetin';
if (!/^[a-z0-9-]{1,60}$/.test(profile)) throw new Error('INVALID_DEMO_PROFILE');
const service = createService(path.join(root, '.runtime', profile), { towerBuild: '4.9.0' });
const demoActor = { id: 'demo-admin', name: 'Demo administrator', source: 'demo', admin: true };
const initialized = await service.initialize(demoActor);
if (initialized.created) {
  const uploaded = await service.upload(await readFile(path.join(root, `release/${pluginPackage.name}-${pluginPackage.version}.rivetin.json`)), demoActor);
  await service.change('install', uploaded.manifest.id, uploaded.packageId, demoActor);
  await service.change('enable', uploaded.manifest.id, null, demoActor); await service.enable(demoActor);
}
const api = createApi(service, { origins: ['http://127.0.0.1:43170', 'http://localhost:43170'], authenticate: async () => demoActor });
const gatewayServer = http.createServer((req, res) => gateway.handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Local demo failed'); }));
const towerServer = http.createServer(async (req, res) => {
  if (new URL(req.url, 'http://127.0.0.1:43170').pathname.startsWith('/api/rivetin/v1/')) { await api(req, res); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const pathname = new URL(req.url, 'http://127.0.0.1:43170').pathname;
  let file;
  if (pathname === '/') file = path.join(root, 'demo/index.html');
  else if (pathname === '/demo.css') file = path.join(root, 'demo/demo.css');
  else if (pathname.startsWith('/framework/')) {
    const output = path.resolve(root, '../../framework/dist/demo');
    try { file = path.resolve(output, decodeURIComponent(pathname.slice('/framework/'.length))); }
    catch { res.writeHead(400); return res.end(); }
    if (!file.startsWith(output + path.sep)) { res.writeHead(403); return res.end(); }
  }
  else if (pathname.startsWith('/island/') || pathname.startsWith('/host/')) {
    const output = path.join(root, 'dist/demo');
    try { file = path.resolve(output, `.${decodeURIComponent(pathname)}`); }
    catch { res.writeHead(400); return res.end(); }
    if (!file.startsWith(output + path.sep)) { res.writeHead(403); return res.end(); }
  }
  if (!file) { res.writeHead(404); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Run npm run build first.'); }
});
gatewayServer.listen(43171, '127.0.0.1', () => console.log('Mock BMC gateway: http://127.0.0.1:43171 (local-only, fake credentials)'));
towerServer.listen(43170, '127.0.0.1', () => console.log('Tower prototype: http://127.0.0.1:43170 (local-only, no production connections)'));
for (const server of [towerServer, gatewayServer]) server.on('error', error => { console.error(`Local listener failed: ${error.code}`); process.exitCode = 1; towerServer.close(); gatewayServer.close(); gateway.dispose(); });
function shutdown() { towerServer.close(); gatewayServer.close(); gateway.dispose(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
