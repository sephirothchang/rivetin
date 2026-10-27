import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loginMegaRac } from '../server/megarac-adapter.js';
import { createDemoGateway } from '../demo/gateway.js';

test('MegaRAC adapter uses form POST and returns browser session state without a password', async () => {
  let observed;
  const result = await loginMegaRac({ baseUrl: 'https://bmc.example.invalid', username: 'DEMO_USER', password: 'DEMO_PASSWORD',
    transport: async (url, options) => { observed = { url, options }; return new Response(JSON.stringify({ ok: 0, passwordStatus: 0, CSRFToken: 'DEMO_CSRF', racsession_id: 2, privilege: 4, extendedpriv: 3, channel: 1 })); } });
  assert.equal(observed.url.pathname, '/api/session'); assert.equal(observed.options.method, 'POST');
  assert.equal(new URLSearchParams(observed.options.body).get('password'), 'DEMO_PASSWORD');
  assert.equal(result.browserState.garc, 'DEMO_CSRF'); assert.ok(!JSON.stringify(result).includes('DEMO_PASSWORD'));
});
test('MegaRAC forced password change and invalid responses stop without changing credentials', async () => {
  for (const [data, code] of [[{ ok: 1, passwordStatus: 1 }, 'PASSWORD_CHANGE_REQUIRED'], [{ ok: 0 }, 'INVALID_LOGIN_RESPONSE']]) {
    let calls = 0;
    await assert.rejects(loginMegaRac({ baseUrl: 'https://bmc.example.invalid', username: 'DEMO', password: 'DEMO_SECRET', transport: async () => { calls++; return new Response(JSON.stringify(data)); } }), error => error.code === code && !error.message.includes('DEMO_SECRET'));
    assert.equal(calls, 1);
  }
});
test('MegaRAC timeout is bounded and diagnostic output excludes credentials', async () => {
  await assert.rejects(loginMegaRac({ baseUrl: 'https://bmc.example.invalid', username: 'DEMO', password: 'DEMO_SECRET', timeoutMs: 15,
    transport: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('DEMO_SECRET')))),
  }), error => error.code === 'LOGIN_TIMEOUT' && !error.message.includes('DEMO_SECRET'));
});
test('local gateway restricts origins/targets, consumes launch once, and requires session plus CSRF', async () => {
  let now = Date.now();
  const gateway = createDemoGateway({ towerOrigin: 'http://tower.demo.invalid', gatewayOrigin: 'http://gateway.demo.invalid', clock: () => now });
  const server = http.createServer((req, res) => gateway.handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function launch(body, origin = 'http://tower.demo.invalid') { return fetch(base + '/api/launch', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  try {
    assert.equal((await launch({ hostId: 'demo-node-1' }, 'https://untrusted.example')).status, 403);
    assert.equal((await launch({ hostId: 'demo-node-1', url: 'https://untrusted.example' })).status, 403);
    assert.equal((await launch({ hostId: '__proto__' })).status, 403);
    assert.equal((await launch({ hostId: 'demo-node-1', vendor: 'dell-idrac' })).status, 403);
    const started = await (await launch({ hostId: 'demo-node-1' })).json();
    assert.ok(!JSON.stringify(started).includes('DEMO_ONLY'));
    const path = new URL(started.launchUrl).pathname;
    const bootstrap = await fetch(base + path), cookie = bootstrap.headers.get('set-cookie').split(';')[0], html = await bootstrap.text();
    assert.equal(bootstrap.status, 200); assert.ok(!html.includes('DEMO_ONLY_NOT_A_REAL_PASSWORD'));
    const state = JSON.parse(/const state=(\{.*?\});for/.exec(html)[1]);
    assert.equal((await fetch(base + path)).status, 410);
    assert.equal((await fetch(base + '/api/status', { headers: { Cookie: cookie } })).status, 401);
    const check = await fetch(base + '/api/status', { headers: { Cookie: cookie, 'X-CSRFTOKEN': state.garc } });
    assert.equal(check.status, 200); assert.equal((await check.json()).simulated, true);
    const expiring = await (await launch({ hostId: 'demo-node-1' })).json(); now += 31000;
    assert.equal((await fetch(base + new URL(expiring.launchUrl).pathname)).status, 410);
  } finally { gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
