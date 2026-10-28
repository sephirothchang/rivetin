import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompatibility, checkCompatibility, assertCompatible, checkFrameworkCompatibility, PRODUCT_SNAPSHOT_MAX_AGE_MS } from '../server/compatibility.js';
import { FRAMEWORK_COMPATIBILITY } from '../shared/framework-compatibility.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';
import { validateManifest } from '../server/manifest.js';
import { bundle } from './helpers.js';

const towerBuild = '4.9.0-rc-20260517114030';
const declaration = patch => ({ schemaVersion: 2, frameworkApi: 1, tower: 'Explicitly tested builds only.', towerBuilds: [towerBuild], frameworkMinVersion: '0.1.0', frameworkMaxVersionExclusive: '0.2.0', ...patch });
const manifest = patch => ({ compatibility: declaration(patch) });
const context = { towerBuild, frameworkApi: 1, frameworkVersion: '0.1.0' };

test('compatibility requires an exact tested Tower build and supported framework API', () => {
  assert.deepEqual(checkCompatibility(manifest(), context), { compatible: true, status: 'compatible', reason: null, testedBuilds: [towerBuild] });
  for (const towerBuild of ['4.9.0', '4.9.0-rc-20260517114031', '4.8.0']) assert.equal(checkCompatibility(manifest(), { ...context, towerBuild }).reason, 'PLUGIN_INCOMPATIBLE');
  assert.equal(checkCompatibility(manifest(), { ...context, frameworkApi: 2 }).reason, 'PLUGIN_INCOMPATIBLE');
  const changed = checkCompatibility(manifest(), context); changed.testedBuilds.push('4.8.0');
  assert.deepEqual(checkCompatibility(manifest(), context).testedBuilds, [towerBuild]);
});

test('unknown, image-like, wildcard and malformed detected builds never pass', () => {
  for (const towerBuild of [undefined, null, '', 'unknown', '*', '4.9.*', 'v4.9.0', 'tower:v4.9.0', '4.9.0/other', '04.9.0', '4.9.0\n'])
    assert.equal(checkCompatibility(manifest(), { ...context, towerBuild }).reason, 'TOWER_BUILD_UNKNOWN');
  assert.throws(() => assertCompatible(manifest()), error => error.code === 'TOWER_BUILD_UNKNOWN');
});

