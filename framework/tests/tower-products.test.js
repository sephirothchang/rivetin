import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerProductsProvider } from '../server/tower-products.js';
import { checkCompatibility } from '../server/compatibility.js';

const clock = Date.parse('2026-01-01T00:00:00.000Z');
const actor = { id: 'example-root', name: 'EXAMPLE_ADMIN', admin: true, role: 'ROOT', source: 'tower', auth: { Authorization: 'EXAMPLE_UNUSABLE_AUTH' } };
const row = patch => ({ id: 'example-cluster', type: 'SMTX_OS', version: '6.3.0', connect_state: 'CONNECTED', ...patch });
const fixture = (rows = [row()], counts = [rows.length, rows.length]) => {
  const calls = []; let index = 0;
  const provider = createTowerProductsProvider({ now: () => clock, request: async (path, body, caller) => {
    calls.push({ path, body, caller });
    return path === '/v2/api/get-clusters' ? structuredClone(rows) : { aggregate: { count: counts[index++] } };
  } });
  return { provider, calls };
};

test('ROOT inventory forwards the authenticated actor and proves bounded count/list/count coverage', async () => {
  const { provider, calls } = fixture([row({ ip: '192.0.2.5', name: 'EXAMPLE_PRIVATE_NAME', license_serial: 'EXAMPLE_PRIVATE_SERIAL' }), row({ id: 'example-other', type: 'SMTX_ZBS', version: '5.6.0' })]);
  const value = await provider(actor);
  assert.deepEqual(value, { schemaVersion: 1, source: 'tower-clusters-root', trusted: true, complete: true, checkedAt: new Date(clock).toISOString(), clusters: [{ product: 'SMTX_OS', version: '6.3.0' }, { product: 'SMTX_ZBS', version: '5.6.0' }], reason: null });
  assert.deepEqual(calls.map(({ path, body }) => ({ path, body })), [{ path: '/v2/api/get-clusters-connection', body: {} }, { path: '/v2/api/get-clusters', body: { first: 501 } }, { path: '/v2/api/get-clusters-connection', body: {} }]);
  assert.ok(calls.every(call => call.caller === actor));
  assert.doesNotMatch(JSON.stringify(value), /EXAMPLE_PRIVATE|example-cluster|example-other|192\.0\.2|EXAMPLE_UNUSABLE_AUTH|Authorization|example-root/);
});

test('missing identity, ADMIN and other partial scopes stay unknown without any request', async () => {
  const { provider, calls } = fixture();
  for (const value of [null, {}, { ...actor, admin: false }, { ...actor, admin: 1 }, { ...actor, role: 'ADMIN' }, { ...actor, role: 'ROOT', source: 'cli' }, { ...actor, auth: {} }]) {
    const result = await provider(value); assert.equal(result.trusted, false); assert.equal(result.complete, false); assert.equal(result.reason, 'SMTX_AUTHORITY_REQUIRED');
  }
  assert.equal(calls.length, 0);
});

test('counts must be valid and match both before and after with no truncation or scope drift', async () => {
  for (const counts of [[2, 2], [1, 2], [0, 0], [true, true], [-1, -1], [501, 501]]) {
    const { provider, calls } = fixture([row()], counts); const result = await provider(actor);
    assert.equal(result.trusted, false); assert.equal(result.complete, false); assert.deepEqual(result.clusters, []); assert.ok(calls.length <= 3);
  }
  const { provider } = fixture(Array.from({ length: 501 }, (_, index) => row({ id: `example-${index}` })), [500, 500]);
  assert.equal((await provider(actor)).reason, 'SMTX_INVENTORY_LIMIT');
  const empty = await fixture([]).provider(actor); assert.equal(empty.complete, true); assert.deepEqual(empty.clusters, []);
});

test('unknown products, malformed versions, duplicate identities and disconnected clusters cannot certify coverage', async () => {
  for (const rows of [[row({ type: 'UNKNOWN' })], [row({ version: null })], [row({ version: '6.3.*' })], [row({ version: '6.3.0\n' })], [row({ id: '../example' })], [row(), row()], [row({ connect_state: 'DISCONNECTED' })], [row({ connect_state: 'CONNECTED_ERROR' })], [row({ connect_state: undefined })]]) {
    const result = await fixture(rows).provider(actor); assert.equal(result.trusted, false); assert.equal(result.complete, false); assert.deepEqual(result.clusters, []);
  }
  for (const type of ['SMTX_OS', 'SMTX_ELF', 'SMTX_ZBS', 'BLUESHARK']) assert.equal((await fixture([row({ type })]).provider(actor)).trusted, true);
});

