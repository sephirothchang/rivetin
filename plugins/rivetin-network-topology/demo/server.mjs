import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = new Map([
  ['/', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/demo.css', ['demo/demo.css', 'text/css; charset=utf-8']],
  ['/demo.js', ['dist/demo/demo.js', 'text/javascript; charset=utf-8']],
  ['/LICENSE', ['LICENSE', 'text/plain; charset=utf-8']]
]);
const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  if (request.headers.host !== '127.0.0.1:43182') { response.writeHead(403); response.end(); return; }
  const route = routes.get(new URL(request.url, 'http://127.0.0.1:43182').pathname);
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(path.join(root, route[0]));
    response.writeHead(200, {
      'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end('Run npm run build first.'); }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
server.listen(43182, '127.0.0.1', () => console.log('Network topology demo: http://127.0.0.1:43182 (local mock only; no live API)'));
server.on('error', error => { console.error(`Local demo listener failed: ${error.code}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
