import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = new Map([
  ['/', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/demo.css', ['demo/demo.css', 'text/css; charset=utf-8']],
  ['/demo.js', ['dist/demo/demo.js', 'text/javascript; charset=utf-8']],
]);
const server = http.createServer(async (request, response) => {
  if (!['127.0.0.1:43184', 'localhost:43184'].includes(request.headers.host)) { response.writeHead(403); response.end(); return; }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  const route = routes.get(new URL(request.url, 'http://127.0.0.1:43184').pathname);
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    const data = await readFile(path.join(root, route[0]));
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404); response.end('Build the local demo first.'); }
});
server.listen(43184, '127.0.0.1', () => console.log('SSH channel mock demo: http://127.0.0.1:43184 (no host or Tower connections)'));
server.on('error', error => { console.error(`Local listener failed: ${error.code}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
