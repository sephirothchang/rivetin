export const PLUGIN_ID = 'rivetin-context-menu';
export const RESOURCE_TYPES = ['organization', 'datacenter', 'cluster', 'host', 'vm', 'vmVolume', 'disk'];
export const defaults = value => value === undefined ? ({ version: 1, enabled: true, nativeActions: true, resourceTypes: [...RESOURCE_TYPES] }) : validate(value);
export function validate(value) {
  if (!value || Object.keys(value).sort().join() !== 'enabled,nativeActions,resourceTypes,version' || value.version !== 1 ||
      typeof value.enabled !== 'boolean' || typeof value.nativeActions !== 'boolean' || !Array.isArray(value.resourceTypes) ||
      value.resourceTypes.length > 7 || value.resourceTypes.some(type => !RESOURCE_TYPES.includes(type)) ||
      new Set(value.resourceTypes).size !== value.resourceTypes.length) throw new Error('INVALID_SETTINGS');
  return { ...value, resourceTypes: [...value.resourceTypes] };
}
export const configuration = { id: PLUGIN_ID, defaults, validate, equal: (a, b) => JSON.stringify(a) === JSON.stringify(b), seed: value => value };
