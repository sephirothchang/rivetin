export const PLUGIN_ID = 'rivetin-ssh-channel';
export function defaults(value) { return value === undefined ? { version: 1, enabled: false } : validate(value); }
export function validate(value) {
  if (!value || Object.keys(value).sort().join() !== 'enabled,version' || value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('INVALID_SETTINGS');
  return { version: 1, enabled: value.enabled };
}
export const configuration = { id: PLUGIN_ID, defaults, validate, equal: (a, b) => a.version === b.version && a.enabled === b.enabled, seed: value => value };
