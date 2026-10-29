import path from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validatePackage } from './manifest.js';
import { validId } from '../shared/identity.js';

const MiB = 1024 * 1024;
const versionToken = value => typeof value === 'string' && value === value.trim() && value.length <= 100 && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(value);
const digestToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).sort().join() === [...fields].sort().join();
const error = code => Object.assign(new Error(code), { inspectionCode: code });
const hash = value => createHash('sha256').update(value).digest('hex');
const kinds = ['runtime', 'framework-compatibility', 'code-integrity', 'storage', 'audit', 'update-source', 'package-store', 'island-registration', 'gateway', 'api-runtime', 'api-plugins', 'api-config', 'api-components', 'api-support', 'api-ssh', 'api-resources', 'api-market'];
const labels = {
  runtime: ['框架运行时', 'Framework runtime'], 'framework-compatibility': ['框架兼容性', 'Framework compatibility'],
  'code-integrity': ['代码完整性', 'Code integrity'], storage: ['配置存储', 'Configuration storage'], audit: ['操作日志存储', 'Activity log storage'],
  'update-source': ['更新源', 'Update source'], 'package-store': ['插件包存储', 'Plugin package storage'], 'island-registration': ['Island 注册', 'Island registration'], gateway: ['部署网关', 'Deployment gateway'],
  'api-runtime': ['运行状态 API', 'Runtime API'], 'api-plugins': ['插件管理 API', 'Plugin management API'], 'api-config': ['配置 API', 'Configuration API'],
  'api-components': ['组件状态 API', 'Component status API'], 'api-support': ['支持包 API', 'Support bundle API'], 'api-ssh': ['SSH 通道 API', 'SSH channel API'],
  'api-resources': ['对象操作 API', 'Resource actions API'], 'api-market': ['插件市场 API', 'Plugin marketplace API'],
};
const compatibilityCodes = new Set(['TOWER_BUILD_UNKNOWN', 'FRAMEWORK_TOWER_INCOMPATIBLE', 'FRAMEWORK_VERSION_UNKNOWN', 'PLUGIN_COMPATIBILITY_UNDECLARED', 'PLUGIN_COMPATIBILITY_INVALID', 'PLUGIN_INCOMPATIBLE', 'SMTX_SNAPSHOT_UNAVAILABLE', 'SMTX_SNAPSHOT_INVALID', 'SMTX_SCOPE_UNTRUSTED', 'SMTX_SCOPE_INCOMPLETE', 'SMTX_SNAPSHOT_EXPIRED', 'SMTX_VERSION_UNKNOWN', 'SMTX_SCOPE_EMPTY', 'SMTX_INCOMPATIBLE', 'SMTX_AUTHORITY_REQUIRED', 'SMTX_INVENTORY_LIMIT', 'SMTX_INVENTORY_INVALID', 'SMTX_CLUSTER_UNAVAILABLE', 'SMTX_INVENTORY_UNAVAILABLE', 'SMTX_CHECK_TIMEOUT', 'SMTX_CHECK_CANCELLED']);