test('legacy compatibility text remains readable but is never inferred into an allowlist', () => {
  const legacy = { frameworkApi: 1, tower: `Tested with ${towerBuild}` };
  assert.deepEqual(validateCompatibility(legacy), legacy);
  assert.equal(checkCompatibility({ compatibility: legacy }, context).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
  assert.equal(checkCompatibility({ compatibility: { ...legacy, towerBuilds: [towerBuild], frameworkMinVersion: '0.1.0', frameworkMaxVersionExclusive: '0.2.0' } }, context).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
  assert.equal(checkCompatibility(manifest({ towerBuilds: [] }), context).reason, 'PLUGIN_COMPATIBILITY_INVALID');
  assert.throws(() => assertCompatible({ compatibility: legacy }, context), /PLUGIN_COMPATIBILITY_UNDECLARED/);
  assert.equal(checkCompatibility({}, context).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
});

test('framework version bounds compare numerically with inclusive minimum and exclusive maximum', () => {
  const value = manifest({ frameworkMinVersion: '0.1.9', frameworkMaxVersionExclusive: '0.2.0' });
  for (const frameworkVersion of ['0.1.9', '0.1.10', '0.1.99']) assert.equal(checkCompatibility(value, { ...context, frameworkVersion }).compatible, true);
  for (const frameworkVersion of ['0.1.8', '0.2.0', '1.0.0', '0.1.09', '0.1.9-rc', undefined]) assert.equal(checkCompatibility(value, { ...context, frameworkVersion }).compatible, false);
  assert.equal(assertCompatible(value, { ...context, frameworkVersion: '0.1.10' }).compatible, true);
});

test('invalid declarations fail validation and never become compatible', () => {
  for (const patch of [
    { schemaVersion: 3 }, { schemaVersion: true }, { frameworkApi: 2 }, { tower: '' }, { tower: ' '.repeat(4) }, { tower: 'x'.repeat(121) },
    { towerBuilds: [towerBuild, towerBuild] }, { towerBuilds: '*' }, { towerBuilds: Array.from({ length: 21 }, (_, index) => `4.9.${index}`) },
    ...['4.*', '4.9.0 ', 'v4.9.0', '../4.9.0', '4.9.0+build', '4.9.0-' + 'a'.repeat(100)].map(value => ({ towerBuilds: [value] })),
    { frameworkMinVersion: undefined }, { frameworkMaxVersionExclusive: undefined }, { towerBuilds: undefined }, { towerBuilds: [] },
    { frameworkMinVersion: '01.2.3' }, { frameworkMaxVersionExclusive: '1.0.0-rc' }, { frameworkMinVersion: '0.2.0', frameworkMaxVersionExclusive: '0.1.0' },
    { frameworkMinVersion: '0.1.0', frameworkMaxVersionExclusive: '0.1.0' }, { anythingElse: true },
  ]) {
    const value = declaration(patch);
    assert.throws(() => validateCompatibility(value), /INVALID_COMPATIBILITY/);
    assert.equal(checkCompatibility({ compatibility: value }, context).compatible, false);
  }
});

test('framework declares its own tested product versions independently of the CLI exact image profile', () => {
  assert.deepEqual(FRAMEWORK_COMPATIBILITY, { schemaVersion: 1, frameworkApi: 1, frameworkVersion: FRAMEWORK_VERSION, towerBuilds: ['4.9.0'] });
  assert.equal(Object.isFrozen(FRAMEWORK_COMPATIBILITY), true); assert.equal(Object.isFrozen(FRAMEWORK_COMPATIBILITY.towerBuilds), true);
  assert.equal(checkFrameworkCompatibility({ towerBuild: '4.9.0' }).status, 'compatible');
  assert.equal(checkFrameworkCompatibility({ towerBuild }).reason, 'FRAMEWORK_TOWER_INCOMPATIBLE');
  assert.equal(checkFrameworkCompatibility({ towerBuild: null }).status, 'unknown');
  const result = checkFrameworkCompatibility({ towerBuild: '4.9.0' }); result.testedBuilds.push('4.8.0');
  assert.deepEqual(FRAMEWORK_COMPATIBILITY.towerBuilds, ['4.9.0']);
});

const requirement = { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: ['6.3.0', '6.3.1'] };
const clock = Date.parse('2026-01-01T00:00:00.000Z');
const snapshot = patch => ({ schemaVersion: 1, source: 'tower-clusters-root', trusted: true, complete: true, checkedAt: new Date(clock).toISOString(), clusters: [{ product: 'SMTX_OS', version: '6.3.0' }], reason: null, ...patch });
const required = patch => checkCompatibility(manifest({ smtx: requirement }), { ...context, now: clock, smtx: snapshot(), ...patch });

test('optional SMTX constraints neither require nor inspect a product snapshot', () => {
  for (const smtx of [undefined, 'none']) {
    const value = manifest({ smtx });
    assert.equal(checkCompatibility(value, { ...context, smtx: { get trusted() { throw new Error('MUST_NOT_READ'); } } }).compatible, true);
    assert.deepEqual(validateCompatibility(value.compatibility), value.compatibility);
  }
});

test('required SMTX checks every managed matching cluster and rejects empty or mixed unsupported versions', () => {
  assert.equal(required().compatible, true);
  assert.equal(required({ smtx: snapshot({ clusters: [{ product: 'SMTX_OS', version: '6.3.0' }, { product: 'SMTX_OS', version: '6.3.1' }, { product: 'SMTX_ZBS', version: '5.6.0' }] }) }).compatible, true);
  assert.equal(required({ smtx: snapshot({ clusters: [{ product: 'SMTX_OS', version: '6.3.0' }, { product: 'SMTX_OS', version: '6.2.0' }] }) }).reason, 'SMTX_INCOMPATIBLE');
  const empty = required({ smtx: snapshot({ clusters: [{ product: 'SMTX_ELF', version: '6.3.0' }] }) });
  assert.equal(empty.status, 'incompatible'); assert.equal(empty.reason, 'SMTX_SCOPE_EMPTY');
});

test('unknown, expired, untrusted, incomplete or malformed SMTX snapshots fail closed without confirmed incompatibility', () => {
  for (const smtx of [undefined, {}, snapshot({ trusted: false }), snapshot({ complete: false }), snapshot({ checkedAt: new Date(clock - PRODUCT_SNAPSHOT_MAX_AGE_MS).toISOString() }), snapshot({ checkedAt: new Date(clock + 1).toISOString() }), snapshot({ checkedAt: 'invalid' }), snapshot({ source: 'browser' }), snapshot({ clusters: [{ product: 'UNKNOWN', version: '6.3.0' }] }), snapshot({ clusters: [{ product: 'SMTX_OS', version: null }] }), snapshot({ clusters: [{ product: 'SMTX_OS', version: '6.3.0', id: 'example-cluster' }] }), snapshot({ reason: 'SMTX_INVENTORY_UNAVAILABLE' })]) {
    const result = required({ smtx }); assert.equal(result.compatible, false); assert.equal(result.status, 'unknown');
  }
  assert.equal(required({ now: clock + PRODUCT_SNAPSHOT_MAX_AGE_MS - 1 }).compatible, true);
  assert.equal(checkCompatibility(manifest(), { ...context, towerBuild: null }).status, 'unknown');
  assert.equal(checkCompatibility(manifest(), { ...context, frameworkVersion: null }).reason, 'FRAMEWORK_VERSION_UNKNOWN');
});

test('SMTX declarations reject unknown shapes, wildcard builds, alternate scopes and legacy opt-in', () => {
  for (const smtx of [null, false, [], {}, '*', { mode: 'none' }, { ...requirement, product: 'SMTX_ZBS' }, { ...requirement, scope: 'selected-clusters' }, { ...requirement, builds: [] }, { ...requirement, builds: ['6.*'] }, { ...requirement, builds: ['6.3.0', '6.3.0'] }, { ...requirement, anythingElse: true }]) assert.throws(() => validateCompatibility(declaration({ smtx })), /INVALID_COMPATIBILITY/);
  const legacy = declaration({ schemaVersion: undefined, smtx: 'none' }); assert.throws(() => validateCompatibility(legacy), /INVALID_COMPATIBILITY/);
  assert.throws(() => assertCompatible(manifest({ smtx: requirement }), context), error => error.code === 'SMTX_SNAPSHOT_UNAVAILABLE');
});

test('package validation accepts machine declarations and rejects invalid additions without altering SSH metadata', () => {
  const value = JSON.parse(bundle()).manifest;
  value.compatibility = declaration();
  assert.deepEqual(validateManifest(value).compatibility.towerBuilds, [towerBuild]);
  value.compatibility.towerBuilds = ['4.*'];
  assert.throws(() => validateManifest(value), /INVALID_MANIFEST/);
});
