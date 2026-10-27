import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { smartFixture, caller } from './data-fixture.js';
import { createSshConnectionsStore } from '../src/ssh-connection-settings.js';

test('connection drafts save through shared HTTP into encrypted storage and revoke prior approval', async t => {
  const f = await smartFixture(t); await f.approve();
  let writes = 0;
  const store = createSshConnectionsStore({ crypto: webcrypto, client: (...args) => { if (args[1] === 'PUT') writes++; return f.client(...args); } });
  t.after(() => store.dispose()); await store.load();
  assert.equal(store.status().loaded, true);
  const draft = store.getDraft();
  store.update({ global: { username: 'global-reader', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_NOT_A_REAL_GLOBAL_SECRET' }, privateKey: { action: 'keep' } }, hosts: draft.hosts.map(host => ({ ...host, connection: null })) });
  assert.equal(writes, 0); assert.equal(store.status().dirty, true);
  assert.equal(await store.save(), true); assert.equal(writes, 1); assert.equal(store.status().dirty, false);
  const summary = await f.client('/ssh-channel/connections'), profile = await f.service.sshHosts.get('example-host');
  assert.equal(summary.hosts[0].effective.source, 'global'); assert.equal(profile.username, 'global-reader');
  assert.equal(profile.password, 'EXAMPLE_NOT_A_REAL_GLOBAL_SECRET');
  assert.ok(!JSON.stringify(summary).includes('EXAMPLE_NOT_A_REAL_GLOBAL_SECRET'));
  assert.ok(!JSON.stringify(store.getDraft()).includes('EXAMPLE_NOT_A_REAL_GLOBAL_SECRET'));
  assert.ok(!(await readFile(path.join(f.directory, 'ssh-channel/vault/connections.v1.json'), 'utf8')).includes('EXAMPLE_NOT_A_REAL_GLOBAL_SECRET'));
  await assert.rejects(f.collect(), /SSH_APPROVAL_REQUIRED/); assert.equal(f.runs(), 0);
  const logs = await f.service.logs(); assert.ok(logs.items.some(item => item.action === 'ssh.connections.save'));
  assert.ok(!JSON.stringify(logs).includes('EXAMPLE_NOT_A_REAL_GLOBAL_SECRET'));
});

test('discard never writes credentials and nonadministrators cannot read or save them', async t => {
  const f = await smartFixture(t); let writes = 0;
  const store = createSshConnectionsStore({ crypto: webcrypto, client: (...args) => { if (args[1] === 'PUT') writes++; return f.client(...args); } });
  t.after(() => store.dispose()); await store.load();
  store.update({ global: { username: 'global-reader', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_NOT_A_REAL_DRAFT_SECRET' }, privateKey: { action: 'keep' } } });
  store.discard(); assert.equal(store.status().dirty, false); assert.equal(writes, 0);
  assert.ok(!JSON.stringify(store.getDraft()).includes('EXAMPLE_NOT_A_REAL_DRAFT_SECRET'));
  assert.throws(() => f.service.sshConnections({ ...caller, admin: false }), error => error.status === 403);
  assert.throws(() => f.service.sshSaveConnections({}, { ...caller, admin: false }), error => error.status === 403);
});
