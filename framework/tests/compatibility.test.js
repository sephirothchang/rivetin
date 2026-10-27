import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompatibility, checkCompatibility, assertCompatible } from '../server/compatibility.js';
import { validateManifest } from '../server/manifest.js';
import { bundle } from './helpers.js';

const towerBuild = '4.9.0-rc-20260517114030';
const declaration = patch => ({ frameworkApi: 1, tower: 'Explicitly tested builds only.', towerBuilds: [towerBuild], ...patch });
const manifest = patch => ({ compatibility: declaration(patch) });
const context = { towerBuild, frameworkApi: 1, frameworkVersion: '0.1.0' };

test('compatibility requires an exact tested Tower build and supported framework API', () => {
  assert.deepEqual(checkCompatibility(manifest(), context), { compatible: true, reason: null, testedBuilds: [towerBuild] });
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
  assert.equal(checkCompatibility(manifest({ towerBuilds: [] }), context).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
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
    { frameworkApi: 2 }, { tower: '' }, { tower: ' '.repeat(4) }, { tower: 'x'.repeat(121) },
    { towerBuilds: [towerBuild, towerBuild] }, { towerBuilds: '*' }, { towerBuilds: Array.from({ length: 21 }, (_, index) => `4.9.${index}`) },
    ...['4.*', '4.9.0 ', 'v4.9.0', '../4.9.0', '4.9.0+build', '4.9.0-' + 'a'.repeat(100)].map(value => ({ towerBuilds: [value] })),
    { frameworkMinVersion: '01.2.3' }, { frameworkMaxVersionExclusive: '1.0.0-rc' }, { frameworkMinVersion: '0.2.0', frameworkMaxVersionExclusive: '0.1.0' },
    { frameworkMinVersion: '0.1.0', frameworkMaxVersionExclusive: '0.1.0' }, { anythingElse: true },
  ]) {
    const value = declaration(patch);
    assert.throws(() => validateCompatibility(value), /INVALID_COMPATIBILITY/);
    assert.equal(checkCompatibility({ compatibility: value }, context).compatible, false);
  }
});

test('package validation accepts machine declarations and rejects invalid additions without altering SSH metadata', () => {
  const value = JSON.parse(bundle()).manifest;
  value.compatibility = declaration();
  assert.deepEqual(validateManifest(value).compatibility.towerBuilds, [towerBuild]);
  value.compatibility.towerBuilds = ['4.*'];
  assert.throws(() => validateManifest(value), /INVALID_MANIFEST/);
});
