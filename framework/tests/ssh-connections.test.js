import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createSshVault } from '../server/ssh-vault.js';

const profile = () => ({ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, username: 'host-reader', hostKeySha256: 'a'.repeat(64), password: 'EXAMPLE_HOST_PASSWORD', devices: [{ deviceId: 'example-disk', path: '/dev/sda', serial: 'EXAMPLE_SERIAL' }] });
const target = () => { const { username, password, ...value } = profile(); return value; };
const connection = (username = 'global-reader', password = 'EXAMPLE_GLOBAL_PASSWORD') => ({ username, authType: 'password', password: { action: 'replace', value: password }, privateKey: { action: 'keep' } });
function payload(summary) {
  const edit = value => value === null ? null : { username: value.username, authType: value.authType, password: { action: 'keep' }, privateKey: { action: 'keep' } };
  return { version: 1, operationId: randomUUID(), global: edit(summary.global), clusters: summary.clusters.map(row => ({ clusterId: row.clusterId, connection: edit(row.connection) })), hosts: summary.hosts.map(({ connection, effective, ...value }) => ({ ...value, connection: edit(connection) })) };
}
async function fixture(t) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'ssh-connections-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const vault = createSshVault(root); return { vault, root, filename: path.join(vault.root, 'connections.v1.json') };
}

test('SSH connections precedence selects one complete credential host then cluster then global without changing target pins', async t => {
  const { vault } = await fixture(t); await vault.put(profile());
  let draft = payload(await vault.connections());
  draft.global = connection(); draft.clusters = [{ clusterId: 'example-cluster', connection: connection('cluster-reader', 'EXAMPLE_CLUSTER_PASSWORD') }];
  await vault.saveConnections(draft);
  assert.equal((await vault.get('example-host')).password, 'EXAMPLE_HOST_PASSWORD');
  assert.equal((await vault.connections()).hosts[0].effective.source, 'host');
  draft = payload(await vault.connections()); draft.hosts[0].connection = null; await vault.saveConnections(draft);
  assert.equal((await vault.get('example-host')).username, 'cluster-reader'); assert.equal((await vault.get('example-host')).password, 'EXAMPLE_CLUSTER_PASSWORD');
  draft = payload(await vault.connections()); draft.clusters = []; await vault.saveConnections(draft);
  const resolved = await vault.get('example-host');
  assert.equal(resolved.username, 'global-reader'); assert.equal(resolved.password, 'EXAMPLE_GLOBAL_PASSWORD');
  const { username, password, ...resolvedTarget } = resolved; assert.deepEqual(resolvedTarget, target());
  assert.equal((await vault.connections()).hosts[0].effective.source, 'global');
  assert.doesNotMatch(JSON.stringify({ summary: await vault.connections(), list: await vault.list() }), /EXAMPLE_(HOST|GLOBAL|CLUSTER)_PASSWORD/);
});

test('SSH first connections save preserves current explicit host credentials and original ciphertext bytes', async t => {
  const { vault } = await fixture(t); await vault.put(profile());
  const oldFile = path.join(vault.root, 'example-host.host.json'), before = await readFile(oldFile), initialRevision = await vault.revision();
  const draft = payload(await vault.connections()); draft.global = connection(); await vault.saveConnections(draft);
  assert.deepEqual(await vault.get('example-host'), profile()); assert.deepEqual(await readFile(oldFile), before);
  assert.notEqual(await vault.revision(), initialRevision); assert.equal((await vault.connections()).hosts[0].effective.source, 'host');
});

test('SSH a global credential alone cannot create or discover host targets', async t => {
  const { vault } = await fixture(t), draft = payload(await vault.connections()); draft.global = connection();
  await vault.saveConnections(draft); assert.deepEqual(await vault.list(), []);
  await assert.rejects(vault.get('not-configured'), /^Error: SSH_HOST_UNAVAILABLE$/);
});

test('SSH keep preserves secrets, explicit clear blocks fallback and only the selected auth method remains', async t => {
  const { vault } = await fixture(t); await vault.put(profile());
  let draft = payload(await vault.connections()); draft.global = connection(); await vault.saveConnections(draft);
  draft = payload(await vault.connections()); await vault.saveConnections(draft); assert.equal((await vault.get('example-host')).password, profile().password);
  draft = payload(await vault.connections()); draft.hosts[0].connection.password = { action: 'clear' }; await vault.saveConnections(draft);
  assert.equal((await vault.list())[0].credentialConfigured, false); assert.equal((await vault.connections()).hosts[0].effective.source, 'host');
  await assert.rejects(vault.get('example-host'), /^Error: SSH_CREDENTIAL_REQUIRED$/);
  // Synthetic PEM-shaped fixture, deliberately not usable for authentication.
  const key = [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'EXAMPLE_NOT_A_REAL_KEY', ['-----END', 'PRIVATE KEY-----'].join(' ')].join('\n');
  draft = payload(await vault.connections()); Object.assign(draft.hosts[0].connection, { authType: 'private-key', privateKey: { action: 'replace', value: key } });
  await vault.saveConnections(draft); const resolved = await vault.get('example-host'); assert.equal(resolved.privateKey, key); assert.equal(Object.hasOwn(resolved, 'password'), false);
  draft = payload(await vault.connections()); Object.assign(draft.hosts[0].connection, { authType: 'password', password: { action: 'replace', value: 'EXAMPLE_REPLACED_PASSWORD' } });
  await vault.saveConnections(draft); assert.equal(Object.hasOwn(await vault.get('example-host'), 'privateKey'), false);
});

