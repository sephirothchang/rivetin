export const idPattern = /^rivetin-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const validId = value => typeof value === 'string' && value.length <= 100 && idPattern.test(value);
export function assertId(value) {
  if (!validId(value)) throw new Error('INVALID_PLUGIN_ID');
  return value;
}
