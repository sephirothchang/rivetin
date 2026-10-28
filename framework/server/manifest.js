import { createHash } from 'node:crypto';
import { validId } from './storage.js';
import { validateSshRegistration } from './ssh-policy.js';
import { validateCompatibility } from './compatibility.js';

export { FRAMEWORK_VERSION } from '../shared/version.js';
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const languageText = value => object(value) && ['zh-CN', 'en-US'].every(lang => text(value[lang]));
export const safePath = value => typeof value === 'string' && value.length <= 180 &&
  /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every(part => !['.', '..'].includes(part)) &&
  !value.split('/').some(part => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));
export function validateSettings(value, schema, depth = 0) {
  if (!object(schema) || depth > 12) throw new Error('INVALID_SCHEMA');
  if (schema.enum && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) throw new Error('INVALID_SETTINGS');
  switch (schema.type) {
    case 'object':
      if (!object(value) || !object(schema.properties) || schema.additionalProperties !== false ||
        Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || (schema.required || []).some(key => !Object.hasOwn(value, key))) throw new Error('INVALID_SETTINGS');
      for (const [key, entry] of Object.entries(value)) validateSettings(entry, schema.properties[key], depth + 1);
      break;
    case 'array':
      if (!Array.isArray(value) || !Number.isInteger(schema.maxItems) || schema.maxItems > 5000 || value.length > schema.maxItems) throw new Error('INVALID_SETTINGS');
      for (const entry of value) validateSettings(entry, schema.items, depth + 1);
      break;
    case 'string':
      if (typeof value !== 'string' || !Number.isInteger(schema.maxLength) || schema.maxLength > 2000 || value.length > schema.maxLength) throw new Error('INVALID_SETTINGS');
      break;
    case 'boolean': if (typeof value !== 'boolean') throw new Error('INVALID_SETTINGS'); break;
    case 'integer': if (!Number.isSafeInteger(value) || value < (schema.minimum ?? 0) || value > (schema.maximum ?? 1000000)) throw new Error('INVALID_SETTINGS'); break;
    default: throw new Error('INVALID_SCHEMA');
  }
  return structuredClone(value);
}
export function validateManifest(value) {
  if (!object(value) || value.manifestVersion !== 1 || !validId(value.id) || !semver.test(value.version) ||
    !languageText(value.name) || !languageText(value.description) || !text(value.author, 120) || value.license !== 'MIT' ||
    !object(value.compatibility) || value.compatibility.frameworkApi !== 1 || !text(value.compatibility.tower, 120) ||
    !object(value.frontend) || value.frontend.format !== 'rivetin-global-v1' || !safePath(value.frontend.entry) || !value.frontend.entry.endsWith('.js') ||
    !Array.isArray(value.permissions) || value.permissions.length > 20 || value.permissions.some(permission => !['inventory.read', 'host.ipmi.enhance', 'bmc.session.launch', 'ui.context-menu', 'ssh.channel.use', 'disk.smart.read', 'resource.actions'].includes(permission)) ||
    !Array.isArray(value.locales) || !['zh-CN', 'en-US'].every(locale => value.locales.includes(locale)) ||
    !object(value.configuration) || !Number.isSafeInteger(value.configuration.version) || value.configuration.version < 1 ||
    !object(value.lifecycle) || value.lifecycle.reset !== 'defaults' || value.lifecycle.uninstall !== 'retain-config') throw new Error('INVALID_MANIFEST');
  try { validateCompatibility(value.compatibility); } catch { throw new Error('INVALID_MANIFEST'); }
  validateSettings(value.configuration.defaults, value.configuration.schema);
  if (value.ssh !== undefined) {
    if (!value.permissions.includes('ssh.channel.use')) throw new Error('SSH_PERMISSION_REQUIRED');
    validateSshRegistration(value.ssh);
  }
  if (JSON.stringify(value).length > 100000) throw new Error('INVALID_MANIFEST');
  // Metadata is data only. Hooks, arbitrary server entry points and package scripts are not accepted.
  const allowed = new Set(['manifestVersion', 'id', 'version', 'name', 'description', 'author', 'license', 'homepage', 'repository', 'compatibility', 'frontend', 'permissions', 'locales', 'configuration', 'lifecycle', 'releaseNotes', 'ssh']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('INVALID_MANIFEST');
  for (const key of ['homepage', 'repository']) if (value[key] && (!text(value[key], 500) || !/^https:\/\//.test(value[key]))) throw new Error('INVALID_MANIFEST');
  return structuredClone(value);
}
export function validatePackage(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('PACKAGE_TOO_LARGE');
  let pkg; try { pkg = JSON.parse(bytes); } catch { throw new Error('INVALID_PACKAGE'); }
  if (!object(pkg) || pkg.format !== 'rivetin-package-v1' || !Array.isArray(pkg.files) || !pkg.files.length || pkg.files.length > 100 || Object.keys(pkg).some(key => !['format', 'manifest', 'files'].includes(key))) throw new Error('INVALID_PACKAGE');
  const manifest = validateManifest(pkg.manifest), files = [], names = new Set(); let total = 0;
  for (const file of pkg.files) {
    if (!object(file) || Object.keys(file).sort().join() !== 'data,path,sha256' || !safePath(file.path) || !/^(web\/.*\.(js|css|json)|LICENSE)$/.test(file.path) ||
      names.has(file.path.toLowerCase()) || typeof file.data !== 'string' || file.data.length % 4 !== 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('INVALID_PACKAGE_FILE');
    names.add(file.path.toLowerCase());
    const content = Buffer.from(file.data, 'base64');
    // Canonical round-trip validation stays bounded for large files; a repeated-group regex can exhaust V8's stack.
    if (content.toString('base64') !== file.data) throw new Error('INVALID_PACKAGE_FILE');
    total += content.length;
    if (total > 10 * 1024 * 1024 || hash(content) !== file.sha256) throw new Error('PACKAGE_INTEGRITY_FAILED');
    files.push({ path: file.path, content, sha256: file.sha256 });
  }
  if (!names.has(manifest.frontend.entry.toLowerCase()) || !names.has('license')) throw new Error('PACKAGE_ENTRY_MISSING');
  return { manifest, files, digest: hash(bytes) };
}
