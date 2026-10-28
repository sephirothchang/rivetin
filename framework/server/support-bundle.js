import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { FRAMEWORK_VERSION } from '../shared/version.js';
import { validId } from '../shared/identity.js';

export const SUPPORT_LIMITS = Object.freeze({ plugins: 500, logs: 1000, components: 100, jsonBytes: 2 * 1024 * 1024, gzipBytes: 1024 * 1024 });
export const SUPPORT_COMPONENT_IDS = Object.freeze(['runtime', 'framework-compatibility', 'code-integrity', 'storage', 'audit', 'update-source', 'package-store', 'island-registration', 'gateway', 'api-runtime', 'api-plugins', 'api-config', 'api-components', 'api-support', 'api-ssh', 'api-smart', 'api-resources', 'api-market']);
const componentIds = new Set(SUPPORT_COMPONENT_IDS);
const statuses = new Set(['ok', 'warning', 'ready', 'running', 'enabled', 'disabled', 'unavailable', 'failed', 'degraded', 'unknown', 'blocked', 'pending', 'not-installed', 'incompatible']);
const auditStates = new Set(['pending', 'local-only', 'confirmed', 'permission-denied', 'failed']);
const results = new Set(['success', 'failed', 'started']);
const actions = new Set(['framework.install', 'framework.upgrade', 'framework.update', 'framework.uninstall', 'framework.rollback', 'framework.migrate', 'framework.enable', 'framework.disable', 'package.upload', 'plugin.install', 'plugin.update', 'plugin.download', 'plugin.enable', 'plugin.disable', 'plugin.reset', 'plugin.uninstall', 'plugin.rollback', 'configuration.save', 'configuration.migrate', 'market.install', 'updates.check', 'ssh.approve', 'ssh.revoke', 'ssh.run', 'ssh.schedule', 'ssh.host.save', 'ssh.host.remove', 'ssh.connections.save', 'ssh.preflight.discover', 'ssh.preflight.confirm', 'ssh.preflight.verify', 'smart.bind', 'smart.unbind', 'smart.collect', 'smart.collect-all', 'support.export', 'components.support', 'components.repair', 'components.reset']);
const codes = new Set(['UNKNOWN_CODE', 'OPERATION_FAILED', 'AUTHENTICATION_REQUIRED', 'ADMIN_REQUIRED', 'FORBIDDEN', 'INVALID_SETTINGS', 'CONFIGURATION_INVALID', 'CONFIGURATION_UNAVAILABLE', 'STORE_BUSY', 'STORE_CORRUPTED', 'MIGRATION_REQUIRED', 'FRAMEWORK_MIGRATION_REQUIRED', 'FRAMEWORK_DISABLE_BEFORE_UPGRADE', 'FRAMEWORK_NOT_INITIALIZED', 'FRAMEWORK_DISABLED', 'PLUGIN_INCOMPATIBLE', 'PLUGIN_COMPATIBILITY_UNDECLARED', 'PLUGIN_UNAVAILABLE', 'PLUGIN_NOT_INSTALLED', 'PLUGIN_DISABLED', 'PLUGIN_ID_MISMATCH', 'PLUGIN_LIFECYCLE_CHANGED', 'VERSION_ALREADY_INSTALLED', 'UPDATE_VERSION_MUST_INCREASE', 'NO_PREVIOUS_VERSION', 'INVALID_PACKAGE', 'INVALID_MANIFEST', 'PACKAGE_INTEGRITY_FAILED', 'PACKAGE_TOO_LARGE', 'CONFIGURATION_CHANGED', 'HOST_PROFILE_CHANGED', 'CONNECTION_SETTINGS_CHANGED', 'TOWER_BUILD_UNKNOWN', 'TOWER_REQUEST_FAILED', 'TOWER_AUDIT_FAILED', 'TOWER_AUDIT_NOT_CONFIRMED', 'TOWER_AUDIT_SYSTEM_USER_REQUIRED', 'TOWER_AUDIT_TIMEOUT', 'TOWER_AUDIT_TASK_PENDING', 'UPDATE_SOURCE_ACCESS_REQUIRED', 'UPDATE_SOURCE_UNAVAILABLE', 'UPDATE_SOURCE_RATE_LIMITED', 'UPDATE_CHECKSUM_FAILED', 'UPDATE_CATALOG_INVALID', 'UPDATE_PACKAGE_UNPUBLISHED', 'UPDATE_NOT_AVAILABLE', 'EACCES', 'ENOSPC', 'EIO', 'SSH_CHANNEL_DISABLED', 'SSH_AUTHENTICATION_FAILED', 'SSH_HOST_KEY_MISMATCH', 'SSH_CONNECTION_FAILED', 'SSH_CONNECTION_CLOSED', 'SSH_KEY_UNAVAILABLE', 'SSH_UNAVAILABLE', 'SSH_TIMEOUT', 'SSH_ABORTED', 'SSH_APPROVAL_REQUIRED', 'SSH_APPROVAL_CHANGED', 'SSH_REGISTRATION_CHANGED', 'SSH_REMOTE_COMMAND_FAILED', 'SSH_OUTPUT_LIMIT', 'SSH_RUN_BUSY', 'SSH_PREFLIGHT_FAILED', 'SSH_PREFLIGHT_TIMEOUT', 'SSH_PREFLIGHT_CANCELLED', 'SSH_PREFLIGHT_BUSY', 'SSH_PREFLIGHT_TARGET_CHANGED', 'SSH_PREFLIGHT_CONNECTION_CHANGED', 'SMART_NO_SAMPLE', 'SMART_DISK_UNBOUND', 'SMART_GENERATION_CHANGED', 'SMART_COLLECTION_FAILED', 'SMART_UNSUPPORTED', 'SMART_IDENTITY_MISMATCH', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID', 'SMART_BATCH_NO_TARGETS', 'SMART_BATCH_NO_APPROVED_TARGETS', 'SMART_BATCH_TARGET_LIMIT', 'SMART_BATCH_DEADLINE', 'FRAMEWORK_TOWER_INCOMPATIBLE', 'FRAMEWORK_VERSION_UNKNOWN', 'PLUGIN_COMPATIBILITY_INVALID', 'SMTX_SNAPSHOT_UNAVAILABLE', 'SMTX_SNAPSHOT_INVALID', 'SMTX_SCOPE_UNTRUSTED', 'SMTX_SCOPE_INCOMPLETE', 'SMTX_SNAPSHOT_EXPIRED', 'SMTX_VERSION_UNKNOWN', 'SMTX_SCOPE_EMPTY', 'SMTX_INCOMPATIBLE', 'CLI_REPAIR_REQUIRED', 'MAINTENANCE_OUTCOME_UNKNOWN', 'MAINTENANCE_BACKUP_FAILED', 'MAINTENANCE_DISABLE_FAILED', 'MAINTENANCE_REPAIR_FAILED', 'MAINTENANCE_RESET_FAILED', 'MAINTENANCE_INSPECTION_FAILED', 'MAINTENANCE_AUDIT_FAILED']);
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const buildPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
const opaquePattern = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(code); };

// Inspect descriptors, not values through getters or toJSON. Unknown data is discarded,
// but cyclic or executable inputs must still fail without invoking user code.
function inspectData(input) {
  const ancestors = new Set(); let nodes = 0, stringBytes = 0;
  function visit(value, depth) {
    if (++nodes > 100000 || depth > 24) fail('SUPPORT_INPUT_LIMIT');
    if (value === null || typeof value === 'boolean' || typeof value === 'undefined') return;
    if (typeof value === 'string') { stringBytes += Buffer.byteLength(value); if (stringBytes > 8 * 1024 * 1024) fail('SUPPORT_INPUT_LIMIT'); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('SUPPORT_INPUT_INVALID'); return; }
    if (typeof value !== 'object' || ancestors.has(value)) fail('SUPPORT_INPUT_INVALID');
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('SUPPORT_INPUT_INVALID');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 100000 - nodes) fail('SUPPORT_INPUT_LIMIT');
    ancestors.add(value);
    for (const key of keys) {
      if (typeof key !== 'string') fail('SUPPORT_INPUT_INVALID');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) fail('SUPPORT_INPUT_INVALID');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
}

function array(value, max) { if (!Array.isArray(value)) fail('SUPPORT_INPUT_INVALID'); if (value.length > max) fail('SUPPORT_SECTION_LIMIT'); for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail('SUPPORT_INPUT_INVALID'); return value; }
function optionalBoolean(value) { if (value === undefined || value === null) return null; if (typeof value !== 'boolean') fail('SUPPORT_INPUT_INVALID'); return value; }
function integer(value) { if (value === undefined || value === null) return null; if (!Number.isSafeInteger(value) || value < 0) fail('SUPPORT_INPUT_INVALID'); return value; }
function version(value, build = false) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || value.length > 100 || !(build ? buildPattern : versionPattern).test(value)) fail('SUPPORT_INPUT_INVALID'); return value; }
function pluginId(value, optional = false) { if (optional && (value === null || value === undefined)) return null; if (!validId(value)) fail('SUPPORT_INPUT_INVALID'); return value; }
function code(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^[A-Z_]{1,100}$/.test(value)) fail('SUPPORT_INPUT_INVALID'); return codes.has(value) ? value : 'UNKNOWN_CODE'; }
function timestamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) fail('SUPPORT_INPUT_INVALID'); const result = new Date(value); if (!Number.isFinite(result.getTime()) || result.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) fail('SUPPORT_INPUT_INVALID'); return result.toISOString(); }
function enumeration(value, values, fallback = null) { if (value === undefined || value === null) return fallback; if (typeof value !== 'string' || !values.has(value)) fail('SUPPORT_INPUT_INVALID'); return value; }
function digest(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('SUPPORT_INPUT_INVALID'); return value; }
function compatibility(value) {
  if (value === null || value === undefined) return null;
  if (!object(value)) fail('SUPPORT_INPUT_INVALID');
  const tested = value.towerBuilds === undefined ? [] : array(value.towerBuilds, 20).map(build => version(build, true));
  if (tested.some(item => item === null) || new Set(tested).size !== tested.length) fail('SUPPORT_INPUT_INVALID');
  return { schemaVersion: integer(value.schemaVersion), frameworkApi: integer(value.frameworkApi), towerBuilds: tested, smtx: smtxDeclaration(value.smtx), frameworkMinVersion: version(value.frameworkMinVersion), frameworkMaxVersionExclusive: version(value.frameworkMaxVersionExclusive) };
}

