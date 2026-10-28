export const PLUGIN_ID = 'rivetin-security-policy-converter';
export function validate(value) {
  if (!value || Object.keys(value).sort().join() !== 'labelKey,version' || value.version !== 1 ||
      typeof value.labelKey !== 'string' || value.labelKey.length > 80) throw new Error('INVALID_SETTINGS');
  return { version: 1, labelKey: value.labelKey };
}
export const configuration = {
  id: PLUGIN_ID,
  defaults: value => value === undefined ? { version: 1, labelKey: 'application' } : validate(value),
  validate, equal: (a, b) => a.version === b.version && a.labelKey === b.labelKey, seed: value => value
};