test('SSH connection edits reject unknown fields, secret values on keep/clear, duplicate targets and missing pins without mutation', async t => {
  const { vault, filename } = await fixture(t); await vault.put(profile()); await vault.saveConnections(payload(await vault.connections()));
  const before = await readFile(filename), revision = await vault.revision();
  const edits = [
    value => { value.command = 'EXAMPLE_FORBIDDEN'; },
    value => { value.hosts[0].connection.password = { action: 'keep', value: 'EXAMPLE_FORBIDDEN' }; },
    value => { value.hosts[0].connection.password = { action: 'clear', value: '' }; },
    value => { value.hosts[0].connection.password = { action: 'replace', value: '' }; },
    value => { value.hosts[0].connection.privateKey = { action: 'replace', value: 'EXAMPLE_FORBIDDEN' }; },
    value => { value.hosts.push(structuredClone(value.hosts[0])); },
    value => { value.hosts[0].hostKeySha256 = ''; },
    value => { value.hosts[0].address = '0:0:0:0:0:0:0:1'; },
    value => { value.hosts[0].devices[0].path = '/dev/sda;id'; },
    value => { value.operationId = '../escape'; },
  ];
  for (const edit of edits) { const draft = payload(await vault.connections()); edit(draft); await assert.rejects(vault.saveConnections(draft), /^Error: SSH_/); assert.deepEqual(await readFile(filename), before); }
  assert.equal(await vault.revision(), revision);
});

test('SSH operation IDs confirm a single save and reject reuse with a different request', async t => {
  const { vault, filename } = await fixture(t), draft = payload(await vault.connections()); draft.global = connection();
  const first = await vault.saveConnections(draft), before = await readFile(filename), second = await vault.saveConnections(draft);
  assert.equal(first.operationId, draft.operationId); assert.deepEqual(first, second); assert.deepEqual(await readFile(filename), before);
  await assert.rejects(vault.saveConnections({ ...draft, global: connection('different-reader') }), /^Error: SSH_CONNECTION_OPERATION_CONFLICT$/);
});

test('SSH concurrent connection snapshots use last-save-wins while keep resolves against the latest scope', async t => {
  const { vault } = await fixture(t), summary = await vault.connections(), first = payload(summary), second = payload(summary);
  first.global = connection('first-reader'); second.global = connection('second-reader');
  const responses = await Promise.all([vault.saveConnections(first), vault.saveConnections(second)]), last = responses.find(row => row.revision === 2);
  assert.ok(last); assert.deepEqual(await vault.connections(), last);
});

test('SSH connections are authenticated encrypted with 0600 files and reject tampering without plaintext output', async t => {
  const { vault, filename } = await fixture(t), draft = payload(await vault.connections()); draft.global = connection(); draft.hosts = [{ ...target(), connection: null }];
  const summary = await vault.saveConnections(draft), bytes = await readFile(filename, 'utf8');
  assert.doesNotMatch(bytes, /EXAMPLE_GLOBAL_PASSWORD|global-reader|192\.0\.2\.10|EXAMPLE_SERIAL/);
  assert.doesNotMatch(JSON.stringify(summary), /EXAMPLE_GLOBAL_PASSWORD/);
  if (process.platform !== 'win32') { assert.equal((await stat(filename)).mode & 0o077, 0); assert.equal((await stat(path.join(vault.root, 'key.json'))).mode & 0o077, 0); }
  const value = JSON.parse(bytes); await writeFile(filename, JSON.stringify({ ...value, tag: '0'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(vault.connections(), /^Error: SSH_VAULT_INVALID$/); await assert.rejects(vault.get('example-host'), /^Error: SSH_VAULT_INVALID$/);
});

test('SSH missing key with only new connections ciphertext refuses replacement and preserves bytes', async t => {
  const { vault, filename } = await fixture(t), draft = payload(await vault.connections()); draft.global = connection(); await vault.saveConnections(draft);
  const before = await readFile(filename); await rm(path.join(vault.root, 'key.json'));
  await assert.rejects(vault.saveConnections({ ...draft, operationId: randomUUID() }), /^Error: SSH_VAULT_/);
  await assert.rejects(vault.put(profile()), /^Error: SSH_VAULT_/);
  assert.deepEqual(await readFile(filename), before); assert.deepEqual(await readdir(vault.root), ['connections.v1.json']);
});

test('SSH CLI put and remove remain authoritative after connection settings are saved', async t => {
  const { vault } = await fixture(t), draft = payload(await vault.connections()); draft.global = connection(); await vault.saveConnections(draft);
  await vault.put(profile()); assert.deepEqual(await vault.get('example-host'), profile());
  await vault.put({ ...profile(), port: 2222 }); assert.equal((await vault.get('example-host')).port, 2222);
  await vault.remove('example-host'); assert.deepEqual(await vault.list(), []); assert.ok((await vault.connections()).global.hasPassword);
  assert.equal((await vault.connections()).operationId, null);
});

test('SSH renamed scopes never inherit a kept secret from an unrelated old scope', async t => {
  const { vault } = await fixture(t); await vault.put(profile()); await vault.saveConnections(payload(await vault.connections()));
  const draft = payload(await vault.connections()); draft.hosts[0].hostId = 'different-host'; await vault.saveConnections(draft);
  assert.equal((await vault.list())[0].credentialConfigured, false); await assert.rejects(vault.get('different-host'), /^Error: SSH_CREDENTIAL_REQUIRED$/);
});