function smtxDeclaration(value) {
  if (value === undefined || value === null) return null;
  if (value === 'none') return 'none';
  if (!object(value) || value.product !== 'SMTX_OS' || value.scope !== 'all-managed-product-clusters') fail('SUPPORT_INPUT_INVALID');
  const builds = array(value.builds, 20).map(build => version(build, true));
  if (builds.some(item => item === null) || new Set(builds).size !== builds.length) fail('SUPPORT_INPUT_INVALID');
  return { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds };
}
function runtimeCompatibility(value) {
  if (value === undefined || value === null) return null;
  if (!object(value) || value.declared !== undefined && !object(value.declared) || value.observed !== undefined && !object(value.observed)) fail('SUPPORT_INPUT_INVALID');
  const observed = value.observed;
  const versions = observed?.smtxVersions === undefined ? [] : array(observed.smtxVersions, 500).map(build => version(build, true));
  if (versions.some(item => item === null) || new Set(versions).size !== versions.length) fail('SUPPORT_INPUT_INVALID');
  const declared = compatibility(value.declared);
  if (declared) declared.frameworkVersion = version(value.declared.frameworkVersion);
  return { compatible: optionalBoolean(value.compatible), status: enumeration(value.status, new Set(['compatible', 'incompatible', 'unknown'])), reason: code(value.reason), declared, observed: observed ? { frameworkVersion: version(observed.frameworkVersion), towerVersion: version(observed.towerVersion, true), smtxVersions: versions, clusterCount: integer(observed.clusterCount), smtxClusterCount: integer(observed.smtxClusterCount) } : null };
}

