import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:43185';
const routes = new Map([
  ['/', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/demo.css', ['demo/demo.css', 'text/css; charset=utf-8']],
  ['/demo.js', ['dist/demo/demo.js', 'text/javascript; charset=utf-8']],
  ['/LICENSE', ['LICENSE', 'text/plain; charset=utf-8']]
]);
const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  if (request.headers.host !== '127.0.0.1:43185') { response.writeHead(403); response.end(); return; }
  const route = routes.get(new URL(request.url, origin).pathname);
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(path.join(root, route[0]));
    response.writeHead(200, {
      'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end('Run npm run build first.'); }
});
server.requestTimeout = 10000; server.headersTimeout = 10000;
server.listen(43185, '127.0.0.1', () => console.log(`Offline converter demo: ${origin} (local only, no live API)`));
server.on('error', error => { console.error(`Local demo listener failed: ${error.code}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
