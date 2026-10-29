export const WORK_PAGE_MINIMUM = '0.2.5';

export function supportsWorkPages(manifest) {
  const value = manifest?.compatibility?.frameworkMinVersion;
  if (manifest?.compatibility?.schemaVersion !== 2 || typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  const [major, minor, patch] = value.split('.').map(Number);
  return major > 0 || minor > 2 || minor === 2 && patch >= 5;
}
