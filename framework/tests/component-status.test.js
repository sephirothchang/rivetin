import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createComponentInspector } from '../server/component-status.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function bundle(id = 'rivetin-example', version = '0.1.0', mutate = value => value) {
  const code = Buffer.from('window.EXAMPLE_PLUGIN = true;'), license = Buffer.from('MIT License - test fixture');
  const manifest = { manifestVersion: 1, id, version, name: { 'zh-CN': '示例插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '示例', 'en-US': 'Example' }, author: 'Example', license: 'MIT',
    compatibility: { frameworkApi: 1, tower: 'Legacy display-only fixture', towerBuilds: ['4.9.0'] }, frontend: { format: 'rivetin-global-v1', entry: 'web/plugin.js' }, permissions: [], locales: ['zh-CN', 'en-US'],
    configuration: { version: 1, defaults: {}, schema: { type: 'object', properties: {}, additionalProperties: false } }, lifecycle: { reset: 'defaults', uninstall: 'retain-config' } };
  return Buffer.from(JSON.stringify(mutate({ format: 'rivetin-package-v1', manifest, files: [{ path: 'web/plugin.js', sha256: sha(code), data: code.toString('base64') }, { path: 'LICENSE', sha256: sha(license), data: license.toString('base64') }] })));
}
const version = '0.1.5', clock = Date.parse('2026-01-01T00:00:00.000Z');
const compatible = { compatible: true, status: 'compatible', reason: null, declared: { schemaVersion: 1, frameworkApi: 1, frameworkVersion: version, towerBuilds: ['4.9.0'] }, observed: { towerBuild: '4.9.0', frameworkVersion: version } };
async function fixture(t) {
  const base = path.resolve('qa/component-inspector'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'test-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('TEST_OUTSIDE_WORKSPACE'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const dataDirectory = path.join(root, 'data'), codeDirectory = path.join(root, 'code');
  await mkdir(path.join(dataDirectory, 'packages'), { recursive: true }); await mkdir(path.join(codeDirectory, 'server'), { recursive: true });
  const source = Buffer.from('EXAMPLE_FROZEN_CODE'), pkg = bundle(), packageId = sha(pkg);
  await writeFile(path.join(codeDirectory, 'server/main.js'), source); await writeFile(path.join(dataDirectory, 'audit.jsonl'), 'EXAMPLE_PRIVATE_AUDIT\n');
  await writeFile(path.join(dataDirectory, 'packages', packageId + '.json'), pkg);
  const manifest = { schemaVersion: 1, frameworkVersion: version, files: [{ path: 'server/main.js', sha256: sha(source), bytes: source.length }] };
  const manifestFile = path.join(codeDirectory, 'integrity.json'); await writeFile(manifestFile, JSON.stringify(manifest));
  const plugins = [{ id: 'rivetin-example', version: '0.1.0', packageId, installed: true, enabled: true, active: true, compatibility: compatible, manifest: { name: { 'zh-CN': '示例插件', 'en-US': 'Example plugin' } } }];
  const options = { dataDirectory, codeDirectory, version, now: () => clock, readRuntime: async () => ({ version, enabled: true }), readPlugins: async () => plugins, readConfig: async () => ({ plugins: { 'rivetin-example': { revision: 2, schemaVersion: 1, settings: { password: 'EXAMPLE_PRIVATE_SETTING' } } } }), readCompatibility: async () => compatible, readUpdates: async () => ({ reachable: true }), readIsland: async () => ({ available: true, matched: true }), apiRegistry: [{ id: 'api-components', registered: true, probe: async () => true }, { id: 'api-support', registered: true, probe: async () => true }] };
  return { root, options, manifest, manifestFile, plugins, packageId, async inspect(patch = {}) { return createComponentInspector({ ...options, ...patch }).inspect(); } };
}
const component = (result, id) => result.components.find(row => row.id === id);

test('inspector measures explicit files and packages without reading settings, audit contents or vault', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.options.dataDirectory, 'ssh-channel/vault'), { recursive: true });
  await writeFile(path.join(f.options.dataDirectory, 'ssh-channel/vault/key.json'), 'EXAMPLE_PRIVATE_KEY');
  const result = await f.inspect();
  assert.equal(result.schemaVersion, 1); assert.equal(result.checkedAt, new Date(clock).toISOString());
  assert.equal(component(result, 'code-integrity').status, 'ok'); assert.equal(component(result, 'package-store').status, 'ok'); assert.equal(component(result, 'audit').status, 'ok');
  assert.deepEqual(component(result, 'storage').checks.configurations, [{ id: 'rivetin-example', revision: 2, schemaVersion: 1 }]);
  assert.equal(result.plugins[0].name['en-US'], 'Example plugin'); assert.equal(result.actions.repair.available, false); assert.equal(result.actions.support.available, true);
  assert.equal(component(result, 'gateway').status, 'unknown'); assert.ok(result.limitations.includes('NO_KUBERNETES_AUTHORITY'));
  assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE|password|EXAMPLE_FROZEN_CODE|server\/main|key\.json/);
});

