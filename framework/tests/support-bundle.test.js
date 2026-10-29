import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createSupportBundle, SUPPORT_COMPONENT_IDS, SUPPORT_LIMITS } from '../server/support-bundle.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';

const now = () => Date.UTC(2026, 0, 2, 3, 4, 5);
const secret = 'EXAMPLE_SENSITIVE_CREDENTIAL_NOT_FOR_EXPORT';
const packageId = 'a'.repeat(64);
const declaration = () => ({ schemaVersion: 2, frameworkApi: 1, tower: secret, towerBuilds: ['4.9.0'], frameworkMinVersion: '0.1.5', frameworkMaxVersionExclusive: '0.2.0', smtx: { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: ['6.3.0'] } });
const event = (id = 'EXAMPLE_PRIVATE_EVENT', actorId = 'EXAMPLE_PRIVATE_ACTOR') => ({ id, actor: { id: actorId, name: secret, source: 'tower' }, time: '2026-01-01T00:00:00.000Z', action: 'configuration.save', result: 'failed', code: 'INVALID_SETTINGS', pluginId: 'rivetin-example', message: secret, stack: secret, resourceId: secret, settings: { password: secret }, rawOutput: secret, towerDelivery: { state: 'failed', message: secret } });
function fixture() {
  return {
    runtime: { version: FRAMEWORK_VERSION, initialized: true, enabled: true, towerBuild: '4.9.0', isolation: 'TODO', audit: 'permission-denied', backendPath: secret, env: { password: secret }, compatibility: { compatible: true, status: 'compatible', reason: null, declared: declaration(), observed: { frameworkVersion: FRAMEWORK_VERSION, towerVersion: '4.9.0', clusterCount: 2, smtxClusterCount: 1, smtxVersions: ['6.3.0'], productCounts: { EXAMPLE_PRIVATE_PRODUCT: secret }, clusters: [{ id: secret, name: secret, address: secret }] } } },
    components: [{ id: 'runtime', status: 'ok', code: null, dependsOn: ['storage'], label: '示例中文组件', detail: secret, address: secret }, { id: 'storage', status: 'ready', code: null }],
    plugins: [{ id: 'rivetin-example', version: '0.1.0', packageId, installed: true, enabled: true, active: false, compatible: false, reason: 'SMTX_INCOMPATIBLE', manifest: { id: 'rivetin-example', version: '0.1.0', name: secret, description: secret, author: secret, homepage: secret, compatibility: declaration(), configuration: { defaults: { password: secret } }, privateExtra: secret }, configSummary: { revision: 3, schemaVersion: 1, settings: { password: secret } }, settings: { password: secret }, password: secret, hostKeySha256: secret }],
    logs: [event()],
    privateExtra: { vault: secret, key: secret, cookie: secret, token: secret, certificate: secret, serial: secret, command: secret, rawOutput: secret, path: secret },
  };
}
function unpack(input = fixture(), options = {}) {
  const bundle = createSupportBundle(input, { now, ...options });
  const compressed = Buffer.from(bundle.data, 'base64'), bytes = gunzipSync(compressed);
  return { bundle, compressed, bytes, document: JSON.parse(bytes) };
}

