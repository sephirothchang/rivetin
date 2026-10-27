import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSshRegistration, compileSshCommand, sshRegistrationDigest } from '../server/ssh-policy.js';

const command = () => ({ id: 'identity', operation: 'host.identity', purpose: { 'zh-CN': '读取系统标识', 'en-US': 'Read system identity' }, hostIds: ['host-example'], intervalSeconds: 0 });
test('SSH registry accepts only fixed read operations and rejects shell text, injection, unknown keys and schedules', () => {
  assert.equal(validateSshRegistration({ version: 1, commands: [command()] }).commands[0].operation, 'host.identity');
  for (const patch of [{ operation: 'rm -rf /' }, { command: 'reboot' }, { hostIds: ['host;id'] }, { intervalSeconds: 1 }, { intervalSeconds: 8640000 }, { deviceIds: ['sda'] }, { purpose: { 'zh-CN': 'x', 'en-US': 'y\ncommand' } }]) {
    assert.throws(() => validateSshRegistration({ version: 1, commands: [{ ...command(), ...patch }] }), /^Error: SSH_/);
  }
  assert.throws(() => validateSshRegistration({ version: 1, commands: [command(), command()] }));
  assert.throws(() => validateSshRegistration({ version: 1, commands: Array.from({ length: 21 }, (_, n) => ({ ...command(), id: 'c' + n })) }));
});
test('SSH commands compile only approved host/device IDs from trusted profile mappings', () => {
  const host = { hostId: 'host-example', devices: [{ deviceId: 'disk-example', path: '/dev/nvme0n1', serial: 'EXAMPLE_SERIAL' }] };
  assert.equal(compileSshCommand(command(), host), '/usr/bin/uname -srm');
  const smart = { ...command(), operation: 'disk.smart.read', deviceIds: ['disk-example'] };
  assert.equal(compileSshCommand(smart, host, 'disk-example'), 'sudo -n -- /usr/sbin/smartctl --json=c --all /dev/nvme0n1');
  assert.throws(() => compileSshCommand(smart, host, 'unknown'), /SSH_DEVICE_NOT_APPROVED/);
  assert.throws(() => compileSshCommand(smart, { ...host, devices: [{ deviceId: 'disk-example', path: '/dev/sda' }] }, 'disk-example'), /SSH_DEVICE_IDENTITY_REQUIRED/);
  assert.throws(() => compileSshCommand(smart, { ...host, devices: [{ deviceId: 'disk-example', path: '/dev/sda;reboot' }] }, 'disk-example'), /SSH_DEVICE_UNAVAILABLE/);
  assert.throws(() => compileSshCommand(command(), { ...host, hostId: 'other' }), /SSH_TARGET_NOT_APPROVED/);
});
test('SSH review digest binds immutable package, scope, command, schedule and vault revision', () => {
  const plugin = { id: 'rivetin-example', packageId: 'a'.repeat(64) }, original = { version: 1, commands: [command()] };
  const digest = sshRegistrationDigest(plugin, original, 'v1');
  assert.notEqual(digest, sshRegistrationDigest({ ...plugin, packageId: 'b'.repeat(64) }, original, 'v1'));
  assert.notEqual(digest, sshRegistrationDigest(plugin, original, 'v2'));
  assert.notEqual(digest, sshRegistrationDigest(plugin, { version: 1, commands: [{ ...command(), intervalSeconds: 300 }] }, 'v1'));
});
test('SSH registry rejects excessive host-device expansion at upload validation time', () => {
  const smart = { ...command(), operation: 'disk.smart.read', hostIds: ['host-a', 'host-b'], deviceIds: Array.from({ length: 51 }, (_, n) => 'disk-' + n) };
  assert.throws(() => validateSshRegistration({ version: 1, commands: [smart] }), /SSH_TARGET_LIMIT/);
  assert.equal(validateSshRegistration({ version: 1, commands: [{ ...smart, deviceIds: smart.deviceIds.slice(0, 50) }] }).commands[0].deviceIds.length, 50);
});
test('SSH configured scopes are typed selectors, mutually exclusive with IDs and forbidden for unrelated operations', () => {
  const { hostIds, ...base } = command();
  const configured = { ...base, hostScope: 'configured' };
  assert.equal(validateSshRegistration({ version: 1, commands: [configured] }).commands[0].hostScope, 'configured');
  const smart = { ...configured, operation: 'disk.smart.read', deviceScope: 'configured' };
  assert.equal(validateSshRegistration({ version: 1, commands: [smart] }).commands[0].deviceScope, 'configured');
  for (const invalid of [{ ...base }, { ...configured, hostIds }, { ...configured, hostScope: 'all' }, { ...configured, deviceScope: 'configured' }, { ...smart, deviceIds: ['example-device'] }, { ...smart, deviceScope: 'arbitrary' }, { ...smart, deviceScope: undefined }]) assert.throws(() => validateSshRegistration({ version: 1, commands: [invalid] }), /^Error: SSH_/);
});
test('SSH configured device scope compiles only the selected trusted mapping, never a supplied path', () => {
  const { hostIds, ...base } = command();
  const scope = { ...base, operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured' };
  const host = { hostId: 'configured-host', devices: [{ deviceId: 'configured-device', path: '/dev/sdb', serial: 'EXAMPLE_SERIAL' }] };
  assert.equal(compileSshCommand(scope, host, 'configured-device'), 'sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sdb');
  assert.throws(() => compileSshCommand(scope, host, '/dev/sda'), /SSH_DEVICE_NOT_APPROVED/);
  assert.throws(() => compileSshCommand(scope, host, 'unmapped-device'), /SSH_DEVICE_UNAVAILABLE/);
});
test('SSH digest binds resolved command previews as well as original configured selectors', () => {
  const { hostIds, ...base } = command(), registration = { version: 1, commands: [{ ...base, hostScope: 'configured' }] }, plugin = { id: 'rivetin-example', packageId: 'a'.repeat(64) };
  const first = [{ id: 'identity', hostIds: ['host-a'], preview: ['host-a: /usr/bin/uname -srm'] }], second = [{ id: 'identity', hostIds: ['host-b'], preview: ['host-b: /usr/bin/uname -srm'] }];
  assert.notEqual(sshRegistrationDigest(plugin, registration, 'same-vault', first), sshRegistrationDigest(plugin, registration, 'same-vault', second));
});
