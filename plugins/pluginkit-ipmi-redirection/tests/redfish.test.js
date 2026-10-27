import test from 'node:test';
import assert from 'node:assert/strict';
import { BMC_VENDORS } from '../src/vendor-registry.js';
import { createBmcApiClient, inspectBmc } from '../server/bmc-api.js';
const USER = 'EXAMPLE_USER', PASSWORD = 'EXAMPLE_PASSWORD', TOKEN = 'EXAMPLE_SESSION_TOKEN';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const serviceRoot = {
  RedfishVersion: '1.15.0', Links: { Sessions: { '@odata.id': '/redfish/v1/SessionService/Sessions' } },
  Systems: { '@odata.id': '/redfish/v1/Systems' }, Managers: { '@odata.id': '/redfish/v1/Managers' },
};
function fixture({ root = serviceRoot, location = '/redfish/v1/SessionService/Sessions/owned', rejectRead = false } = {}) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url: String(url), options });
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/redfish/v1') return json(root);
    if (options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { UserName: USER, Password: PASSWORD });
      return json({ Id: 'owned' }, 201, { 'X-Auth-Token': TOKEN, Location: location });
    }
    assert.equal(options.headers['X-Auth-Token'], TOKEN);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (rejectRead) return json({}, 403);
    if (path.endsWith('/Systems') || path.endsWith('/Managers')) return json({ Members: [{ '@odata.id': path + '/1' }] });
    return json({ Id: '1', Manufacturer: 'EXAMPLE_VENDOR', Model: 'EXAMPLE_MODEL', FirmwareVersion: 'EXAMPLE_VERSION',
      Status: { Health: 'OK' }, Oem: { Secret: PASSWORD }, Password: PASSWORD });
  };
  return { calls, transport };
}
const options = transport => ({ baseUrl: 'https://bmc.example.invalid', vendorId: 'dell-idrac', transport });