test('support bundle is a deterministic gzip JSON envelope with exact digest and safe filename', () => {
  const { bundle, compressed, document } = unpack();
  assert.equal(bundle.filename, `20260102-${FRAMEWORK_VERSION}.rivetin-support.json.gz`);
  assert.equal(bundle.contentType, 'application/gzip');
  assert.equal(bundle.bytes, compressed.length);
  assert.equal(bundle.sha256, createHash('sha256').update(compressed).digest('hex'));
  assert.equal(document.schemaVersion, 1); assert.equal(document.format, 'rivetin-support-v1');
  assert.equal(document.rivetinVersion, FRAMEWORK_VERSION); assert.equal(document.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(unpack().bundle.data, bundle.data);
  assert.deepEqual(Object.keys(bundle).sort(), ['bytes', 'contentType', 'data', 'filename', 'sha256']);
  assert.equal(Object.hasOwn(bundle, 'path'), false);
});

test('only explicit public state, version declarations, counters and configuration revisions survive', () => {
  const { document } = unpack(), plugin = document.plugins.items[0];
  assert.equal(document.plugins.count, 1); assert.equal(document.plugins.installedCount, 1); assert.equal(document.plugins.activeCount, 0); assert.equal(document.plugins.compatibleCount, 0);
  assert.equal(plugin.id, 'rivetin-example'); assert.equal(plugin.packageSha256, packageId);
  assert.deepEqual(plugin.configuration, { revision: 3, schemaVersion: 1 });
  assert.deepEqual(plugin.compatibility, { schemaVersion: 2, frameworkApi: 1, towerBuilds: ['4.9.0'], smtx: { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: ['6.3.0'] }, frameworkMinVersion: '0.1.5' });
  assert.equal(plugin.code, 'SMTX_INCOMPATIBLE');
  assert.deepEqual(document.components.items[0], { id: 'runtime', status: 'ok', code: null, dependsOn: ['storage'] });
  assert.equal(document.framework.compatibility.observed.clusterCount, 2);
  assert.deepEqual(document.framework.compatibility.observed.smtxVersions, ['6.3.0']);
  assert.equal(document.framework.compatibility.observed.towerVersion, '4.9.0');
  assert.equal(Object.hasOwn(document.framework.compatibility.observed, 'productCounts'), false);
  assert.equal(document.logs.count, 1); assert.equal(document.logs.actorCount, 1); assert.equal(document.logs.eventCount, 1);
  assert.deepEqual(document.limits, SUPPORT_LIMITS);
});

test('credentials, identities, paths, raw diagnostics and arbitrary nested values never enter decompressed bytes', () => {
  const source = fixture(), before = structuredClone(source), { bytes, document } = unpack(source);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.doesNotMatch(bytes.toString(), /EXAMPLE_PRIVATE_ACTOR|EXAMPLE_PRIVATE_EVENT|示例中文组件/);
  assert.deepEqual(source, before);
  assert.deepEqual(Object.keys(document.logs.items[0]).sort(), ['action', 'actorRef', 'code', 'eventRef', 'pluginId', 'result', 'time']);
  assert.deepEqual(Object.keys(document.plugins.items[0]).sort(), ['active', 'code', 'compatibility', 'compatible', 'configuration', 'enabled', 'id', 'installed', 'packageSha256', 'version']);
});

test('deployment probe reasons survive export while challenges, instance tokens and raw TLS diagnostics are discarded', () => {
  const source = fixture();
  source.components = [{ id: 'gateway', status: 'unknown', code: 'GATEWAY_TLS_UNTRUSTED', challenge: secret, instance: secret, diagnostics: secret },
    { id: 'island-registration', status: 'failed', code: 'ISLAND_REGISTRATION_MISMATCH', registry: secret }];
  const { document, bytes } = unpack(source);
  assert.deepEqual(document.components.items.map(row => row.code), ['GATEWAY_TLS_UNTRUSTED', 'ISLAND_REGISTRATION_MISMATCH']);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.doesNotMatch(bytes.toString(), /challenge|instance|diagnostics|registry/);
});

test('bundle-local actor and event aliases preserve equality without exposing or hashing private identifiers', () => {
  const input = fixture(); input.logs = [event('EXAMPLE_EVENT_ONE'), event('EXAMPLE_EVENT_TWO'), event('EXAMPLE_EVENT_ONE'), event('EXAMPLE_EVENT_THREE', 'EXAMPLE_OTHER_ACTOR')];
  input.logs.push({ ...event('EXAMPLE_EVENT_FOUR'), actor: { id: 'EXAMPLE_PRIVATE_ACTOR', source: 'cli', name: secret } });
  const { document, bytes } = unpack(input), rows = document.logs.items;
  assert.deepEqual(rows.map(row => row.actorRef), ['actor-0001', 'actor-0001', 'actor-0001', 'actor-0002', 'actor-0003']);
  assert.deepEqual(rows.map(row => row.eventRef), ['event-0001', 'event-0002', 'event-0001', 'event-0003', 'event-0004']);
  assert.equal(document.logs.actorCount, 3); assert.equal(document.logs.eventCount, 4);
  assert.equal(bytes.includes(Buffer.from(createHash('sha256').update('EXAMPLE_PRIVATE_ACTOR').digest('hex'))), false);
});

test('unknown well-formed actions and codes become fixed placeholders, never arbitrary diagnostic text', () => {
  const input = fixture(); input.logs[0].action = 'private.secret-action'; input.logs[0].code = secret;
  input.components[0].code = secret; input.plugins[0].reason = secret;
  const { document, bytes } = unpack(input);
  assert.equal(document.logs.items[0].action, 'unknown.action'); assert.equal(document.logs.items[0].code, 'UNKNOWN_CODE');
  assert.equal(document.components.items[0].code, 'UNKNOWN_CODE'); assert.equal(document.plugins.items[0].code, 'UNKNOWN_CODE');
  assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('the shared component ID set and dependsOn reject private IDs, duplicate entries and unknown status', () => {
  for (const change of [
    input => { input.components[0].id = 'EXAMPLE_PRIVATE_COMPONENT'; },
    input => { input.components[0].dependsOn = ['EXAMPLE_PRIVATE_HOST']; },
    input => { input.components[0].dependsOn = ['storage', 'storage']; },
    input => { input.components.push({ ...input.components[0] }); },
    input => { input.components[0].status = secret; },
  ]) { const input = fixture(); change(input); assert.throws(() => unpack(input), /SUPPORT_(?:INPUT|COMPONENT)_INVALID/); }
  for (const status of ['ok', 'warning', 'failed', 'unknown', 'disabled']) { const source = fixture(); source.components[0].status = status; assert.equal(unpack(source).document.components.items[0].status, status); }
  const input = fixture(); input.components = SUPPORT_COMPONENT_IDS.map(id => ({ id, status: 'unknown' }));
  assert.equal(unpack(input).document.components.count, SUPPORT_COMPONENT_IDS.length);
});

test('null and absent optional observations remain unknown and uninstalled tombstones need no manifest', () => {
  const input = { runtime: {}, plugins: [{ id: 'rivetin-removed', installed: false }], components: [], logs: [] };
  const { document } = unpack(input);
  assert.equal(document.framework.version, null); assert.equal(document.framework.enabled, null); assert.equal(document.framework.compatibility, null);
  assert.equal(document.plugins.items[0].version, null); assert.equal(document.plugins.items[0].compatibility, null); assert.equal(document.plugins.items[0].configuration, null);
  assert.equal(document.plugins.installedCount, 0);
});

test('nested state is accepted only for matching public plugin identity', () => {
  const input = fixture(), original = input.plugins[0];
  input.plugins[0] = { id: original.id, state: { version: '0.1.1', packageId, installed: true, enabled: false }, manifest: original.manifest, configSummary: original.configSummary };
  assert.equal(unpack(input).document.plugins.items[0].version, '0.1.1');
  input.plugins[0].manifest.id = 'rivetin-other'; assert.throws(() => unpack(input), /SUPPORT_INPUT_INVALID/);
});

test('SMTX none and schema versions retain public declarations without cluster objects', () => {
  for (const smtx of [undefined, 'none']) {
    const input = fixture(); input.plugins[0].manifest.compatibility.smtx = smtx;
    assert.equal(unpack(input).document.plugins.items[0].compatibility.smtx, smtx ?? null);
  }
  const input = fixture(); input.plugins[0].manifest.compatibility.schemaVersion = 1;
  assert.equal(unpack(input).document.plugins.items[0].compatibility.schemaVersion, 1);
});

test('runtime framework declaration and observed versions use the integration contract without resource identities', () => {
  const input = fixture();
  input.runtime.compatibility = { compatible: false, status: 'unknown', reason: 'SMTX_SNAPSHOT_EXPIRED', declared: { schemaVersion: 1, frameworkApi: 1, frameworkVersion: FRAMEWORK_VERSION, towerBuilds: ['4.9.0'], name: secret }, observed: { frameworkVersion: FRAMEWORK_VERSION, towerVersion: '4.9.0', smtxVersions: ['6.3.0', '6.3.1'], clusterCount: 4, smtxClusterCount: 2, clusterIds: [secret], hosts: [{ pin: secret, username: secret }] } };
  const { document, bytes } = unpack(input), compatibility = document.framework.compatibility;
  assert.equal(compatibility.declared.frameworkVersion, FRAMEWORK_VERSION);
  assert.equal(compatibility.reason, 'SMTX_SNAPSHOT_EXPIRED');
  assert.deepEqual(compatibility.observed, { frameworkVersion: FRAMEWORK_VERSION, towerVersion: '4.9.0', smtxVersions: ['6.3.0', '6.3.1'], clusterCount: 4, smtxClusterCount: 2 });
  assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('top-level invalid input, missing sections, sparse rows, custom prototypes and executable values fail closed', () => {
  for (const value of [null, [], 'invalid', 1, {}, { ...fixture(), plugins: {} }, { ...fixture(), logs: Array(1) }, { ...fixture(), runtime: null }, Object.assign(Object.create({ privateValue: secret }), fixture())]) assert.throws(() => createSupportBundle(value, { now }), /SUPPORT_INPUT_INVALID/);
  for (const value of [() => secret, 1n, Symbol('example'), NaN, Infinity, new Date(), new Map()]) {
    const input = fixture(); input.privateExtra = value; assert.throws(() => unpack(input), /SUPPORT_INPUT_INVALID/);
  }
});

test('cycles in even excluded fields are rejected, while shared non-cyclic references are permitted', () => {
  const input = fixture(); input.privateExtra.self = input;
  assert.throws(() => unpack(input), /SUPPORT_INPUT_INVALID/);
  delete input.privateExtra.self; input.logs.push(event('EXAMPLE_SECOND')); input.logs[1].actor = input.logs[0].actor;
  assert.equal(unpack(input).document.logs.actorCount, 1);
});

test('getters, options accessors and toJSON hooks never execute', () => {
  let calls = 0;
  for (const name of ['runtime', 'privateExtra']) {
    const input = fixture(); Object.defineProperty(input, name, { enumerable: true, get() { calls++; return {}; } });
    assert.throws(() => unpack(input), /SUPPORT_INPUT_INVALID/);
  }
  const input = fixture(); input.privateExtra.toJSON = () => { calls++; return secret; };
  assert.throws(() => unpack(input), /SUPPORT_INPUT_INVALID/);
  const options = {}; Object.defineProperty(options, 'now', { get() { calls++; return now; } });
  assert.throws(() => createSupportBundle(fixture(), options), /SUPPORT_INPUT_INVALID/);
  assert.equal(calls, 0);
});

for (const [label, change] of [
  ['newline code', input => { input.logs[0].code = 'INVALID_SETTINGS\nEXAMPLE_SECRET'; }],
  ['shell action', input => { input.logs[0].action = 'ssh.run;whoami'; }],
  ['path plugin ID', input => { input.plugins[0].id = 'rivetin-../private'; }],
  ['invalid digest', input => { input.plugins[0].packageId = secret; }],
  ['IP in version', input => { input.runtime.version = '192.0.2.10'; }],
  ['path in build', input => { input.runtime.towerBuild = '/private/tower'; }],
  ['invalid timestamp', input => { input.logs[0].time = '2026-02-30T00:00:00Z'; }],
  ['invalid actor ID', input => { input.logs[0].actor.id = 'private/user'; }],
  ['invalid event ID', input => { input.logs[0].id = 'private/event'; }],
  ['invalid actor source', input => { input.logs[0].actor.source = secret; }],
  ['invalid result', input => { input.logs[0].result = secret; }],
  ['invalid configuration revision', input => { input.plugins[0].configSummary.revision = -1; }],
  ['SMTX unexpected scope', input => { input.plugins[0].manifest.compatibility.smtx.scope = secret; }],
  ['SMTX private product', input => { input.plugins[0].manifest.compatibility.smtx.product = secret; }],
  ['SMTX raw cluster list', input => { input.plugins[0].manifest.compatibility.smtx.builds = [{ name: secret }]; }],
  ['duplicate builds', input => { input.plugins[0].manifest.compatibility.towerBuilds.push('4.9.0'); }],
  ['duplicate plugins', input => { input.plugins.push({ ...input.plugins[0] }); }],
]) test(`known field rejects ${label}`, () => { const input = fixture(); change(input); assert.throws(() => unpack(input), /SUPPORT_INPUT_INVALID/); });

test('section count limits reject instead of silently truncating', () => {
  for (const [section, value] of [['plugins', {}], ['logs', event()], ['components', { id: 'runtime', status: 'unknown' }]]) {
    const input = fixture(); input[section] = Array.from({ length: SUPPORT_LIMITS[section] + 1 }, () => value);
    assert.throws(() => unpack(input), /SUPPORT_SECTION_LIMIT/);
  }
  const input = fixture(); input.plugins = Array.from({ length: SUPPORT_LIMITS.plugins }, (_, index) => ({ id: `rivetin-example-${index}`, installed: true }));
  input.logs = Array.from({ length: SUPPORT_LIMITS.logs }, (_, index) => event(`EXAMPLE_EVENT_${index}`));
  const { document } = unpack(input); assert.equal(document.plugins.count, 500); assert.equal(document.logs.count, 1000);
});

test('exact JSON byte boundary and gzip cap are enforced and callers cannot raise hard limits', () => {
  const { bytes, compressed, document } = unpack();
  assert.ok(bytes.length < SUPPORT_LIMITS.jsonBytes && compressed.length < SUPPORT_LIMITS.gzipBytes);
  let jsonLimit = bytes.length;
  for (let i = 0; i < 4; i++) { document.limits.jsonBytes = jsonLimit; jsonLimit = Buffer.byteLength(JSON.stringify(document)); }
  assert.equal(unpack(fixture(), { maxJsonBytes: jsonLimit }).bytes.length, jsonLimit);
  assert.throws(() => unpack(fixture(), { maxJsonBytes: jsonLimit - 1 }), /SUPPORT_JSON_LIMIT/);
  assert.throws(() => unpack(fixture(), { maxGzipBytes: 1 }), /SUPPORT_GZIP_LIMIT/);
  for (const options of [{ maxJsonBytes: SUPPORT_LIMITS.jsonBytes + 1 }, { maxGzipBytes: SUPPORT_LIMITS.gzipBytes + 1 }, { maxJsonBytes: 0 }, { maxGzipBytes: NaN }, { path: '/EXAMPLE_PRIVATE_PATH' }]) assert.throws(() => unpack(fixture(), options), /SUPPORT_(?:LIMIT|INPUT)_INVALID/);
});

test('oversized unknown input and nesting are bounded before serialization', () => {
  const input = fixture(); input.privateExtra = 'x'.repeat(8 * 1024 * 1024 + 1);
  assert.throws(() => unpack(input), /SUPPORT_INPUT_LIMIT/);
  input.privateExtra = {}; let current = input.privateExtra; for (let i = 0; i < 30; i++) { current.child = {}; current = current.child; }
  assert.throws(() => unpack(input), /SUPPORT_INPUT_LIMIT/);
});

test('invalid export clock is rejected and does not influence a path or raw exception', () => {
  assert.throws(() => createSupportBundle(fixture(), { now: () => { throw new Error(secret); } }), error => error.message === 'SUPPORT_INPUT_INVALID');
  for (const value of [secret, new Date(), -1, NaN, Infinity, 1.1, 253402300800000]) assert.throws(() => createSupportBundle(fixture(), { now: () => value }), /SUPPORT_INPUT_INVALID/);
});

test('module imports only native compression/hash and static shared identity/version; no I/O or execution API', async () => {
  const source = await readFile(new URL('../server/support-bundle.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort(), ['../shared/identity.js', '../shared/version.js', 'node:crypto', 'node:zlib'].sort());
  assert.doesNotMatch(source, /process\.|fetch\(|child_process|node:fs|readFile|writeFile|execFile|spawn\(|\beval\(|\bFunction\(/);
});

test('demo actor sources stay only in the anonymous namespace and are never exported', () => {
  const input = fixture(); input.logs[0].actor.source = 'demo';
  const { document, bytes } = unpack(input); assert.equal(document.logs.items[0].actorRef, 'actor-0001'); assert.equal(bytes.includes(Buffer.from('\"source\"')), false);
});


test('maintenance audit entries retain only fixed known actions and diagnostic codes', () => {
  const input = fixture(); input.logs[0].action = 'components.repair.started'; input.logs[0].code = 'CLI_REPAIR_REQUIRED';
  const row = unpack(input).document.logs.items[0]; assert.equal(row.action, 'components.repair.started'); assert.equal(row.code, 'CLI_REPAIR_REQUIRED');
});
