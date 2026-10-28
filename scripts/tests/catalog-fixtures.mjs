import { createHash } from 'node:crypto';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function fixturePackage(id = 'rivetin-example', version = '0.1.0', compatibility) {
  const code = Buffer.from('window.RivetinPlugins = {};'), license = Buffer.from('MIT License - EXAMPLE fixture');
  return Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest: { manifestVersion: 1, id, version,
    name: { 'zh-CN': '示例插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '离线测试示例。', 'en-US': 'Offline test fixture.' }, author: 'Rivetin contributors', license: 'MIT',
    compatibility: compatibility || { frameworkApi: 1, tower: 'Only explicitly tested Tower versions.', towerBuilds: ['4.9.0'] }, permissions: ['inventory.read'], locales: ['zh-CN', 'en-US'],
    frontend: { format: 'rivetin-global-v1', entry: 'web/plugin.js' }, configuration: { version: 1, defaults: {}, schema: { type: 'object', properties: {}, additionalProperties: false } }, lifecycle: { reset: 'defaults', uninstall: 'retain-config' } },
    files: [{ path: 'web/plugin.js', data: code.toString('base64'), sha256: sha(code) }, { path: 'LICENSE', data: license.toString('base64'), sha256: sha(license) }] }));
}
export function v4Compatibility(patch = {}) { return { schemaVersion: 2, frameworkApi: 1, tower: 'Only explicitly tested Tower versions.', towerBuilds: ['4.9.0'], frameworkMinVersion: '0.2.0', frameworkMaxVersionExclusive: '0.3.0', ...patch }; }
export function fixtureV4Package(id = 'rivetin-example', version = '0.2.0', patch = {}) { return fixturePackage(id, version, v4Compatibility(patch)); }
export function receipt(bytes, path, time = '2026-10-28T12:01:00.000Z') { return { schemaVersion: 1, site: 'https://rivetin.dev', path, status: 200, sha256: sha(bytes), bytes: bytes.length, verifiedAt: time }; }