function declaration(value) {
  if (!object(value)) return null;
  const out = {};
  for (const key of ['schemaVersion', 'frameworkApi']) if (Number.isSafeInteger(value[key])) out[key] = value[key];
  for (const key of ['frameworkVersion', 'frameworkMinVersion']) if (versionToken(value[key])) out[key] = value[key];
  if (Array.isArray(value.towerBuilds) && value.towerBuilds.length <= 20 && value.towerBuilds.every(versionToken)) out.towerBuilds = [...value.towerBuilds];
  if (value.smtx === 'none') out.smtx = 'none';
  else if (object(value.smtx) && value.smtx.product === 'SMTX_OS' && value.smtx.scope === 'all-managed-product-clusters' && Array.isArray(value.smtx.builds) && value.smtx.builds.length <= 20 && value.smtx.builds.every(versionToken)) out.smtx = { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: [...value.smtx.builds] };
  return out;
}
function compatibility(value) {
  const status = ['compatible', 'incompatible', 'unknown'].includes(value?.status) ? value.status : 'unknown';
  const out = { compatible: status === 'compatible' && value?.compatible === true, status, reason: compatibilityCodes.has(value?.reason) ? value.reason : status === 'compatible' && value?.compatible === true ? null : 'COMPATIBILITY_UNKNOWN' };
  if (status === 'compatible' && !out.compatible) out.status = 'unknown';
  const declared = declaration(value?.declared); if (declared) out.declared = declared;
  const observed = {};
  if (versionToken(value?.observed?.frameworkVersion)) observed.frameworkVersion = value.observed.frameworkVersion;
  const towerVersion = value?.observed?.towerVersion ?? value?.observed?.towerBuild;
  if (versionToken(towerVersion)) observed.towerVersion = towerVersion;
  if (Array.isArray(value?.observed?.smtxVersions) && value.observed.smtxVersions.length <= 500 && value.observed.smtxVersions.every(versionToken)) observed.smtxVersions = [...new Set(value.observed.smtxVersions)].sort();
  for (const key of ['clusterCount', 'smtxClusterCount']) if (Number.isSafeInteger(value?.observed?.[key]) && value.observed[key] >= 0 && value.observed[key] <= 500) observed[key] = value.observed[key];
  const smtx = value?.observed?.smtx;
  if (object(smtx) && typeof smtx.trusted === 'boolean' && typeof smtx.complete === 'boolean' && typeof smtx.checkedAt === 'string' && smtx.checkedAt.length <= 30 && Number.isFinite(Date.parse(smtx.checkedAt)) && Array.isArray(smtx.clusters) && smtx.clusters.length <= 500) {
    const counts = new Map();
    for (const row of smtx.clusters) if (['SMTX_OS', 'SMTX_ELF', 'SMTX_ZBS', 'BLUESHARK'].includes(row?.product) && versionToken(row.version)) { const key = row.product + ':' + row.version; const current = counts.get(key); counts.set(key, { product: row.product, version: row.version, count: (current?.count || 0) + 1 }); }
    if ([...counts.values()].reduce((sum, row) => sum + row.count, 0) === smtx.clusters.length) {
      observed.clusterCount = smtx.clusters.length;
      const matching = [...counts.values()].filter(row => row.product === 'SMTX_OS');
      observed.smtxClusterCount = matching.reduce((sum, row) => sum + row.count, 0);
      observed.smtxVersions = [...new Set(matching.map(row => row.version))].sort();
    }
  }
  if (Object.keys(observed).length) out.observed = observed;
  return out;
}
function publicName(value, id) {
  const text = item => typeof item === 'string' && item.length > 0 && item.length <= 120 && !/[\x00-\x1f\x7f]/.test(item) ? item : id;
  return { 'zh-CN': text(value?.['zh-CN']), 'en-US': text(value?.['en-US']) };
}
function safeRelative(value) {
  return typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value) && value.split('/').every(part => !['.', '..'].includes(part) && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part));
}
async function securePath(root, relative, alive) {
  if (!root || !safeRelative(relative)) throw error('INSPECTION_PATH_INVALID');
  const absolute = path.resolve(root); let current = absolute;
  const base = await lstat(absolute); alive();
  if (!base.isDirectory() || base.isSymbolicLink() || await realpath(absolute) !== absolute) throw error('INSPECTION_PATH_UNSAFE'); alive();
  for (const part of relative.split('/')) {
    current = path.join(current, part); const info = await lstat(current); alive();
    if (info.isSymbolicLink()) throw error('INSPECTION_PATH_UNSAFE');
    if (current !== path.join(absolute, ...relative.split('/')) && !info.isDirectory()) throw error('INSPECTION_PATH_UNSAFE');
  }
  if (await realpath(current) !== current) throw error('INSPECTION_PATH_UNSAFE'); alive(); return current;
}
async function readBounded(root, relative, limit, budget, alive) {
  alive(); const file = await securePath(root, relative, alive);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    alive(); const info = await handle.stat(); alive();
    if (!info.isFile()) throw error('INSPECTION_PATH_UNSAFE');
    if (info.size > limit || info.size > budget.remaining) throw error('INSPECTION_LIMIT');
    budget.remaining -= info.size;
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) { alive(); const read = await handle.read(bytes, offset, bytes.length - offset, offset); alive(); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await handle.stat(); alive();
    if (offset !== info.size || after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev || await realpath(file) !== file) throw error('INSPECTION_FILE_CHANGED');
    alive(); return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function codeIntegrity(root, version, alive) {
  let bytes;
  try { bytes = await readBounded(root, 'integrity.json', 128 * 1024, { remaining: 128 * 1024 }, alive); }
  catch (failure) { if (failure.code === 'ENOENT') return { status: 'unknown', code: 'CODE_MANIFEST_UNAVAILABLE' }; throw failure; }
  let manifest; try { manifest = JSON.parse(bytes); } catch { return { status: 'failed', code: 'CODE_MANIFEST_INVALID' }; }
  if (!exact(manifest, ['schemaVersion', 'frameworkVersion', 'files']) || manifest.schemaVersion !== 1 || manifest.frameworkVersion !== version || !Array.isArray(manifest.files) || !manifest.files.length) return { status: 'failed', code: 'CODE_MANIFEST_INVALID' };
  if (manifest.files.length > 200) return { status: 'unknown', code: 'INSPECTION_LIMIT' };
  const names = new Set(); let total = 0;
  for (const row of manifest.files) {
    if (!exact(row, ['path', 'sha256', 'bytes']) || !safeRelative(row.path) || row.path.toLowerCase() === 'integrity.json' || names.has(row.path.toLowerCase()) || !digestToken(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) return { status: 'failed', code: 'CODE_MANIFEST_INVALID' };
    if (row.bytes > 16 * MiB || (total += row.bytes) > 32 * MiB) return { status: 'unknown', code: 'INSPECTION_LIMIT' };
    names.add(row.path.toLowerCase());
  }
  const budget = { remaining: 32 * MiB };
  for (const row of manifest.files) {
    const content = await readBounded(root, row.path, 16 * MiB, budget, alive);
    if (content.length !== row.bytes || hash(content) !== row.sha256) return { status: 'failed', code: 'CODE_INTEGRITY_MISMATCH' };
  }
  return { status: 'ok', code: null, checks: { files: names.size, bytes: total } };
}

function deploymentObservation(value, fallback) {
  const codes = new Set(['DEPLOYMENT_PROBE_AUTH_UNAVAILABLE', 'DEPLOYMENT_PROBE_FORBIDDEN', 'DEPLOYMENT_PROBE_TIMEOUT', 'ISLAND_UNOBSERVABLE', 'ISLAND_REGISTRY_INVALID', 'ISLAND_REGISTRATION_MISSING', 'ISLAND_REGISTRATION_MISMATCH', 'ISLAND_REGISTRY_UNAVAILABLE', 'GATEWAY_ORIGIN_UNAVAILABLE', 'GATEWAY_HTTP_FAILED', 'GATEWAY_RESPONSE_MISMATCH', 'GATEWAY_TLS_UNTRUSTED', 'GATEWAY_UNREACHABLE']);
  for (const reason of ['GATEWAY_TRUST_INVALID', 'GATEWAY_PIN_MISMATCH', 'GATEWAY_CERT_VALIDITY_INVALID']) codes.add(reason);
  if (typeof value?.available !== 'boolean' || typeof value?.matched !== 'boolean') return { status: 'unknown', code: fallback };
  return { status: value.available ? value.matched ? 'ok' : 'failed' : 'unknown', code: value.available && value.matched ? null : codes.has(value.code) ? value.code : fallback };
}

export function createComponentInspector({ dataDirectory, codeDirectory, version, readRuntime, readPlugins, readConfig, readCompatibility, readUpdates, readIsland, readGateway, apiRegistry = [], maintenanceActions = {}, now = Date.now } = {}) {
  const pending = new Map(), noActor = Symbol('anonymous');
  const limitations = ['NO_KUBERNETES_AUTHORITY', 'NO_HOST_COMMANDS', 'READ_ONLY_STORAGE_ACCESS_CHECK', 'LOCAL_MANIFEST_NOT_SIGNATURE_PROOF', 'NO_BROKER_STATUS_OR_SYNC', 'CLI_REQUIRED_FOR_DEPLOYMENT_REPAIR'];
  const base = () => new Map(kinds.map(id => [id, { id, label: { 'zh-CN': labels[id][0], 'en-US': labels[id][1] }, kind: id.startsWith('api-') ? 'api' : id === 'storage' || id === 'audit' || id === 'package-store' ? 'storage' : 'component', status: 'unknown', code: 'COMPONENT_UNCHECKED', dependsOn: id.startsWith('api-') ? ['runtime'] : id === 'runtime' ? ['framework-compatibility', 'code-integrity', 'storage'] : ['audit', 'package-store'].includes(id) ? ['storage'] : [] }]));
  const empty = code => ({ schemaVersion: 1, checkedAt: new Date(now()).toISOString(), overall: 'unknown', framework: { version: versionToken(version) ? version : null, enabled: false, compatibility: compatibility(null) }, components: [...base().values()].map(row => ({ ...row, code })), plugins: [], actions: { repair: { available: false, reason: code }, reset: { available: false, reason: code }, support: { available: false, reason: code } }, limitations: [...limitations] });
  async function run({ fresh, actor }) {
    const started = Date.now(), components = base(); let stopped = false, timer;
    const alive = () => { if (stopped || Date.now() - started >= 5000) throw error('INSPECTION_TIMEOUT'); };
    const mark = (id, value) => { if (!stopped) Object.assign(components.get(id), value); };
    const reader = async fn => {
      if (typeof fn !== 'function') return { ok: false, code: 'READER_UNAVAILABLE' };
      let deadline;
      try { const result = await Promise.race([Promise.resolve().then(() => { alive(); return fn({ fresh, actor }); }).then(value => ({ ok: true, value })), new Promise(resolve => { deadline = setTimeout(() => resolve({ ok: false, code: 'READER_TIMEOUT' }), 2000); })]); alive(); return result; }
      catch { return { ok: false, code: 'READER_FAILED' }; }
      finally { clearTimeout(deadline); }
    };
    const fsCheck = async (id, task) => {
      try { mark(id, await task()); }
      catch (failure) { mark(id, { status: failure.inspectionCode === 'INSPECTION_LIMIT' || failure.inspectionCode === 'INSPECTION_TIMEOUT' ? 'unknown' : 'failed', code: failure.inspectionCode || 'FILESYSTEM_CHECK_FAILED' }); }
    };
    let runtime, pluginResult, configResult, compatibilityResult, storageWritable = false;
    const tasks = [
      reader(readRuntime).then(value => { runtime = value; mark('runtime', value.ok && typeof value.value?.enabled === 'boolean' && value.value.version === version ? { status: value.value.enabled ? 'ok' : 'disabled', code: null } : { status: 'unknown', code: value.code || 'RUNTIME_INVALID' }); }),
      reader(readPlugins).then(value => { pluginResult = value; }), reader(readConfig).then(value => { configResult = value; }),
      reader(readCompatibility).then(value => { compatibilityResult = value; const projected = compatibility(value.ok ? value.value : null); mark('framework-compatibility', { status: projected.status === 'compatible' && projected.compatible ? 'ok' : projected.status === 'incompatible' ? 'failed' : 'unknown', code: projected.reason }); }),
      reader(readUpdates).then(value => { mark('update-source', value.ok && typeof value.value?.reachable === 'boolean' ? { status: value.value.reachable ? 'ok' : 'warning', code: value.value.reachable ? null : 'UPDATE_SOURCE_UNAVAILABLE' } : { status: 'unknown', code: value.code || 'UPDATE_STATUS_INVALID' }); }),
      reader(readIsland).then(value => { mark('island-registration', value.ok ? deploymentObservation(value.value, 'ISLAND_UNOBSERVABLE') : { status: 'unknown', code: value.code || 'ISLAND_UNOBSERVABLE' }); }),
      reader(readGateway).then(value => { mark('gateway', value.ok ? deploymentObservation(value.value, 'GATEWAY_UNREACHABLE') : { status: 'unknown', code: value.code || 'GATEWAY_UNREACHABLE' }); }),
      fsCheck('storage', async () => { alive(); const info = await lstat(dataDirectory); alive(); if (!info.isDirectory() || info.isSymbolicLink()) throw error('STORAGE_PATH_UNSAFE'); await access(dataDirectory, constants.R_OK | constants.W_OK); alive(); storageWritable = true; return { status: 'ok', code: null, checks: { readable: true, writable: true } }; }),
      fsCheck('audit', async () => { try { const file = await securePath(dataDirectory, 'audit.jsonl', alive); const info = await lstat(file); alive(); if (!info.isFile()) throw error('AUDIT_PATH_UNSAFE'); return { status: 'ok', code: null, checks: { bytes: info.size } }; } catch (failure) { if (failure.code === 'ENOENT') return { status: 'unknown', code: 'AUDIT_UNAVAILABLE' }; throw failure; } }),
      fsCheck('code-integrity', () => codeIntegrity(codeDirectory, version, alive)),
    ];
    const work = async () => {
      await Promise.all(tasks); alive();
      const rows = pluginResult?.ok ? Array.isArray(pluginResult.value) ? pluginResult.value : pluginResult.value?.items : null;
      const plugins = []; let validRows = Array.isArray(rows) && rows.length <= 500;
      const ids = new Set();
      if (validRows) for (const row of rows) {
        if (!validId(row?.id) || ids.has(row.id)) { validRows = false; break; } ids.add(row.id);
        const detail = object(row.compatibility) ? row.compatibility : row;
        const compatible = compatibility({ ...detail, declared: detail.declared || row.manifest?.compatibility });
        plugins.push({ id: row.id, name: publicName(row.manifest?.name || row.name, row.id), version: versionToken(row.version) ? row.version : null, enabled: row.enabled === true, active: row.active === true && compatible.compatible, compatibility: compatible });
      }
      if (!validRows) mark('package-store', { status: 'unknown', code: Array.isArray(rows) && rows.length > 500 ? 'INSPECTION_LIMIT' : 'PLUGIN_INVENTORY_UNAVAILABLE' });
      else await fsCheck('package-store', async () => {
        const packages = [...new Set(rows.filter(row => row.installed === true).map(row => row.packageId))];
        if (packages.some(digest => !digestToken(digest))) return { status: 'failed', code: 'PACKAGE_POINTER_INVALID' };
        const budget = { remaining: 32 * MiB }; let checked = 0;
        for (const digest of packages) {
          const bytes = await readBounded(dataDirectory, `packages/${digest}.json`, 16 * MiB, budget, alive);
          if (hash(bytes) !== digest) return { status: 'failed', code: 'PACKAGE_INTEGRITY_MISMATCH' };
          let pkg; try { pkg = validatePackage(bytes); } catch { return { status: 'failed', code: 'PACKAGE_INVALID' }; }
          if (rows.some(row => row.installed === true && row.packageId === digest && (row.id !== pkg.manifest.id || row.version !== pkg.manifest.version))) return { status: 'failed', code: 'PACKAGE_POINTER_MISMATCH' };
          checked++;
        }
        return { status: 'ok', code: null, checks: { packages: checked, bytes: 32 * MiB - budget.remaining } };
      });
      const config = configResult?.ok ? configResult.value : null;
      if (object(config?.plugins) && Object.keys(config.plugins).length <= 500) {
        const revisions = [];
        for (const [id, value] of Object.entries(config.plugins)) if (validId(id) && Number.isSafeInteger(value?.revision) && value.revision >= 0 && Number.isSafeInteger(value?.schemaVersion) && value.schemaVersion > 0) revisions.push({ id, revision: value.revision, schemaVersion: value.schemaVersion });
        mark('storage', { checks: { ...components.get('storage').checks, configurations: revisions } });
        if (storageWritable && (revisions.length !== Object.keys(config.plugins).length || Object.keys(object(config.errors) ? config.errors : {}).length)) mark('storage', { status: 'warning', code: 'CONFIGURATION_METADATA_INVALID' });
      } else if (storageWritable) mark('storage', { status: 'warning', code: 'CONFIGURATION_STATUS_UNAVAILABLE' });
      const registry = Array.isArray(apiRegistry) && apiRegistry.length <= 32 ? apiRegistry : [];
      if (registry !== apiRegistry) for (const id of kinds.filter(value => value.startsWith('api-'))) mark(id, { status: 'unknown', code: 'API_REGISTRY_INVALID' });
      const duplicate = new Set(); const jobs = [];
      for (const item of registry) {
        if (!kinds.includes(item?.id) || !item.id.startsWith('api-') || duplicate.has(item.id)) continue; duplicate.add(item.id);
        if (registry.filter(row => row?.id === item.id).length !== 1) { mark(item.id, { status: 'unknown', code: 'API_REGISTRY_INVALID' }); continue; }
        if (item.registered !== true) mark(item.id, { status: 'unknown', code: 'API_NOT_REGISTERED' });
        else if (typeof item.probe !== 'function') mark(item.id, { status: 'unknown', code: 'API_REGISTERED_UNPROBED' });
        else jobs.push(async () => { const result = await reader(item.probe); mark(item.id, result.ok && result.value === true ? { status: 'ok', code: null } : result.ok && item.id === 'api-components' ? deploymentObservation(result.value, 'API_PROBE_UNCONFIRMED') : { status: 'unknown', code: result.code || 'API_PROBE_UNCONFIRMED' }); });
      }
      let cursor = 0;
      await Promise.all([0, 1, 2, 3].map(async () => { while (cursor < jobs.length) { alive(); await jobs[cursor++](); } }));
      alive(); const rowsOut = [...components.values()]; const comp = compatibility(compatibilityResult?.ok ? compatibilityResult.value : null);
      const action = (available, reason) => ({ available, reason: available ? null : reason });
      const status = rowsOut.some(row => row.status === 'failed') ? 'failed' : rowsOut.some(row => row.status === 'warning' || row.status === 'unknown') ? 'warning' : 'ok';
      return { schemaVersion: 1, checkedAt: new Date(now()).toISOString(), overall: status, framework: { version: versionToken(version) ? version : null, enabled: runtime?.ok && runtime.value?.enabled === true, compatibility: comp }, components: rowsOut, plugins: validRows ? plugins : [], actions: { repair: action(maintenanceActions.repair === true && storageWritable, 'CLI_OR_MAINTENANCE_REQUIRED'), reset: action(maintenanceActions.reset === true && storageWritable, 'MAINTENANCE_UNAVAILABLE'), support: action(components.get('api-support').status === 'ok', 'SUPPORT_API_UNCONFIRMED') }, limitations: [...limitations] };
    };
    try { return await Promise.race([work(), new Promise(resolve => { timer = setTimeout(() => { stopped = true; const partial = empty('INSPECTION_TIMEOUT'); partial.components = [...components.values()].map(row => ({ ...row })); partial.overall = partial.components.some(row => row.status === 'failed') ? 'failed' : 'warning'; resolve(partial); }, 5000); })]); }
    catch { const partial = empty('INSPECTION_FAILED'); partial.components = [...components.values()].map(row => ({ ...row })); return partial; }
    finally { stopped = true; clearTimeout(timer); }
  }
  return { async inspect({ fresh = false, actor } = {}) {
    const key = actor ? `${actor.source || ''}:${actor.id || ''}:${actor.role || ''}:${actor.admin === true}:${fresh === true}` : noActor;
    if (!pending.has(key)) {
      if (pending.size >= 2) return empty('INSPECTION_BUSY');
      const job = run({ fresh: fresh === true, actor }); pending.set(key, job); job.finally(() => pending.delete(key)).catch(() => {});
    }
    return structuredClone(await pending.get(key));
  } };
}
