import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerConnection } from '../server/tower.js';
import { towerLocale, watchTowerLocale } from '../src/i18n.js';
import { JSDOM } from 'jsdom';
const token = id => 'EXAMPLE.' + Buffer.from(id).toString('base64url') + '.EXAMPLE_SIGNATURE';

test('Tower transport confines requests to fixed local API paths and bounds streamed JSON before parsing', async () => {
  let calls = 0;
  const connection = createTowerConnection({ baseUrl: 'https://tower.example.invalid', fetchImpl: async () => { calls++; return Response.json({ ok: true }); } });
  for (const target of ['https://other.example.invalid/api', '//other.example.invalid/api', '/v2/api/../secrets', '/api?token=EXAMPLE', '/healthz']) await assert.rejects(connection.request(target, {}), /INVALID_TOWER_PATH/);
  assert.equal(calls, 0);
  assert.deepEqual(await connection.request('/v2/api/get-clusters', {}), { ok: true });
  const oversized = createTowerConnection({ baseUrl: 'https://tower.example.invalid', fetchImpl: async () => new Response('[]', { headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } }) });
  await assert.rejects(oversized.request('/api', {}), /TOWER_RESPONSE_TOO_LARGE/);
  const stream = createTowerConnection({ baseUrl: 'https://tower.example.invalid', fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } })) });
  await assert.rejects(stream.request('/api', {}), /TOWER_RESPONSE_TOO_LARGE/);
});
test('decoded JWT identity is accepted only after Tower verifies it; role determines admin rights', async () => {
  const seen = [];
  const connection = createTowerConnection({ baseUrl: 'http://tower.example.invalid', fetchImpl: async (url, options) => {
    seen.push({ url, options }); return Response.json({ data: { user: { id: 'example-user', username: 'example', role: 'READ_ONLY' } } });
  } });
  const actor = await connection.authenticate({ headers: { authorization: 'Bearer ' + token('example-user'), 'x-skip-auth-verify': 'true' } });
  assert.equal(actor.admin, false); assert.equal(actor.id, 'example-user'); assert.equal(seen[0].url.pathname, '/api');
  assert.equal(seen[0].options.headers['x-skip-auth-verify'], undefined);
  assert.equal(await connection.authenticate({ headers: { authorization: 'Bearer ' + token('other-user') } }), null);
  const rejecting = createTowerConnection({ baseUrl: 'http://tower.example.invalid', fetchImpl: async () => Response.json({ errors: [{ message: 'EXAMPLE_INVALID_SIGNATURE' }] }) });
  assert.equal(await rejecting.authenticate({ headers: { authorization: 'Bearer ' + token('example-user') } }), null);
});
test('cookie identity uses protected single-session query; forged/unauthorized sessions fail closed', async () => {
  const connection = createTowerConnection({ baseUrl: 'http://tower.example.invalid', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); assert.ok(body.query.includes('userSession(where:'));
    return Response.json({ data: { userSession: { authorized: body.variables.id === 'example-session', user: { id: 'example-user', username: 'example', role: 'ROOT' } } } });
  } });
  assert.equal((await connection.authenticate({ headers: { cookie: 'connect.sid=s%3Aexample-session.EXAMPLE_SIGNATURE' } })).admin, true);
  assert.equal(await connection.authenticate({ headers: { cookie: 'connect.sid=s%3Aforged-session.EXAMPLE_SIGNATURE' } }), null);
  assert.equal(await connection.authenticate({ headers: { cookie: 'another=EXAMPLE' } }), null);
});
test('Tower system-user-only audit denial is surfaced without exposing server diagnostics', async () => {
  const connection = createTowerConnection({ baseUrl: 'http://tower.example.invalid', fetchImpl: async () => Response.json({ message: 'only allow by system user', stack: 'EXAMPLE_PRIVATE_STACK' }, { status: 500 }) });
  await assert.rejects(connection.request('/v2/api/create-user-audit-log', [], { auth: {} }), error => error.message === 'TOWER_AUDIT_SYSTEM_USER_REQUIRED');
});
test('Tower language setting overrides static HTML language, remains read-only and updates on host changes', async () => {
  const dom = new JSDOM('<html lang="en"><body></body></html>', { url: 'https://tower.example.invalid' });
  const win = dom.window; win.localStorage.setItem('language', JSON.stringify({ value: 'zh-CN' }));
  assert.equal(towerLocale(win), 'zh-CN'); assert.equal(towerLocale(win, 'en-US'), 'en-US');
  const locales = [], stop = watchTowerLocale(win, value => locales.push(value));
  win.localStorage.setItem('language', JSON.stringify({ value: 'en-US' })); win.dispatchEvent(new win.StorageEvent('storage', { key: 'language' }));
  assert.equal(locales.at(-1), 'en-US'); assert.equal(JSON.parse(win.localStorage.getItem('language')).value, 'en-US');
  stop(); dom.window.close();
});
