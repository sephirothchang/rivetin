export const configuration = {
  id: 'rivetin-network-topology',
  defaults: () => ({}),
  validate(value) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new Error('INVALID_SETTINGS');
    return {};
  },
  equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  seed: value => value
};
