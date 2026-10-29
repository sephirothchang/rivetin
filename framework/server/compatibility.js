import { FRAMEWORK_VERSION } from '../shared/version.js';
import { FRAMEWORK_COMPATIBILITY } from '../shared/framework-compatibility.js';

const version = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const build = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validBuild = value => typeof value === 'string' && value === value.trim() && value.length <= 100 && build.test(value);
const compare = (a, b) => a.split('.').map(Number).map((value, index) => value - Number(b.split('.')[index])).find(value => value !== 0) || 0;
export const PRODUCT_SNAPSHOT_MAX_AGE_MS = 30000;
export const MINIMUM_ONLY_FRAMEWORK_VERSION = '0.2.4';
const products = new Set(['SMTX_OS', 'SMTX_ELF', 'SMTX_ZBS', 'BLUESHARK']);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const buildList = value => Array.isArray(value) && value.length <= 20 && value.every(validBuild) && new Set(value).size === value.length;
const result = (status, reason, testedBuilds) => ({ compatible: status === 'compatible', status, reason, testedBuilds: [...testedBuilds] });

export function validateCompatibility(value) {
  if (!object(value) || value.frameworkApi !== 1 || typeof value.tower !== 'string' || !value.tower.trim() || value.tower.length > 120 ||
      Object.keys(value).some(key => !['schemaVersion', 'frameworkApi', 'tower', 'towerBuilds', 'frameworkMinVersion', 'frameworkMaxVersionExclusive', ...(value.schemaVersion === 2 ? ['smtx'] : [])].includes(key)) ||
      value.schemaVersion !== undefined && ![1, 2].includes(value.schemaVersion)) throw new Error('INVALID_COMPATIBILITY');
  if (value.towerBuilds !== undefined && !buildList(value.towerBuilds)) throw new Error('INVALID_COMPATIBILITY');
  for (const key of ['frameworkMinVersion', 'frameworkMaxVersionExclusive']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key] !== value[key].trim() || !version.test(value[key]))) throw new Error('INVALID_COMPATIBILITY');
  if (value.schemaVersion === 2) {
    if (!value.towerBuilds?.length || !value.frameworkMinVersion) throw new Error('INVALID_COMPATIBILITY');
    // Older schema-2 readers require the deprecated field even though its value
    // has no execution meaning here. A declaration omitting it needs this reader.
    if (value.frameworkMaxVersionExclusive === undefined && compare(value.frameworkMinVersion, MINIMUM_ONLY_FRAMEWORK_VERSION) < 0) throw new Error('INVALID_COMPATIBILITY');
    if (value.smtx !== undefined && value.smtx !== 'none' &&
        (!exact(value.smtx, ['product', 'scope', 'builds']) || value.smtx.product !== 'SMTX_OS' || value.smtx.scope !== 'all-managed-product-clusters' || !buildList(value.smtx.builds) || !value.smtx.builds.length)) throw new Error('INVALID_COMPATIBILITY');
  }
  // Legacy declarations remain readable for management, never executable grants.
  return structuredClone(value);
}

export function checkFrameworkCompatibility({ towerBuild } = {}) {
  if (!validBuild(towerBuild)) return result('unknown', 'TOWER_BUILD_UNKNOWN', FRAMEWORK_COMPATIBILITY.towerBuilds);
  if (!FRAMEWORK_COMPATIBILITY.towerBuilds.includes(towerBuild)) return result('incompatible', 'FRAMEWORK_TOWER_INCOMPATIBLE', FRAMEWORK_COMPATIBILITY.towerBuilds);
  return result('compatible', null, FRAMEWORK_COMPATIBILITY.towerBuilds);
}

function checkProducts(declaration, snapshot, now) {
  if (!snapshot) return ['unknown', 'SMTX_SNAPSHOT_UNAVAILABLE'];
  if (!exact(snapshot, ['schemaVersion', 'source', 'trusted', 'complete', 'checkedAt', 'clusters', 'reason']) || snapshot.schemaVersion !== 1 || snapshot.source !== 'tower-clusters-root' ||
      typeof snapshot.trusted !== 'boolean' || typeof snapshot.complete !== 'boolean' || !Array.isArray(snapshot.clusters) || snapshot.clusters.length > 500 ||
      !(snapshot.reason === null || typeof snapshot.reason === 'string' && /^SMTX_[A-Z_]{1,80}$/.test(snapshot.reason))) return ['unknown', 'SMTX_SNAPSHOT_INVALID'];
  if (!snapshot.trusted) return ['unknown', 'SMTX_SCOPE_UNTRUSTED'];
  if (!snapshot.complete) return ['unknown', 'SMTX_SCOPE_INCOMPLETE'];
  const checked = typeof snapshot.checkedAt === 'string' ? Date.parse(snapshot.checkedAt) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(checked) || new Date(checked).toISOString() !== snapshot.checkedAt || checked > now || now - checked >= PRODUCT_SNAPSHOT_MAX_AGE_MS) return ['unknown', 'SMTX_SNAPSHOT_EXPIRED'];
  if (snapshot.reason !== null || snapshot.clusters.some(row => !exact(row, ['product', 'version']) || !products.has(row.product) || !validBuild(row.version))) return ['unknown', 'SMTX_VERSION_UNKNOWN'];
  const applicable = snapshot.clusters.filter(row => row.product === declaration.product);
  if (!applicable.length) return ['incompatible', 'SMTX_SCOPE_EMPTY'];
  if (applicable.some(row => !declaration.builds.includes(row.version))) return ['incompatible', 'SMTX_INCOMPATIBLE'];
  return ['compatible', null];
}

export function checkCompatibility(manifest, { towerBuild, frameworkApi = 1, frameworkVersion = FRAMEWORK_VERSION, smtx, now = Date.now() } = {}) {
  let declaration;
  try { declaration = validateCompatibility(manifest?.compatibility); } catch { /* Invalid declarations fail closed below. */ }
  const testedBuilds = declaration?.towerBuilds ? [...declaration.towerBuilds] : [];
  if (!validBuild(towerBuild)) return result('unknown', 'TOWER_BUILD_UNKNOWN', testedBuilds);
  if (!declaration) return result('incompatible', manifest?.compatibility?.schemaVersion === 2 ? 'PLUGIN_COMPATIBILITY_INVALID' : 'PLUGIN_COMPATIBILITY_UNDECLARED', testedBuilds);
  if (declaration.schemaVersion !== 2) return result('incompatible', 'PLUGIN_COMPATIBILITY_UNDECLARED', testedBuilds);
  if (typeof frameworkVersion !== 'string' || frameworkVersion !== frameworkVersion.trim() || !version.test(frameworkVersion)) return result('unknown', 'FRAMEWORK_VERSION_UNKNOWN', testedBuilds);
  if (frameworkApi !== declaration.frameworkApi || !testedBuilds.includes(towerBuild) ||
      declaration.frameworkMinVersion && compare(frameworkVersion, declaration.frameworkMinVersion) < 0) return result('incompatible', 'PLUGIN_INCOMPATIBLE', testedBuilds);
  if (object(declaration.smtx)) {
    const [status, reason] = checkProducts(declaration.smtx, smtx, now);
    return result(status, reason, testedBuilds);
  }
  return result('compatible', null, testedBuilds);
}

export function assertCompatible(manifest, context) {
  const result = checkCompatibility(manifest, context);
  if (!result.compatible) throw Object.assign(new Error(result.reason), { code: result.reason });
  return result;
}