export function createSupportBundle(input, options = {}) {
  if (!object(input) || !object(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) fail('SUPPORT_INPUT_INVALID');
  for (const key of Reflect.ownKeys(options)) { const descriptor = Object.getOwnPropertyDescriptor(options, key); if (typeof key !== 'string' || !['now', 'maxJsonBytes', 'maxGzipBytes'].includes(key) || descriptor.get || descriptor.set) fail('SUPPORT_INPUT_INVALID'); }
  const { now = Date.now, maxJsonBytes = SUPPORT_LIMITS.jsonBytes, maxGzipBytes = SUPPORT_LIMITS.gzipBytes } = options;
  if (typeof now !== 'function') fail('SUPPORT_INPUT_INVALID');
  if (![maxJsonBytes, maxGzipBytes].every(value => Number.isSafeInteger(value) && value > 0) || maxJsonBytes > SUPPORT_LIMITS.jsonBytes || maxGzipBytes > SUPPORT_LIMITS.gzipBytes) fail('SUPPORT_LIMIT_INVALID');
  inspectData(input);
  if (!object(input.runtime)) fail('SUPPORT_INPUT_INVALID');
  array(input.plugins, SUPPORT_LIMITS.plugins); array(input.logs, SUPPORT_LIMITS.logs); array(input.components, SUPPORT_LIMITS.components);
  let clock; try { clock = now(); } catch { fail('SUPPORT_INPUT_INVALID'); } if (!Number.isSafeInteger(clock) || clock < 0 || clock > 253402300799999) fail('SUPPORT_INPUT_INVALID');
  const createdAt = new Date(clock).toISOString(), ids = new Set(), componentNames = new Set();
  const plugins = input.plugins.map(item => {
    if (!object(item)) fail('SUPPORT_INPUT_INVALID');
    const id = pluginId(item.id); if (ids.has(id)) fail('SUPPORT_INPUT_INVALID'); ids.add(id);
    const state = item.state === undefined ? item : item.state;
    if (!object(state) || item.manifest !== undefined && !object(item.manifest) || item.configSummary !== undefined && !object(item.configSummary)) fail('SUPPORT_INPUT_INVALID');
    const manifest = item.manifest, summary = item.configSummary;
    if (manifest?.id !== undefined && pluginId(manifest.id) !== id) fail('SUPPORT_INPUT_INVALID');
    return { id, version: version(state.version ?? manifest?.version), packageSha256: digest(state.packageId), installed: optionalBoolean(state.installed), enabled: optionalBoolean(state.enabled), active: optionalBoolean(item.active ?? state.active), compatible: optionalBoolean(item.compatible), code: code(item.error ?? item.reason), compatibility: compatibility(manifest?.compatibility), configuration: summary ? { revision: integer(summary.revision), schemaVersion: integer(summary.schemaVersion) } : null };
  });
  const components = input.components.map(item => {
    if (!object(item) || !componentIds.has(item.id) || componentNames.has(item.id)) fail('SUPPORT_COMPONENT_INVALID'); componentNames.add(item.id);
    const dependsOn = item.dependsOn === undefined ? [] : array(item.dependsOn, SUPPORT_LIMITS.components);
    if (dependsOn.some(id => !componentIds.has(id)) || new Set(dependsOn).size !== dependsOn.length) fail('SUPPORT_COMPONENT_INVALID');
    return { id: item.id, status: enumeration(item.status, statuses, 'unknown'), code: code(item.code), dependsOn: [...dependsOn] };
  });
  const actors = new Map(), events = new Map();
  const reference = (map, key, prefix) => { if (!map.has(key)) map.set(key, `${prefix}-${String(map.size + 1).padStart(4, '0')}`); return map.get(key); };
  const logs = input.logs.map((item, index) => {
    if (!object(item) || !object(item.actor) || typeof item.actor.id !== 'string' || !opaquePattern.test(item.actor.id) || item.id !== undefined && (typeof item.id !== 'string' || !opaquePattern.test(item.id))) fail('SUPPORT_INPUT_INVALID');
    if (typeof item.action !== 'string' || item.action.length > 100 || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/.test(item.action)) fail('SUPPORT_INPUT_INVALID');
    const base = item.action.endsWith('.started') ? item.action.slice(0, -8) : item.action;
    const action = actions.has(base) ? item.action : 'unknown.action';
    const actorSource = item.actor.source === undefined ? '' : enumeration(item.actor.source, new Set(['tower', 'cli', 'system', 'scheduler', 'demo']));
    return { eventRef: reference(events, item.id === undefined ? `missing:${index}` : `id:${item.id}`, 'event'), actorRef: reference(actors, JSON.stringify([actorSource, item.actor.id]), 'actor'), time: timestamp(item.time), action, result: enumeration(item.result, results), code: code(item.code), pluginId: pluginId(item.pluginId, true) };
  });
  const runtime = input.runtime;
  const document = {
    schemaVersion: 1, format: 'rivetin-support-v1', rivetinVersion: FRAMEWORK_VERSION, createdAt,
    redaction: { policyVersion: 1, projection: 'allowlist', actorAndEventReferences: 'bundle-local', rawConfiguration: false, rawDiagnostics: false },
    limits: { ...SUPPORT_LIMITS, jsonBytes: maxJsonBytes, gzipBytes: maxGzipBytes },
    framework: { compatibility: runtimeCompatibility(runtime.compatibility), version: version(runtime.version), initialized: optionalBoolean(runtime.initialized), enabled: optionalBoolean(runtime.enabled), towerBuild: version(runtime.towerBuild, true), isolation: enumeration(runtime.isolation, new Set(['TODO', 'none', 'isolated'])), audit: enumeration(runtime.audit, auditStates) },
    components: { count: components.length, items: components },
    plugins: { count: plugins.length, installedCount: plugins.filter(item => item.installed === true).length, activeCount: plugins.filter(item => item.active === true).length, compatibleCount: plugins.filter(item => item.compatible === true).length, items: plugins },
    logs: { count: logs.length, actorCount: actors.size, eventCount: events.size, items: logs },
  };
  const json = Buffer.from(JSON.stringify(document)); if (json.length > maxJsonBytes) fail('SUPPORT_JSON_LIMIT');
  const compressed = gzipSync(json, { level: 9 }); if (compressed.length > maxGzipBytes) fail('SUPPORT_GZIP_LIMIT');
  return { filename: `${createdAt.slice(0, 10).replaceAll('-', '')}-${FRAMEWORK_VERSION}.rivetin-support.json.gz`, contentType: 'application/gzip', bytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex'), data: compressed.toString('base64') };
}
