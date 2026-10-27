import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createSshVault, validateSshHost } from '../server/ssh-vault.js';

const profile = () => ({ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, username: 'collector', hostKeySha256: 'a'.repeat(64), password: 'EXAMPLE_NOT_A_REAL_SECRET', devices: [{ deviceId: 'example-disk', path: '/dev/sda', serial: 'EXAMPLE_SERIAL' }] });
async function fixture(t) { const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'ssh-vault-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })); return createSshVault(root); }
test('SSH vault encrypts credentials, keeps host keys pinned and never returns secrets from listing', async t => {
  const vault = await fixture(t), initial = await vault.revision();
  await vault.put(profile());
  const encrypted = await readFile(path.join(vault.root, 'example-host.host.json'), 'utf8');
  assert.ok(!encrypted.includes(profile().password)); assert.ok(!encrypted.includes(profile().username));
  assert.deepEqual(await vault.get('example-host'), profile());
  assert.ok(!JSON.stringify(await vault.list()).includes(profile().password));
  assert.notEqual(await vault.revision(), initial);
  await vault.remove('example-host'); assert.deepEqual(await vault.list(), []);
});
test('SSH vault rejects unpinned, malformed, local, injected and unbounded host profiles', () => {
  for (const patch of [{ hostKeySha256: '' }, { hostKeySha256: 'SHA256:' + 'A'.repeat(43) }, { address: '127.0.0.1' }, { address: '169.254.169.254' }, { address: '::1' }, { username: 'user;id' }, { hostId: '../escape' }, { port: 0 }, { command: 'id' }, { devices: [{ deviceId: 'x', path: '/dev/sda;id' }] }, { privateKey: 'bad' }]) assert.throws(() => validateSshHost({ ...profile(), ...patch }), /^Error: SSH_/);
});
test('SSH vault detects ciphertext tampering and host identity substitution without recreating a missing key', async t => {
  const vault = await fixture(t); await vault.put(profile());
  const filename = path.join(vault.root, 'example-host.host.json'), value = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify({ ...value, tag: '0'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(vault.get('example-host'), /SSH_VAULT_INVALID/);
  await vault.put(profile());
  await rm(path.join(vault.root, 'key.json'));
  await assert.rejects(vault.get('example-host'), /SSH_HOST_UNAVAILABLE/);
  assert.ok(!(await readdir(vault.root)).includes('key.json'));
});
test('SSH vault rejects equivalent IPv6 local, link-local, multicast and mapped address forms', () => {
  for (const address of ['::', '0:0:0:0:0:0:0:0', '0000::', '::1', '0:0:0:0:0:0:0:1', '0000::0001', 'fe80::1', 'FE80:0:0:0:0:0:0:1', 'febf:0:0:0:0:0:0:1', 'ff02::1', 'FF02:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '0000::ffff:192.0.2.10', 'fe80::1%example'])
    assert.throws(() => validateSshHost({ ...profile(), address }), /^Error: SSH_HOST_ADDRESS_REJECTED$/, address);
  for (const address of ['2001:db8::10', '2001:0DB8:0000:0000:0000:0000:0000:0010', 'fd00::10'])
    assert.equal(validateSshHost({ ...profile(), address }).address, address);
});
test('SSH vault refuses imports over a missing key, preserves ciphertext and supports restoring the original key', async t => {
  const vault = await fixture(t); await vault.put(profile());
  await vault.put({ ...profile(), hostId: 'second-host' });
  const filename = path.join(vault.root, 'example-host.host.json'), keyFile = path.join(vault.root, 'key.json');
  const secondFile = path.join(vault.root, 'second-host.host.json');
  const original = await readFile(filename), second = await readFile(secondFile), key = await readFile(keyFile);
  await rm(keyFile);
  for (const hostId of ['example-host', 'third-host']) await assert.rejects(vault.put({ ...profile(), hostId }), /^Error: SSH_VAULT_KEY_MISSING$/);
  assert.deepEqual(await readFile(filename), original);
  assert.deepEqual(await readFile(secondFile), second);
  assert.deepEqual((await readdir(vault.root)).sort(), ['example-host.host.json', 'second-host.host.json']);
  await writeFile(keyFile, key, { mode: 0o600, flag: 'wx' });
  assert.deepEqual(await vault.get('example-host'), profile());
  assert.deepEqual(await vault.get('second-host'), { ...profile(), hostId: 'second-host' });
  await vault.put({ ...profile(), hostId: 'third-host' }); assert.equal((await vault.list()).length, 3);
});
test('SSH vault rejects corrupt keys with fixed errors and preserves all original data bytes', async t => {
  const vault = await fixture(t); await vault.put(profile());
  const filename = path.join(vault.root, 'example-host.host.json'), keyFile = path.join(vault.root, 'key.json'), original = await readFile(filename);
  for (const corrupted of ['EXAMPLE_PRIVATE_CORRUPT_KEY', 'null', '{}', JSON.stringify({ key: 'EXAMPLE_INVALID_KEY' })]) {
    await writeFile(keyFile, corrupted, { mode: 0o600 });
    await assert.rejects(vault.put({ ...profile(), hostId: 'second-host' }), /^Error: SSH_VAULT_INVALID$/);
    await assert.rejects(vault.get('example-host'), /^Error: SSH_VAULT_INVALID$/);
    assert.equal(await readFile(keyFile, 'utf8'), corrupted); assert.deepEqual(await readFile(filename), original);
    assert.deepEqual((await readdir(vault.root)).sort(), ['example-host.host.json', 'key.json']);
  }
});
test('SSH vault concurrent first imports share one durable key and remain independently readable', async t => {
  const vault = await fixture(t);
  const profiles = [profile(), { ...profile(), hostId: 'second-host' }];
  const results = await Promise.all(profiles.map(item => vault.put(item)));
  assert.ok(results.every(item => item.saved));
  const keyFile = path.join(vault.root, 'key.json'), key = await readFile(keyFile);
  assert.deepEqual(await Promise.all(profiles.map(item => vault.get(item.hostId))), profiles);
  await vault.put({ ...profile(), hostId: 'third-host' });
  assert.deepEqual(await readFile(keyFile), key); assert.equal((await vault.list()).length, 3);
});
