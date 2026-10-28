import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSshRegistration } from '../../../framework/server/ssh-policy.js';

test('SMART declares a disk template and inventory expansion without accepting executable parameters', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  const declaration = validateSshRegistration(manifest.ssh).commands[0];
  assert.equal(declaration.operation, 'disk.smart.read');
  assert.equal(declaration.hostScope, 'configured'); assert.equal(declaration.deviceScope, 'configured');
  assert.equal(declaration.deviceIds, undefined); assert.equal(declaration.hostIds, undefined);
  for (const purpose of Object.values(declaration.purpose)) {
    assert.ok(purpose.includes('sudo -n -- /usr/sbin/smartctl --json=c --all <disk>'));
    assert.doesNotMatch(purpose, /\/dev\/(?:sd[a-z]+|nvme\d+n\d+)/);
  }
  assert.match(declaration.purpose['zh-CN'], /库存/); assert.match(declaration.purpose['en-US'], /inventory/);
  assert.throws(() => validateSshRegistration({ ...manifest.ssh, commands: [{ ...declaration, path: '/dev/sdb' }] }), /SSH_REGISTRATION_INVALID/);
  assert.throws(() => validateSshRegistration({ ...manifest.ssh, commands: [{ ...declaration, regex: '.*' }] }), /SSH_REGISTRATION_INVALID/);
});
