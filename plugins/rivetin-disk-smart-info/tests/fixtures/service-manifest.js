import assert from 'node:assert/strict';

export function legacyReleaseDeclaration() {
  return { version: '0.1.3', compatibility: {
    frameworkApi: 1,
    tower: 'CloudTower 4.9.0 controlled acceptance: API/DOM read checks and local tests; live host SMART unverified.',
    towerBuilds: ['4.9.0'],
    frameworkMinVersion: '0.1.2',
  } };
}

export function assertCurrentReleaseManifest(manifest) {
  assert.equal(manifest.version, '0.1.4');
  assert.deepEqual(manifest.compatibility, {
    schemaVersion: 2,
    frameworkApi: 1,
    frameworkMinVersion: '0.2.0',
    frameworkMaxVersionExclusive: '0.3.0',
    tower: 'CloudTower 4.9.0 controlled candidate; real SMART collection remains unverified.',
    towerBuilds: ['4.9.0'],
    smtx: 'none',
  });
}

// Test-only service metadata. The package entry is a stub and is never executed.
// Historical 0.1.3 declarations remain separate and are never upgraded in place.
export function syntheticServiceManifest(manifest, version = manifest.version) {
  assertCurrentReleaseManifest(manifest);
  return { ...structuredClone(manifest), version, compatibility: {
    schemaVersion: 2,
    frameworkApi: 1,
    frameworkMinVersion: '0.2.0',
    frameworkMaxVersionExclusive: '0.3.0',
    tower: 'Synthetic unexecuted service fixture; no release compatibility claim.',
    towerBuilds: ['4.9.0'],
    smtx: 'none',
  } };
}
