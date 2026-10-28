import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hash, validatePackage } from '../../../framework/server/manifest.js';
import { defaults, PLUGIN_ID } from '../src/configuration.js';
import { createMockProvider } from '../demo/fixtures.js';
const requireFramework = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = requireFramework('jsdom');
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
assert.equal(pkg.manifest.compatibility.frameworkMinVersion, '0.1.1');
assert.equal(pkg.manifest.repository, 'https://github.com/sephirothchang/rivetin');
assert.equal(pkg.manifest.homepage, `https://github.com/sephirothchang/rivetin/tree/main/plugins/${PLUGIN_ID}`);
assert.deepEqual(pkg.files.map(file => file.path), ['web/plugin.js', 'LICENSE']);
const runtimeCode = pkg.files.find(file => file.path === 'web/plugin.js').content.toString('utf8');
assert.ok(!/pluginkit|PluginKit/.test(runtimeCode), 'LEGACY_BRAND_IN_RUNTIME');
const patterns = [/[A-Z]:[\\/](?:Users|Documents)[\\/]/i, /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/, /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, /thread:\/\//];
for (const data of [JSON.stringify(pkg.manifest), ...pkg.files.map(file => file.content.toString('utf8'))]) {
  assert.ok(patterns.every(pattern => !pattern.test(data)), 'PACKAGE_PUBLIC_CONTENT_FINDING');
}
const dom = new JSDOM(await readFile(new URL('../tests/fixtures/cloudtower-4.9-disk-sidebar.html', import.meta.url), 'utf8'), { url: 'https://tower.example.invalid/', runScripts: 'outside-only' });
const win = dom.window;
win.location.hash = `/clusters/cluster-demo?${new URLSearchParams({ view: JSON.stringify('disks'), sidebar: JSON.stringify({ type: 'disk', id: 'disk-demo-nvme' }) })}`;
let plugin, stop;
const smokeProvider = createMockProvider({ state: () => 'recovered' }), submit = smokeProvider.collect; let submissions = 0;
smokeProvider.collect = args => { submissions++; return submit(args); };
try {
  // Execute the emitted, locally authored bundle from the validated package itself.
  win.eval(runtimeCode);
  assert.equal(win.PluginKitPlugins, undefined);
  const exported = win.RivetinPlugins[PLUGIN_ID], factory = exported.default || exported;
  assert.equal(typeof factory, 'function');
  plugin = factory({ React: requireFramework('react'), win, getLocale: () => 'zh-CN', options: {
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
  stop(); stop = null;
  assert.equal(win.document.querySelectorAll('[data-pk-smart-tab],[data-pk-smart-panel],[data-pk-smart-style]').length, 0);
  assert.equal(win.document.querySelector('.tab-content').hidden, false);
  const report = { version: pkg.manifest.version, towerBuilds: pkg.manifest.compatibility.towerBuilds, packageId: pkg.digest, sha256: hash(bytes), bytes: bytes.length, files: pkg.files.map(file => ({ path: file.path, bytes: file.content.length, sha256: file.sha256 })), publicPatternFindings: 0, emittedFactorySmokeTest: 'passed', collectOnceAndRefresh: 'passed', historyPaginationAndFailure: 'passed', cleanup: 'passed', mode: 'emitted bundle mock smoke; shared HTTP integration tested separately; no live host acceptance' };
  const qa = new URL('../qa/', import.meta.url); await mkdir(qa, { recursive: true });
  await writeFile(new URL('rivetin-verify-package-current.json', qa), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { stop?.(); plugin?.store.dispose(); win.close(); }
