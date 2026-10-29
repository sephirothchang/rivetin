import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUiContributions, readUiContributions, supportsUiContributions, UI_LIMITS } from '../shared/ui-contributions.js';

const manifest = { compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.6' } };
const descriptor = () => ({ schemaVersion: 1, pages: [{ id: 'main', Component() {} }], actions: [], contributions: [{ id: 'open', slot: 'everoute.navigation.tools', label: { 'zh-CN': '示例工具', 'en-US': 'Example tool' }, target: { type: 'page', id: 'main' } }] });

test('UI contract validates its real floor and keeps all internal025 migration cases explicit', () => {
  assert.equal(supportsUiContributions(manifest), true);
  for (const frameworkMinVersion of ['0.2.5', undefined, '00.2.6']) assert.equal(supportsUiContributions({ compatibility: { schemaVersion: 2, frameworkMinVersion } }), false);
  assert.equal(readUiContributions({}, manifest).status, 'none');
  assert.equal(readUiContributions({ workPage: {} }, manifest).code, 'UI_LEGACY_WORKPAGE_UNAVAILABLE');
  assert.equal(readUiContributions({ ui: descriptor(), workPage: {} }, manifest).code, 'UI_CONTRIBUTIONS_INVALID');
  assert.equal(readUiContributions({ ui: descriptor() }, { compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.5' } }).code, 'UI_FRAMEWORK_MINIMUM_REQUIRED');
  assert.equal(readUiContributions({ get ui() { throw new Error('EXAMPLE'); } }, manifest).code, 'UI_CONTRIBUTIONS_INVALID');
});

test('descriptors reject raw DOM/auth/URLs, malformed graphs, fields, languages, icons and unbounded input', () => {
  const changes = [
    x => x.selector = 'main', x => x.schemaVersion = 2, x => x.pages[0].host = {}, x => x.pages[0].Component = 'script',
    x => x.pages.push(x.pages[0]), x => x.pages.push({ id: 'orphan', Component() {} }), x => x.actions.push({ id: 'run', run: 'POST' }),
    x => x.contributions[0].slot = 'custom', x => x.contributions[0].id = '../escape', x => x.contributions.push(x.contributions[0]),
    x => x.contributions[0].target = { type: 'page', id: 'missing' }, x => x.contributions[0].target = { type: 'action', id: 'missing' },
    x => x.contributions[0].target = { type: 'url', id: 'main' }, x => x.contributions[0].target.url = 'https://example.invalid',
    x => x.contributions[0].label['en-US'] = '', x => x.contributions[0].label['zh-CN'] = 'x'.repeat(81), x => x.contributions[0].label.fr = 'x',
    x => x.contributions[0].icon = '<svg>', x => x.contributions[0].order = 1001, x => x.contributions[0].order = 1.5,
    x => x.contributions[0].visibility = () => true, x => x.contributions[0].visibility = { requiresContext: ['auth'] },
    x => x.contributions[0].visibility = { requiresContext: ['clusterId', 'clusterId'] },
    x => x.contributions = Array.from({ length: UI_LIMITS.contributions + 1 }, (_, n) => ({ ...x.contributions[0], id: 'open-' + n })),
    x => x.contributions.push({ ...x.contributions[0], id: 'another', slot: 'cluster-network-topology.toolbar.actions' }),
  ];
  for (const change of changes) { const value = descriptor(); change(value); assert.throws(() => validateUiContributions(value, manifest), /UI_CONTRIBUTIONS_INVALID/); }
});

test('valid normalized descriptors freeze nested input and bind each page to a unique semantic slot', () => {
  const value = descriptor(); value.contributions.push({ ...value.contributions[0], id: 'alias', icon: 'edit', order: -1, visibility: { requiresContext: [] } });
  const result = validateUiContributions(value, manifest);
  value.contributions[0].label['en-US'] = 'mutated';
  assert.equal(result.contributions[0].label['en-US'], 'Example tool'); assert.equal(result.pages[0].slot, 'everoute.navigation.tools');
  assert.equal(result.contributions[0].order, 0); assert.equal(result.contributions[0].icon, 'none');
  assert.throws(() => result.contributions[0].visibility.requiresContext.push('clusterId'), TypeError);
});
