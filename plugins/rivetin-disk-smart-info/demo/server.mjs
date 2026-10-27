import http from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = new Map([['/', ['index.html', 'text/html']], ['/demo.css', ['demo.css', 'text/css']], ['/demo.js', ['../dist/demo/demo.js', 'text/javascript']]]);
const server = http.createServer(async (request, response) => {
  const route = routes.get(new URL(request.url, 'http://127.0.0.1:43181').pathname);
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end('Run npm run build first.'); }
});
server.listen(43181, '127.0.0.1', () => console.log('SMART local mock: http://127.0.0.1:43181; no live connections or daily collection.'));
server.on('error', error => { console.error(`Local demo listener failed: ${error.code}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
