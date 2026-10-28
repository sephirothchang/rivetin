import { FRAMEWORK_VERSION } from '../shared/version.js';

const version = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const build = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validBuild = value => typeof value === 'string' && value.length <= 100 && build.test(value);
const compare = (a, b) => a.split('.').map(Number).map((value, index) => value - Number(b.split('.')[index])).find(value => value !== 0) || 0;

export function validateCompatibility(value) {
  if (!object(value) || value.frameworkApi !== 1 || typeof value.tower !== 'string' || !value.tower.trim() || value.tower.length > 120 ||
      Object.keys(value).some(key => !['frameworkApi', 'tower', 'towerBuilds', 'frameworkMinVersion', 'frameworkMaxVersionExclusive'].includes(key))) throw new Error('INVALID_COMPATIBILITY');
  if (value.towerBuilds !== undefined && (!Array.isArray(value.towerBuilds) || value.towerBuilds.length > 20 ||
      value.towerBuilds.some(token => !validBuild(token)) || new Set(value.towerBuilds).size !== value.towerBuilds.length)) throw new Error('INVALID_COMPATIBILITY');
  for (const key of ['frameworkMinVersion', 'frameworkMaxVersionExclusive']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !version.test(value[key]))) throw new Error('INVALID_COMPATIBILITY');
  if (value.frameworkMinVersion && value.frameworkMaxVersionExclusive && compare(value.frameworkMinVersion, value.frameworkMaxVersionExclusive) >= 0) throw new Error('INVALID_COMPATIBILITY');
  // Draft manifests may omit tested builds but cannot run; absence is never an execution grant.
  return structuredClone(value);
}

export function checkCompatibility(manifest, { towerBuild, frameworkApi = 1, frameworkVersion = FRAMEWORK_VERSION } = {}) {
  let declaration;
  try { declaration = validateCompatibility(manifest?.compatibility); } catch { /* Invalid declarations fail closed below. */ }
  const testedBuilds = declaration?.towerBuilds ? [...declaration.towerBuilds] : [];
  const denied = reason => ({ compatible: false, reason, testedBuilds });
  if (!validBuild(towerBuild)) return denied('TOWER_BUILD_UNKNOWN');
  if (!declaration) return denied(manifest?.compatibility?.towerBuilds === undefined ? 'PLUGIN_COMPATIBILITY_UNDECLARED' : 'PLUGIN_INCOMPATIBLE');
  if (!testedBuilds.length) return denied('PLUGIN_COMPATIBILITY_UNDECLARED');
  if (frameworkApi !== declaration.frameworkApi || typeof frameworkVersion !== 'string' || !version.test(frameworkVersion) || !testedBuilds.includes(towerBuild) ||
      declaration.frameworkMinVersion && compare(frameworkVersion, declaration.frameworkMinVersion) < 0 ||
      declaration.frameworkMaxVersionExclusive && compare(frameworkVersion, declaration.frameworkMaxVersionExclusive) >= 0) return denied('PLUGIN_INCOMPATIBLE');
  return { compatible: true, reason: null, testedBuilds };
}

export function assertCompatible(manifest, context) {
  const result = checkCompatibility(manifest, context);
  if (!result.compatible) throw Object.assign(new Error(result.reason), { code: result.reason });
  return result;
}