test('missing integrity is unknown; malformed, stale, corrupt and mismatched manifests do not pass', async t => {
  const f = await fixture(t); await rm(f.manifestFile);
  assert.equal(component(await f.inspect(), 'code-integrity').code, 'CODE_MANIFEST_UNAVAILABLE');
  for (const body of ['{', JSON.stringify({ ...f.manifest, frameworkVersion: '0.1.4' }), JSON.stringify({ ...f.manifest, schemaVersion: 2 }), JSON.stringify({ ...f.manifest, files: [] })]) {
    await writeFile(f.manifestFile, body); assert.equal(component(await f.inspect(), 'code-integrity').status, 'failed');
  }
  await writeFile(f.manifestFile, JSON.stringify(f.manifest)); await writeFile(path.join(f.options.codeDirectory, 'server/main.js'), 'EXAMPLE_CHANGED_CODE');
  assert.equal(component(await f.inspect(), 'code-integrity').code, 'CODE_INTEGRITY_MISMATCH');
});

test('integrity rejects traversal, Windows paths, duplicates, self references and byte/file caps', async t => {
  const f = await fixture(t), row = f.manifest.files[0];
  for (const target of ['../outside', '/etc/passwd', 'C:/private', 'server\\main.js', 'server/../main.js', 'integrity.json']) {
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, files: [{ ...row, path: target }] }));
    assert.equal(component(await f.inspect(), 'code-integrity').code, 'CODE_MANIFEST_INVALID');
  }
  await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, files: [row, { ...row, path: 'SERVER/main.js' }] })); assert.equal(component(await f.inspect(), 'code-integrity').code, 'CODE_MANIFEST_INVALID');
  for (const files of [[{ ...row, bytes: 16 * 1024 * 1024 + 1 }], Array.from({ length: 201 }, (_, index) => ({ ...row, path: `server/file${index}.js` })), Array.from({ length: 3 }, (_, index) => ({ ...row, path: `server/file${index}.js`, bytes: 16 * 1024 * 1024 }))]) {
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, files })); assert.equal(component(await f.inspect(), 'code-integrity').status, 'unknown'); assert.equal(component(await f.inspect(), 'code-integrity').code, 'INSPECTION_LIMIT');
  }
});

test('integrity refuses symlink files and symlink ancestors', async t => {
  const f = await fixture(t), target = path.join(f.root, 'outside'); await mkdir(target); await writeFile(path.join(target, 'main.js'), 'EXAMPLE_OUTSIDE');
  for (const directory of [false, true]) {
    const link = path.join(f.options.codeDirectory, directory ? 'linked-directory' : 'linked.js');
    try { await symlink(directory ? target : path.join(target, 'main.js'), link, directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file'); }
    catch (failure) { if (failure.code === 'EPERM' && !directory) { t.diagnostic('Windows lacks file-symlink privilege; directory junction still tested.'); continue; } throw failure; }
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, files: [{ path: directory ? 'linked-directory/main.js' : 'linked.js', bytes: 15, sha256: 'a'.repeat(64) }] }));
    assert.equal(component(await f.inspect(), 'code-integrity').code, 'INSPECTION_PATH_UNSAFE');
  }
});