test('malformed count envelopes, transport failures and private diagnostics produce fixed unknown codes', async () => {
  for (const response of [{}, [], { aggregate: { count: 1, extra: true } }, { aggregate: { count: 1 }, nodes: [] }]) {
    const provider = createTowerProductsProvider({ now: () => clock, request: async () => response });
    assert.equal((await provider(actor)).reason, 'SMTX_INVENTORY_INVALID');
  }
  const provider = createTowerProductsProvider({ request: async () => { throw new Error('EXAMPLE_PRIVATE_TRANSPORT_ERROR'); } });
  assert.equal((await provider(actor)).reason, 'SMTX_INVENTORY_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(await provider(actor)), /EXAMPLE_PRIVATE_TRANSPORT_ERROR|EXAMPLE_UNUSABLE_AUTH/);
});

test('timed out or aborted reads never issue subsequent calls or certify a late response', async () => {
  let release; const calls = [];
  const provider = createTowerProductsProvider({ timeoutMs: 5, now: () => clock, request: async path => { calls.push(path); return new Promise(resolve => { release = resolve; }); } });
  assert.equal((await provider(actor)).reason, 'SMTX_CHECK_TIMEOUT');
  release({ aggregate: { count: 1 } }); await new Promise(setImmediate); assert.equal(calls.length, 1);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await provider(actor, { signal: cancelled.signal })).reason, 'SMTX_CHECK_CANCELLED'); assert.equal(calls.length, 1);
  const controller = new AbortController(); const pending = provider(actor, { signal: controller.signal }); controller.abort();
  assert.equal((await pending).reason, 'SMTX_CHECK_CANCELLED'); release({ aggregate: { count: 1 } }); await new Promise(setImmediate); assert.equal(calls.length, 2);
});

test('fresh reads never reuse a previous caller identity or successful product list', async () => {
  const { provider, calls } = fixture([row()], [1, 1, 1, 1]); const first = await provider(actor);
  first.clusters[0].version = '0.0.0';
  const secondActor = { ...actor, id: 'example-second-root', auth: { Cookie: 'EXAMPLE_SECOND_AUTH' } };
  const second = await provider(secondActor);
  assert.equal(calls.length, 6); assert.equal(second.trusted, true); assert.equal(second.clusters[0].version, '6.3.0');
  assert.equal(calls.at(-1).caller, secondActor);
  const { provider: fresh } = fixture(); assert.equal((await fresh(actor)).clusters[0].version, '6.3.0');
});

test('ROOT provider snapshot integrates with required SMTX and reports empty scope as confirmed incompatible', async () => {
  const manifest = { compatibility: { schemaVersion: 2, frameworkApi: 1, tower: 'Explicit tested versions only.', towerBuilds: ['4.9.0'], frameworkMinVersion: '0.1.0', frameworkMaxVersionExclusive: '0.2.0', smtx: { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: ['6.3.0'] } } };
  const context = { towerBuild: '4.9.0', frameworkVersion: '0.1.5', now: clock };
  assert.equal(checkCompatibility(manifest, { ...context, smtx: await fixture().provider(actor) }).status, 'compatible');
  assert.equal(checkCompatibility(manifest, { ...context, smtx: await fixture([]).provider(actor) }).reason, 'SMTX_SCOPE_EMPTY');
  assert.equal(checkCompatibility(manifest, { ...context, smtx: await fixture().provider({ ...actor, role: 'ADMIN' }) }).status, 'unknown');
});

test('product provider rejects missing transport and unbounded timeout options', () => {
  assert.throws(() => createTowerProductsProvider(), /TOWER_TRANSPORT_REQUIRED/);
  for (const timeoutMs of [0, -1, 10001, Infinity, '5']) assert.throws(() => createTowerProductsProvider({ request: async () => [], timeoutMs }), /INVALID_PRODUCT_TIMEOUT/);
});
