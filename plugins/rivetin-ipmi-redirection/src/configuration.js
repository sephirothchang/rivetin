import { sanitizePreferences } from './preferences.js';
import { MAX_BMC_RULES } from './bmc-profiles.js';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export function sanitizeFunctionalSettings(input = {}) {
  const { ipmiEnabled, openInNewTab, loginMode, defaultVendor, bmcExceptions } = sanitizePreferences(input);
  return { version: 1, ipmiEnabled, openInNewTab, loginMode, defaultVendor, bmcExceptions,
    seededClusterIds: [...new Set((Array.isArray(input?.seededClusterIds) ? input.seededClusterIds : [])
      .filter(value => typeof value === 'string' && idPattern.test(value)))].slice(0, MAX_BMC_RULES) };
}
export function validateFunctionalSettings(input) {
  const result = sanitizeFunctionalSettings(input);
  if (!input || Object.keys(input).some(key => !Object.hasOwn(result, key)) ||
    JSON.stringify(input) !== JSON.stringify(result)) {
    // Property order is irrelevant, but values and the complete schema must be exact.
    if (!input || Object.keys(input).length !== Object.keys(result).length ||
      Object.keys(result).some(key => JSON.stringify(input[key]) !== JSON.stringify(result[key]))) throw new Error('INVALID_SETTINGS');
  }
  return result;
}
export const functionalEqual = (a, b) => JSON.stringify(sanitizeFunctionalSettings(a)) === JSON.stringify(sanitizeFunctionalSettings(b));
export function seedClusterExceptions(settings, clusters) {
  const next = sanitizeFunctionalSettings(settings), seen = new Set(next.seededClusterIds);
  for (const cluster of clusters) {
    if (typeof cluster.id !== 'string' || !idPattern.test(cluster.id) || seen.has(cluster.id)) continue;
    seen.add(cluster.id);
    if (!next.bmcExceptions.some(rule => rule.scope === 'cluster' && rule.targetId === cluster.id)) {
      next.bmcExceptions.push({ id: `cluster-${cluster.id}`, scope: 'cluster', targetId: cluster.id, vendor: next.defaultVendor });
    }
  }
  if (next.bmcExceptions.length > MAX_BMC_RULES || seen.size > MAX_BMC_RULES) throw new Error('CONFIGURATION_CAPACITY_EXCEEDED');
  next.seededClusterIds = [...seen];
  return next;
}
