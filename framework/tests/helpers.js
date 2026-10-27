import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../server/manifest.js';
import { createService } from '../server/service.js';
export const actor = { id: 'example-admin', name: 'Example administrator', source: 'demo', admin: true };
export function bundle(id = 'rivetin-example', version = '0.1.0', mutate = value => value) {
  const code = Buffer.from('window.RivetinPlugins = window.RivetinPlugins || {};'), license = Buffer.from('MIT License - test fixture');
  const manifest = { manifestVersion: 1, id, version, name: { 'zh-CN': '测试插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '测试', 'en-US': 'Example' }, author: 'Example', license: 'MIT',
    compatibility: { frameworkApi: 1, tower: 'test fixture', towerBuilds: ['4.9.0'] }, frontend: { format: 'rivetin-global-v1', entry: 'web/plugin.js' }, permissions: [], locales: ['zh-CN', 'en-US'],
    configuration: { version: 1, defaults: { enabled: true }, schema: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } }, lifecycle: { reset: 'defaults', uninstall: 'retain-config' } };
  return Buffer.from(JSON.stringify(mutate({ format: 'rivetin-package-v1', manifest, files: [{ path: 'web/plugin.js', sha256: hash(code), data: code.toString('base64') }, { path: 'LICENSE', sha256: hash(license), data: license.toString('base64') }] })));
}
export async function fixture(t) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'framework-test-'));
  t.after(async () => { if (!directory.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE'); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const service = createService(directory, { towerBuild: '4.9.0' }); await service.initialize(actor);
  return { service, directory, async install(id = 'rivetin-example', version = '0.1.0') { const uploaded = await service.upload(bundle(id, version), actor); await service.change('install', id, uploaded.packageId, actor); return uploaded; } };
}