test('registered APIs are unknown without a pure successful probe; unknown compatibility is not green', async t => {
  const f = await fixture(t), result = await f.inspect({ readCompatibility: async () => ({ compatible: false, status: 'unknown', reason: 'TOWER_BUILD_UNKNOWN' }), apiRegistry: [{ id: 'api-runtime', registered: true }, { id: 'api-config', registered: false }, { id: 'api-components', registered: true, probe: async () => true }] });
  assert.equal(component(result, 'api-runtime').code, 'API_REGISTERED_UNPROBED'); assert.equal(component(result, 'api-config').code, 'API_NOT_REGISTERED'); assert.equal(component(result, 'api-components').status, 'ok');
  assert.equal(component(result, 'framework-compatibility').status, 'unknown'); assert.equal(result.actions.support.available, false);
  const duplicate = await f.inspect({ apiRegistry: [{ id: 'api-runtime', registered: true, probe: async () => true }, { id: 'api-runtime', registered: true, probe: async () => true }] }); assert.equal(component(duplicate, 'api-runtime').code, 'API_REGISTRY_INVALID');
});

test('reader failures do not expose raw diagnostics and degraded checks preserve independent results', async t => {
  const f = await fixture(t), failure = async () => { throw new Error('EXAMPLE_PRIVATE_TOKEN_AND_PATH'); };
  const result = await f.inspect({ readRuntime: failure, readConfig: failure, readUpdates: failure, readIsland: failure, readCompatibility: async () => ({ compatible: false, status: 'incompatible', reason: 'PLUGIN_INCOMPATIBLE', declared: { password: 'EXAMPLE_PRIVATE_TOKEN_AND_PATH' }, observed: { cookie: 'EXAMPLE_PRIVATE_TOKEN_AND_PATH', towerBuild: '4.9.0' } }) });
  assert.equal(component(result, 'runtime').status, 'unknown'); assert.equal(component(result, 'code-integrity').status, 'ok'); assert.equal(component(result, 'package-store').status, 'ok'); assert.equal(component(result, 'storage').status, 'warning');
  assert.equal(component(result, 'framework-compatibility').status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE_TOKEN_AND_PATH|password|cookie|stack/);
});

test('package pointers are bounded and integrity validation supports readable legacy packages', async t => {
  const f = await fixture(t);
  assert.equal(component(await f.inspect(), 'package-store').status, 'ok');
  const invalid = await f.inspect({ readPlugins: async () => [{ ...f.plugins[0], packageId: '../private' }] }); assert.equal(component(invalid, 'package-store').code, 'PACKAGE_POINTER_INVALID');
  const oversized = await f.inspect({ readPlugins: async () => Array.from({ length: 501 }, (_, index) => ({ ...f.plugins[0], id: `rivetin-example-${index}` })) }); assert.equal(component(oversized, 'package-store').code, 'INSPECTION_LIMIT');
  const file = path.join(f.options.dataDirectory, 'packages', f.packageId + '.json'); await writeFile(file, 'EXAMPLE_CHANGED_PACKAGE'); assert.equal(component(await f.inspect(), 'package-store').code, 'PACKAGE_INTEGRITY_MISMATCH');
});

test('single package size and total package budget fail unknown without pretending a complete check', async t => {
  const f = await fixture(t), file = path.join(f.options.dataDirectory, 'packages', f.packageId + '.json');
  await truncate(file, 16 * 1024 * 1024 + 1);
  assert.equal(component(await f.inspect(), 'package-store').code, 'INSPECTION_LIMIT');
  const extra = Buffer.alloc(1024 * 1024), rows = [];
  for (let index = 0; index < 3; index++) {
    const id = `rivetin-size-example-${index}`, bytes = bundle(id, '0.1.0', pkg => { for (let file = 0; file < 8; file++) pkg.files.push({ path: `web/extra-${file}.json`, sha256: sha(extra), data: extra.toString('base64') }); return pkg; }), packageId = sha(bytes);
    await writeFile(path.join(f.options.dataDirectory, 'packages', packageId + '.json'), bytes); rows.push({ id, version: '0.1.0', installed: true, packageId });
  }
  const result = await f.inspect({ readPlugins: async () => rows });
  assert.equal(component(result, 'package-store').status, 'unknown', JSON.stringify(component(result, 'package-store'))); assert.equal(component(result, 'package-store').code, 'INSPECTION_LIMIT');
});

