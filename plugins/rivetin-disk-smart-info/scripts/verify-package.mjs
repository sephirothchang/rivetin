import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hash, validatePackage } from '../../../framework/server/manifest.js';
import { checkCompatibility } from '../../../framework/server/compatibility.js';
import { defaults, PLUGIN_ID } from '../src/configuration.js';
import { createMockProvider } from '../demo/fixtures.js';
import { createMockBatchProvider } from '../demo/global-fixture.js';
const requireFramework = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = requireFramework('jsdom');
const ReactDOM = requireFramework('react-dom');
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const bytes = await readFile(new URL(`../release/${PLUGIN_ID}-${metadata.version}.rivetin.json`, import.meta.url));
const pkg = validatePackage(bytes);
assert.equal(JSON.parse(bytes).format, 'rivetin-package-v1');
assert.equal(pkg.manifest.id, PLUGIN_ID);
assert.equal(pkg.manifest.version, metadata.version);
assert.equal(pkg.manifest.frontend.format, 'rivetin-global-v1');
assert.ok(pkg.manifest.permissions.includes('disk.smart.read'));
assert.equal(pkg.manifest.ssh.commands[0].intervalSeconds, 86400);
assert.deepEqual(pkg.manifest.compatibility.towerBuilds, ['4.9.0']);
assert.equal(pkg.manifest.version, '0.1.4');
assert.deepEqual(pkg.manifest.compatibility, {
  schemaVersion: 2, frameworkApi: 1, frameworkMinVersion: '0.2.0', frameworkMaxVersionExclusive: '0.3.0',
  tower: 'CloudTower 4.9.0 controlled candidate; real SMART collection remains unverified.', towerBuilds: ['4.9.0'], smtx: 'none',
});
for (const frameworkVersion of ['0.2.0', '0.2.99']) assert.equal(checkCompatibility(pkg.manifest, { towerBuild: '4.9.0', frameworkVersion }).compatible, true);
for (const frameworkVersion of ['0.1.99', '0.3.0']) assert.equal(checkCompatibility(pkg.manifest, { towerBuild: '4.9.0', frameworkVersion }).reason, 'PLUGIN_INCOMPATIBLE');
assert.equal(checkCompatibility(pkg.manifest, { towerBuild: '4.9.1', frameworkVersion: '0.2.0' }).compatible, false);
assert.equal(checkCompatibility(pkg.manifest, { towerBuild: '4.9.0', frameworkVersion: '0.2.0', frameworkApi: 2 }).compatible, false);
assert.equal(pkg.manifest.repository, 'https://github.com/sephirothchang/rivetin');
assert.equal(pkg.manifest.homepage, `https://github.com/sephirothchang/rivetin/tree/main/plugins/${PLUGIN_ID}`);
assert.deepEqual(pkg.files.map(file => file.path), ['web/plugin.js', 'LICENSE']);
const previousBytes = await readFile(new URL(`../release/${PLUGIN_ID}-0.1.3.rivetin.json`, import.meta.url));
assert.equal(hash(previousBytes), 'b54df579f28d619890dd76ef12cd4e5605517b2d7a595763ec204802d29bf240');
const previous = validatePackage(previousBytes);
assert.equal(previous.manifest.version, '0.1.3'); assert.equal(previous.manifest.compatibility.schemaVersion, undefined);
assert.equal(checkCompatibility(previous.manifest, { towerBuild: '4.9.0', frameworkVersion: '0.2.0' }).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
for (const file of pkg.files) assert.deepEqual(file.content, previous.files.find(item => item.path === file.path)?.content, 'PRODUCTION_BYTES_CHANGED');
const featureMetadata = ({ version, compatibility, releaseNotes, ...value }) => value;
assert.deepEqual(featureMetadata(pkg.manifest), featureMetadata(previous.manifest), 'NON_COMPATIBILITY_MANIFEST_CHANGE');
const runtimeCode = pkg.files.find(file => file.path === 'web/plugin.js').content.toString('utf8');
assert.ok(!/pluginkit|PluginKit/.test(runtimeCode), 'LEGACY_BRAND_IN_RUNTIME');
const patterns = [/[A-Z]:[\\/](?:Users|Documents)[\\/]/i, /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/, /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, /thread:\/\//];
for (const data of [JSON.stringify(pkg.manifest), ...pkg.files.map(file => file.content.toString('utf8'))]) {
  assert.ok(patterns.every(pattern => !pattern.test(data)), 'PACKAGE_PUBLIC_CONTENT_FINDING');
}
const dom = new JSDOM(await readFile(new URL('../tests/fixtures/cloudtower-4.9-disk-sidebar.html', import.meta.url), 'utf8'), { url: 'https://tower.example.invalid/', runScripts: 'outside-only' });
const win = dom.window;
win.location.hash = `/clusters/cluster-demo?${new URLSearchParams({ view: JSON.stringify('disks'), sidebar: JSON.stringify({ type: 'disk', id: 'disk-demo-nvme' }) })}`;
let plugin, stop, settingsRoot, smokeLocale = 'zh-CN', virtualModel = false;
const previousGlobals = { window: globalThis.window, document: globalThis.document };
const smokeProvider = { ...createMockProvider({ state: () => 'recovered' }), ...createMockBatchProvider({ state: () => 'batch-partial' }) }, submit = smokeProvider.collect, submitAll = smokeProvider.collectAll; let submissions = 0, batchSubmissions = 0;
smokeProvider.collect = args => { submissions++; return submit(args); };
smokeProvider.collectAll = args => { batchSubmissions++; return submitAll(args); };
const readInventory = smokeProvider.readInventory, readLatest = smokeProvider.readLatest, readHistory = smokeProvider.readHistory;
let sampleReads = 0;
smokeProvider.readInventory = async args => { const value = await readInventory(args); return virtualModel ? { ...value, disk: { ...value.disk, model: 'VMware Virtual NVMe Disk' } } : value; };
smokeProvider.readLatest = args => { sampleReads++; return readLatest(args); };
smokeProvider.readHistory = args => { sampleReads++; return readHistory(args); };
try {
  // Execute the emitted, locally authored bundle from the validated package itself.
  win.eval(runtimeCode);
  assert.equal(win.PluginKitPlugins, undefined);
  const exported = win.RivetinPlugins[PLUGIN_ID], factory = exported.default || exported;
  assert.equal(typeof factory, 'function');
  plugin = factory({ React: requireFramework('react'), win, getLocale: () => smokeLocale, options: {
    configurationBackend: () => ({ load: async () => ({ revision: 0, updatedAt: null, settings: defaults() }) }),
    diskSmartInfo: { provider: smokeProvider },
  } });
  await plugin.store.load(); stop = plugin.activate();
  assert.equal(win.document.querySelectorAll('[data-pk-smart-tab]').length, 1);
  win.document.querySelector('[data-pk-smart-tab]').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(win.document.querySelector('.pk-smart-table'));
  assert.ok(win.document.querySelector('tr.pk-smart-risk-darkred'));
  assert.match(win.document.querySelector('.pk-smart-recovered').textContent, /当日曾采集失败，后恢复/);
  win.document.querySelector('[data-smart-collect]').click();
  assert.equal(win.document.querySelector('[data-smart-collect]').disabled, true);
  const collectionDeadline = Date.now() + 5000;
  while ((!win.document.querySelector('.pk-smart-collection')?.textContent.includes('采集任务已完成') || win.document.querySelector('[data-smart-collect]').disabled) && Date.now() < collectionDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(win.document.querySelector('.pk-smart-collection').textContent, /采集任务已完成/);
  assert.equal(win.document.querySelector('[data-smart-collect]').disabled, false); assert.equal(submissions, 1);
  assert.equal(win.document.querySelectorAll('[data-sample-time]').length, 30);
  win.document.querySelector('[data-smart-more]').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(win.document.querySelectorAll('[data-sample-time]').length, 60);
  win.document.querySelectorAll('[data-sample-time]')[1].click();
  assert.equal(win.document.querySelector('.pk-smart-table'), null);
  assert.match(win.document.querySelector('[data-pk-smart-panel]').textContent, /采集尝试时间/);
  globalThis.window = win; globalThis.document = win.document;
  settingsRoot = win.document.createElement('div'); win.document.body.append(settingsRoot);
  const React = requireFramework('react');
  ReactDOM.render(React.createElement(plugin.Settings, { preferences: plugin.store.getDraft(), locale: 'zh-CN' }), settingsRoot);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(batchSubmissions, 0);
  settingsRoot.querySelector('[data-smart-collect-all]').click(); settingsRoot.querySelector('[data-smart-collect-all]').click();
  assert.equal(batchSubmissions, 1); assert.equal(settingsRoot.querySelector('[data-smart-collect-all]').disabled, true);
  const batchDeadline = Date.now() + 5000;
  while (settingsRoot.querySelector('[data-smart-collect-all]').disabled && Date.now() < batchDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settingsRoot.querySelector('[data-smart-collect-all]').disabled, false);
  assert.match(settingsRoot.querySelector('.pk-smart-global').textContent, /批次未全部成功/);
  assert.equal(settingsRoot.querySelectorAll('.pk-smart-global tbody tr').length, 3);
  assert.equal(batchSubmissions, 1); assert.equal(submissions, 1); assert.equal(plugin.store.status().dirty, false);
  virtualModel = true; const beforeExamples = sampleReads;
  [...win.document.querySelectorAll('[data-pk-smart-panel] button')].find(button => button.textContent === '重新读取').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(win.document.querySelector('.pk-smart-virtual-banner').textContent, /非该盘实际 SMART/);
  assert.equal(win.document.querySelector('[data-smart-collect]').disabled, true);
  assert.equal(win.document.querySelectorAll('[data-sample-time]').length, 0); assert.equal(sampleReads, beforeExamples);
  smokeLocale = 'en-US'; win.dispatchEvent(new win.Event('languagechange'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(win.document.querySelector('.pk-smart-virtual-banner').textContent, /VIRTUAL DISK EXAMPLE/);
  stop(); stop = null;
  assert.equal(settingsRoot.querySelector('[data-smart-collect-all]').disabled, true);
  assert.equal(win.document.querySelectorAll('[data-pk-smart-tab],[data-pk-smart-panel],[data-pk-smart-style]').length, 0);
  assert.equal(win.document.querySelector('.tab-content').hidden, false);
  const report = { version: pkg.manifest.version, compatibility: pkg.manifest.compatibility, towerBuilds: pkg.manifest.compatibility.towerBuilds, packageId: pkg.digest, sha256: hash(bytes), bytes: bytes.length, files: pkg.files.map(file => ({ path: file.path, bytes: file.content.length, sha256: file.sha256 })), previousArchiveSha256: hash(previousBytes), productionBytesIdenticalTo013: true, strictSchema2OfflineGate: 'passed', publicPatternFindings: 0, emittedFactorySmokeTest: 'passed', collectOnceAndRefresh: 'passed', globalSettingsCollectOnceAndPartialFailure: 'passed', virtualExamplesBilingualAndIsolated: 'passed', historyPaginationAndFailure: 'passed', cleanup: 'passed', mode: 'metadata-only release; emitted bundle mock smoke; shared HTTP integration tested separately; no live 0.2/0.1.4 acceptance' };
  const qa = new URL('../qa/', import.meta.url); await mkdir(qa, { recursive: true });
  await writeFile(new URL('rivetin-verify-package-current.json', qa), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  stop?.(); if (settingsRoot) ReactDOM.unmountComponentAtNode(settingsRoot);
  plugin?.store.dispose(); globalThis.window = previousGlobals.window; globalThis.document = previousGlobals.document; win.close();
}