for (const vendor of BMC_VENDORS.filter(value => value.api === 'redfish-session')) {
  test(`${vendor.brand}: session login, inventory GET, and deletion of only the owned session`, async () => {
    const mock = fixture();
    const inventory = await inspectBmc({ ...options(mock.transport), vendorId: vendor.id }, { username: USER, password: PASSWORD });
    assert.equal(inventory.systems[0].Model, 'EXAMPLE_MODEL');
    assert.equal(inventory.managers[0].FirmwareVersion, 'EXAMPLE_VERSION');
    assert.ok(!JSON.stringify(inventory).includes(PASSWORD));
    assert.deepEqual(mock.calls.map(call => call.options.method), ['GET', 'POST', 'GET', 'GET', 'GET', 'GET', 'DELETE']);
    assert.ok(mock.calls.at(-1).url.endsWith('/Sessions/owned'));
    assert.equal(mock.calls.filter(call => call.options.body).length, 1);
  });
}
test('SessionService discovery supports anonymous denial without credential guessing', async () => {
  const mock = fixture({ root: { ...serviceRoot, Links: undefined, SessionService: { '@odata.id': '/redfish/v1/SessionService' } } });
  const transport = (url, opts) => url.pathname === '/redfish/v1/SessionService' ? Promise.resolve(json({}, 401)) : mock.transport(url, opts);
  const client = createBmcApiClient(options(transport));
  assert.equal((await client.probe()).sessionAuthentication, true);
  const session = await client.login({ username: USER, password: PASSWORD });
  assert.ok(!JSON.stringify(session).includes(TOKEN));
  await session.logout(); await session.logout();
  await assert.rejects(session.readInventory(), error => error.code === 'SESSION_CLOSED');
});
test('resource discovery follows SessionService links instead of fixed manager IDs', async () => {
  const mock = fixture({ root: { ...serviceRoot, Links: undefined, SessionService: { '@odata.id': '/redfish/v1/SessionService/' } } });
  const transport = (url, opts) => url.pathname === '/redfish/v1/SessionService/' ? Promise.resolve(json({ Sessions: { '@odata.id': '/redfish/v1/SessionService/Sessions/' } })) : mock.transport(url, opts);
  const session = await createBmcApiClient(options(transport)).login({ username: USER, password: PASSWORD });
  await session.logout();
});
test('lowercase iLO resource links retain their case through discovery, login and logout', async () => {
  const paths = [], root = { RedfishVersion: '1.15.0', SessionService: { '@odata.id': '/redfish/v1/sessionservice/' } };
  const transport = async (url, opts) => {
    paths.push(url.pathname);
    if (url.pathname === '/redfish/v1/') return json(root);
    if (url.pathname === '/redfish/v1/sessionservice/') return json({}, 401);
    if (opts.method === 'POST') return json({}, 201, { 'X-Auth-Token': TOKEN, Location: '/redfish/v1/sessionservice/sessions/owned/' });
    return new Response(null, { status: 204 });
  };
  const session = await createBmcApiClient({ ...options(transport), vendorId: 'hpe-ilo' }).login({ username: USER, password: PASSWORD });
  await session.logout();
  assert.deepEqual(paths, ['/redfish/v1/', '/redfish/v1/sessionservice/', '/redfish/v1/sessionservice/sessions', '/redfish/v1/sessionservice/sessions/owned/']);
});
test('cross-origin or out-of-tree links never receive credentials or tokens', async () => {
  for (const link of ['https://attacker.invalid/redfish/v1/Sessions', 'http://bmc.example.invalid/redfish/v1/Sessions',
    '/api/session', '/redfish/v1/%2e%2e/private', '/redfish/v1/Systems?token=bad']) {
    const mock = fixture({ root: { ...serviceRoot, Links: { Sessions: { '@odata.id': link } } } });
    await assert.rejects(createBmcApiClient(options(mock.transport)).login({ username: USER, password: PASSWORD }), error => error.code === 'UNTRUSTED_RESOURCE');
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].options.body, undefined);
  }
  const mock = fixture({ root: { ...serviceRoot, Systems: { '@odata.id': 'https://attacker.invalid/redfish/v1/Systems' } } });
  const session = await createBmcApiClient(options(mock.transport)).login({ username: USER, password: PASSWORD });
  await assert.rejects(session.readInventory(), error => error.code === 'UNTRUSTED_RESOURCE');
  await session.logout();
  assert.ok(mock.calls.every(call => new URL(call.url).hostname === 'bmc.example.invalid'));
});
test('HPE-style trailing slash 308 is accepted, arbitrary login redirects are stopped', async () => {
  for (const destination of ['/redfish/v1/SessionService/Sessions/', 'https://attacker.invalid/redfish/v1/SessionService/Sessions/', '/redfish/v1/Other']) {
    const mock = fixture(); let redirects = 0;
    const transport = (url, opts) => {
      if (opts.method === 'POST' && !redirects++) return Promise.resolve(new Response(null, { status: 308, headers: { Location: destination } }));
      return mock.transport(url, opts);
    };
    const login = createBmcApiClient(options(transport)).login({ username: USER, password: PASSWORD });
    if (destination.endsWith('Sessions/') && destination.startsWith('/')) { const session = await login; await session.logout(); }
    else await assert.rejects(login, error => ['UNTRUSTED_RESOURCE', 'UNEXPECTED_REDIRECT'].includes(error.code));
  }
});
test('invalid session locations cannot delete collections or sessions on a different BMC', async () => {
  for (const location of ['/redfish/v1/SessionService/Sessions', '/redfish/v1/Managers/1',
    '/redfish/v1/SessionService/Sessions/one/two', 'https://attacker.invalid/redfish/v1/SessionService/Sessions/1']) {
    const mock = fixture({ location });
    await assert.rejects(createBmcApiClient(options(mock.transport)).login({ username: USER, password: PASSWORD }));
    assert.equal(mock.calls.length, 2); assert.equal(mock.calls.filter(call => call.options.method === 'DELETE').length, 0);
  }
});
test('authentication rejection is not retried and transport errors are sanitized', async () => {
  for (const [status, expected] of [[401, 'AUTHENTICATION_REQUIRED'], [403, 'ACCESS_DENIED'], [429, 'SESSION_LIMIT_OR_RATE_LIMIT']]) {
    const calls = [];
    const client = createBmcApiClient(options(async (url, opts) => { calls.push(opts); return opts.method === 'POST' ? json({}, status) : json(serviceRoot); }));
    await assert.rejects(client.login({ username: USER, password: PASSWORD }), error => error.code === expected);
    assert.equal(calls.filter(value => value.method === 'POST').length, 1);
  }
  const client = createBmcApiClient(options(async () => { throw new Error(PASSWORD); }));
  await assert.rejects(client.probe(), error => error.code === 'BMC_REQUEST_FAILED' && !error.stack.includes(PASSWORD));
});
test('deadlines hold even when the transport ignores abort', async () => {
  const client = createBmcApiClient({ ...options(() => new Promise(() => {})), timeoutMs: 15 });
  await assert.rejects(client.probe(), error => error.code === 'REQUEST_TIMEOUT');
});
test('inventory errors still clean up the owned session, and cleanup errors are visible', async () => {
  const mock = fixture({ rejectRead: true });
  await assert.rejects(inspectBmc(options(mock.transport), { username: USER, password: PASSWORD }), error => error.code === 'ACCESS_DENIED');
  assert.equal(mock.calls.at(-1).options.method, 'DELETE');
  const second = fixture();
  await assert.rejects(inspectBmc(options((url, opts) => opts.method === 'DELETE' ? Promise.resolve(json({}, 503)) : second.transport(url, opts)),
    { username: USER, password: PASSWORD }), error => error.code === 'SESSION_CLEANUP_FAILED');
});
test('pagination is reported as truncated and foreign next-links are never followed', async () => {
  const mock = fixture();
  const transport = (url, opts) => url.pathname === '/redfish/v1/Systems' ? Promise.resolve(json({
    Members: [{ '@odata.id': '/redfish/v1/Systems/1' }, { '@odata.id': '/redfish/v1/Systems/2' }],
    'Members@odata.nextLink': 'https://attacker.invalid/next',
  })) : mock.transport(url, opts);
  const data = await inspectBmc({ ...options(transport), maxMembers: 1 }, { username: USER, password: PASSWORD });
  assert.equal(data.truncated, true); assert.equal(data.systems.length, 1);
});
test('unverified vendor protocol, insecure base URL and absent transport fail before any network', () => {
  for (const patch of [{ vendorId: 'zte-bmc' }, { baseUrl: 'http://bmc.example.invalid' },
    { baseUrl: 'https://bmc.example.invalid/path' }, { transport: undefined }]) {
    assert.throws(() => createBmcApiClient({ ...options(() => {}), ...patch }), error => error.code === 'INVALID_CONFIGURATION');
  }
});