test('unknown plugin compatibility cannot claim active and SMTX observation contains counts only', async t => {
  const f = await fixture(t), snapshot = { trusted: true, complete: true, checkedAt: new Date(clock).toISOString(), clusters: [{ product: 'SMTX_OS', version: '6.3.0', id: 'EXAMPLE_PRIVATE_CLUSTER_ID', name: 'EXAMPLE_PRIVATE_CLUSTER_NAME' }] };
  const result = await f.inspect({ readPlugins: async () => [{ ...f.plugins[0], manifest: { ...f.plugins[0].manifest, compatibility: { frameworkApi: 1, frameworkMinVersion: '0.1.0', frameworkMaxVersionExclusive: '0.2.0', towerBuilds: ['4.9.0'] } }, compatibility: { compatible: false, status: 'unknown', reason: 'SMTX_SNAPSHOT_EXPIRED' } }], readCompatibility: async () => ({ ...compatible, observed: { ...compatible.observed, smtx: snapshot } }) });
  assert.equal(result.plugins[0].active, false); assert.equal(result.plugins[0].compatibility.status, 'unknown');
  assert.equal(result.plugins[0].compatibility.declared.frameworkMinVersion, '0.1.0');
  assert.deepEqual(result.framework.compatibility.observed.smtxVersions, ['6.3.0']);
  assert.equal(result.framework.compatibility.observed.clusterCount, 1); assert.equal(result.framework.compatibility.observed.smtxClusterCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE_CLUSTER/);
});

test('concurrent same-actor inspections coalesce and return isolated copies without filesystem mutations', async t => {
  const f = await fixture(t); let calls = 0;
  async function inventory(root) { const entries = await readdir(root, { withFileTypes: true }), output = []; for (const entry of entries) { const p = path.join(root, entry.name); if (entry.isDirectory()) output.push(...(await inventory(p)).map(([name, digest]) => [`${entry.name}/${name}`, digest])); else output.push([entry.name, sha(await readFile(p))]); } return output.sort(); }
  const before = await inventory(f.root), actor = { id: 'example-admin', source: 'tower', role: 'ROOT', admin: true };
  const inspector = createComponentInspector({ ...f.options, readRuntime: async ({ actor: caller }) => { calls++; assert.equal(caller, actor); await new Promise(resolve => setTimeout(resolve, 10)); return { version, enabled: true }; } });
  const [a, b] = await Promise.all([inspector.inspect({ actor }), inspector.inspect({ actor })]); assert.equal(calls, 1); a.plugins[0].name['en-US'] = 'CHANGED'; assert.equal(b.plugins[0].name['en-US'], 'Example plugin'); assert.deepEqual(await inventory(f.root), before);
});

test('timed out readers are unknown, late values do not overwrite results, and total inspection is bounded', async t => {
  const f = await fixture(t); let release;
  const start = Date.now(); const result = await f.inspect({ readRuntime: () => new Promise(resolve => { release = resolve; }) });
  assert.ok(Date.now() - start < 5000); assert.equal(component(result, 'runtime').code, 'READER_TIMEOUT');
  release({ version, enabled: true, token: 'EXAMPLE_PRIVATE_TOKEN' }); await new Promise(setImmediate); assert.equal(component(result, 'runtime').code, 'READER_TIMEOUT'); assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE_TOKEN/);
});

test('the overall five-second deadline bounds queued API probes and keeps completed independent checks', async t => {
  const f = await fixture(t), apiRegistry = ['api-runtime', 'api-plugins', 'api-config', 'api-components', 'api-support', 'api-ssh', 'api-smart', 'api-resources', 'api-market'].map(id => ({ id, registered: true, probe: () => new Promise(() => {}) }));
  const start = Date.now(), result = await f.inspect({ apiRegistry });
  assert.ok(Date.now() - start < 5500); assert.equal(component(result, 'code-integrity').status, 'ok'); assert.equal(component(result, 'gateway').status, 'unknown'); assert.equal(result.actions.support.available, false);
  assert.ok(result.components.some(row => row.code === 'READER_TIMEOUT' || row.code === 'INSPECTION_TIMEOUT'));
});
