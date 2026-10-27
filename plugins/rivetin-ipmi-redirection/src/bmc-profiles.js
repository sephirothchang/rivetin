import { BMC_VENDORS } from './vendor-registry.js';
export const MAX_BMC_RULES = 2000;
export const VENDORS = BMC_VENDORS;
export function vendorById(id) { return VENDORS.find(vendor => vendor.id === id) || VENDORS.find(v => v.id === 'generic'); }
export function sanitizeBmcProfiles(input) {
  const vendor = VENDORS.some(value => value.id === input.defaultVendor) ? input.defaultVendor : 'generic';
  const rules = [], seen = new Set();
  for (const value of Array.isArray(input.bmcExceptions) ? input.bmcExceptions.slice(0, MAX_BMC_RULES) : []) {
    if (!value || !['host', 'cluster'].includes(value.scope) || !VENDORS.some(v => v.id === value.vendor)) continue;
    if (typeof value.targetId !== 'string' || !/^[A-Za-z0-9_-]{0,128}$/.test(value.targetId)) continue;
    const key = `${value.scope}:${value.targetId}`;
    if (value.targetId && seen.has(key)) continue;
    if (value.targetId) seen.add(key);
    rules.push({ id: typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.id) ? value.id : `rule-${rules.length}`,
      scope: value.scope, targetId: value.targetId, vendor: value.vendor });
  }
  return { defaultVendor: vendor, bmcExceptions: rules };
}
export function resolveBmcProfile(preferences, { hostId, clusterId, contextKnown = false }) {
  const host = preferences.bmcExceptions.find(rule => rule.scope === 'host' && rule.targetId && rule.targetId === hostId);
  if (host) return { vendor: vendorById(host.vendor), source: 'host', ready: true };
  const cluster = preferences.bmcExceptions.find(rule => rule.scope === 'cluster' && rule.targetId && rule.targetId === clusterId);
  if (cluster) return { vendor: vendorById(cluster.vendor), source: 'cluster', ready: true };
  const needsContext = preferences.bmcExceptions.some(rule => rule.scope === 'cluster' && rule.targetId);
  return { vendor: vendorById(preferences.defaultVendor), source: needsContext && !contextKnown ? 'unknown' : 'global', ready: !needsContext || contextKnown };
}
