import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSshBroker } from '../server/ssh-broker.js';

const actor = { id: 'example-root', source: 'tower', admin: true, role: 'ROOT' };
async function fixture(t, run) {
  const base = path.resolve('qa/identity'); await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'test-'));
  t.after(async () => { if (!directory.startsWith(base + path.sep)) throw new Error('TEST_OUTSIDE_WORKSPACE'); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let revision = 'revision-one', time = Date.now(), calls = 0;
  const host = { hostId: 'EXAMPLE_HOST', clusterId: 'EXAMPLE_CLUSTER', address: '192.0.2.10', port: 22, hostKeySha256: 'a'.repeat(64), username: 'example', password: 'EXAMPLE_NOT_A_REAL_SECRET', devices: [] };
  const status = { enabled: true, channelInstalled: true, channelEnabled: true, plugins: [{ id: 'rivetin-ssh-channel', enabled: true, installed: true, packageId: 'b'.repeat(64), version: '0.1.2' }] };
  const inventory = { hosts: [{ id: host.hostId, clusterId: host.clusterId, address: host.address }] }, events = [];
  const options = { serviceStatus: async () => structuredClone(status), inventory: async () => { await options.onInventory?.(); return structuredClone(inventory); },
    vault: { revision: async () => revision, get: async id => { assert.equal(id, host.hostId); return structuredClone(host); }, list: async () => [] },
    run: async input => { calls++; assert.equal(input.command, '/usr/bin/uname -srm'); assert.equal(input.maxBytes, 1024); return run ? run(input) : { exitCode: 0, stdout: 'Linux 6.1.0-example x86_64\n' }; },
    audit: async event => { await options.onAudit?.(event); if (options.failFinalAudit && event.action === 'ssh.identity.execute' && event.result !== 'started') throw new Error('EXAMPLE_PRIVATE_AUDIT_ERROR'); events.push(event); }, now: () => time, manualOnly: true };
  const broker = createSshBroker(directory, options); t.after(() => broker.stop());
  async function grant(who = actor) { const review = await broker.identity.review(host.hostId, who); return broker.identity.approve({ challenge: review.challenge, digest: review.digest, acknowledged: true }, who); }
  return { broker, directory, options, host, status, inventory, events, grant, calls: () => calls, revision(value) { revision = value; }, advance(ms) { time += ms; }, input: approval => ({ hostId: host.hostId, digest: approval.digest, approvalId: approval.approvalId, requestId: randomUUID() }) };
}

test('built-in identity is single-host, human-approved, on demand and returns only parsed fields', async t => {
  const f = await fixture(t); const approval = await f.grant(); assert.equal(f.calls(), 0);
  const input = f.input(approval), result = await f.broker.identity.execute(input, actor);
  assert.equal(result.status, 'success'); assert.deepEqual(result.identity, { system: 'Linux', release: '6.1.0-example', architecture: 'x86_64' });
  assert.doesNotMatch(JSON.stringify(result), /stdout|stderr|password|EXAMPLE_NOT_A_REAL_SECRET/);
  assert.equal(f.calls(), 1); assert.equal((await f.broker.identity.result(input.requestId, actor)).status, 'success');
});
test('same request replays the original result while changed input and a reused grant cannot execute', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval);
  const first = await f.broker.identity.execute(input, actor);
  assert.deepEqual(await f.broker.identity.execute(input, actor), first);
  await assert.rejects(f.broker.identity.execute({ ...input, hostId: 'OTHER_HOST' }, actor), /REQUEST_CONFLICT/);
  await assert.rejects(f.broker.identity.execute({ ...input, requestId: randomUUID() }, actor), /APPROVAL_REQUIRED/); assert.equal(f.calls(), 1);
});
test('actor identity/source, admin, exact fields and command substitution fail closed', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval);
  for (const who of [{ ...actor, id: 'other' }, { ...actor, source: 'cli' }]) await assert.rejects(f.broker.identity.execute(input, who), /APPROVAL_REQUIRED/);
  await assert.rejects(f.broker.identity.review(f.host.hostId, { ...actor, admin: false }), /SSH_ADMIN_REQUIRED/);
  await assert.rejects(f.broker.identity.execute({ ...input, command: 'id' }, actor), /REQUEST_INVALID/); assert.equal(f.calls(), 0);
});

test('Tower ADMIN cannot review, approve, execute or read ROOT diagnostic receipts even in a legacy vault', async t => {
  const f = await fixture(t), admin = { ...actor, role: 'ADMIN' };
  await assert.rejects(f.broker.identity.review(f.host.hostId, admin), /SSH_ROOT_REQUIRED/);
  const review = await f.broker.identity.review(f.host.hostId, actor);
  await assert.rejects(f.broker.identity.approve({ challenge: review.challenge, digest: review.digest, acknowledged: true }, admin), /SSH_ROOT_REQUIRED/);
  const approval = await f.grant(), input = f.input(approval);
  await assert.rejects(f.broker.identity.execute(input, admin), /SSH_ROOT_REQUIRED/);
  await f.broker.identity.execute(input, actor);
  await assert.rejects(f.broker.identity.result(input.requestId, admin), /SSH_ROOT_REQUIRED/);
  await assert.rejects(f.broker.identity.recent(admin), /SSH_ROOT_REQUIRED/); assert.equal(f.calls(), 1);
});

test('final audit failure cannot publish a successful receipt or execute again on result replay', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval); f.options.failFinalAudit = true;
  await assert.rejects(f.broker.identity.execute(input, actor), /SSH_IDENTITY_AUDIT_FAILED/);
  const receipt = await f.broker.identity.result(input.requestId, actor); assert.equal(receipt.status, 'running'); assert.equal(receipt.outcomeUnknown, true); assert.equal(receipt.identity, undefined);
  assert.deepEqual(await f.broker.identity.execute(input, actor), receipt); assert.equal(f.calls(), 1);
  assert.doesNotMatch(await readFile(path.join(f.directory, 'ssh-channel/identity.v1.json'), 'utf8'), /EXAMPLE_PRIVATE_AUDIT_ERROR|"success"|"identity"/);
});

test('cancellation while final inventory verification is awaiting cannot publish success', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval); let afterTransport = 0;
  f.options.onInventory = () => { if (f.calls() && ++afterTransport === 2) f.broker.identity.cancel(); };
  const result = await f.broker.identity.execute(input, actor);
  assert.equal(result.status, 'failed'); assert.equal(result.identity, undefined);
});

test('store budget measures the actual formatted bytes and refuses before replacing the receipt ledger', async t => {
  const f = await fixture(t), requests = {};
  for (let n = 0; n < 5000; n++) {
    const id = randomUUID(); requests[id] = { owner: 'a'.repeat(64), binding: 'b'.repeat(64), result: { requestId: id, hostId: 'E'.repeat(32), status: 'running', startedAt: new Date().toISOString() } };
  }
  const value = { version: 1, grants: {}, requests }, compact = JSON.stringify(value);
  assert.ok(Buffer.byteLength(compact) < 2 * 1024 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) > 2 * 1024 * 1024);
  const root = path.join(f.directory, 'ssh-channel'); await mkdir(root, { recursive: true }); const file = path.join(root, 'identity.v1.json'); await writeFile(file, compact);
  await assert.rejects(f.grant(), /SSH_IDENTITY_STORE_LIMIT/); assert.equal(await readFile(file, 'utf8'), compact);
});

test('grant expiry while final inventory is awaiting suppresses identity publication', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval); let afterTransport = 0;
  f.options.onInventory = () => { if (f.calls() && ++afterTransport === 2) f.advance(120001); };
  const result = await f.broker.identity.execute(input, actor); assert.equal(result.status, 'failed'); assert.equal(result.identity, undefined);
});

test('cancellation during final audit is rechecked before publishing the completed receipt', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval);
  f.options.onAudit = event => { if (event.action === 'ssh.identity.execute' && event.result === 'success') f.broker.identity.cancel(); };
  const result = await f.broker.identity.execute(input, actor); assert.equal(result.status, 'failed'); assert.equal(result.identity, undefined);
});
test('challenge is actor bound, expires in two minutes, and never approves all configured hosts', async t => {
  const f = await fixture(t), review = await f.broker.identity.review(f.host.hostId, actor);
  assert.equal(review.kind, 'builtin-host-identity'); assert.equal(review.hostId, f.host.hostId); assert.equal(review.intervalSeconds, 0);
  await assert.rejects(f.broker.identity.approve({ challenge: review.challenge, digest: review.digest, acknowledged: true }, { ...actor, id: 'other' }), /CONFIRMATION_REQUIRED/);
  const next = await f.broker.identity.review(f.host.hostId, actor); f.advance(120001);
  await assert.rejects(f.broker.identity.approve({ challenge: next.challenge, digest: next.digest, acknowledged: true }, actor), /CONFIRMATION_REQUIRED/);
});
for (const [label, mutate] of [
  ['grant expiry', f => f.advance(120001)], ['vault revision', f => f.revision('changed')],
  ['pin rotation', f => { f.host.hostKeySha256 = 'c'.repeat(64); }], ['package replacement', f => { f.status.plugins[0].packageId = 'c'.repeat(64); }],
  ['framework disabled', f => { f.status.enabled = false; }], ['channel disabled', f => { f.status.channelEnabled = false; }],
  ['target address drift', f => { f.inventory.hosts[0].address = '192.0.2.20'; }], ['cluster drift', f => { f.inventory.hosts[0].clusterId = 'OTHER_CLUSTER'; }],
]) test(`${label} rejects a previously approved identity plan`, async t => {
  const f = await fixture(t), approval = await f.grant(); mutate(f);
  await assert.rejects(f.broker.identity.execute(f.input(approval), actor)); assert.equal(f.calls(), 0);
});
test('global and channel revocation invalidate diagnostic grants independently of consumer registration', async t => {
  const f = await fixture(t), approval = await f.grant(); await f.broker.invalidate(null);
  await assert.rejects(f.broker.identity.execute(f.input(approval), actor), /APPROVAL_REVOKED/); assert.equal(f.calls(), 0);
});
test('revocation during transport aborts the diagnostic and suppresses identity publication', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, ({ signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('SSH_EXECUTION_CANCELLED')), { once: true }); }));
  const approval = await f.grant(), task = f.broker.identity.execute(f.input(approval), actor); await ready; await f.broker.invalidate(null);
  const result = await task; assert.equal(result.status, 'failed'); assert.equal(result.outcomeUnknown, true); assert.equal(result.identity, undefined);
});
for (const output of [ { exitCode: 1, stdout: 'EXAMPLE_PRIVATE_OUTPUT', stderr: 'EXAMPLE_PRIVATE_ERROR' }, { exitCode: 0, stdout: 'Linux release x86_64\nEXAMPLE_PRIVATE_OUTPUT' }, { exitCode: 0, stdout: 'x'.repeat(1025) } ])
  test('invalid or failed remote output is bounded and never returned or retained', async t => {
    const f = await fixture(t, async () => output), approval = await f.grant(), result = await f.broker.identity.execute(f.input(approval), actor);
    assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|stdout|stderr/);
    assert.doesNotMatch(await readFile(path.join(f.directory, 'ssh-channel/identity.v1.json'), 'utf8'), /PRIVATE|stdout|stderr|EXAMPLE_NOT_A_REAL_SECRET/);
  });
test('a persisted in-flight request after restart stays unknown and cannot be re-executed', async t => {
  const f = await fixture(t), approval = await f.grant(), input = f.input(approval);
  await f.broker.identity.execute(input, actor);
  const file = path.join(f.directory, 'ssh-channel/identity.v1.json'), value = JSON.parse(await readFile(file, 'utf8'));
  const result = value.requests[input.requestId].result; value.requests[input.requestId].result = { requestId: input.requestId, hostId: input.hostId, status: 'running', startedAt: result.startedAt }; await writeFile(file, JSON.stringify(value));
  const fresh = createSshBroker(f.directory, f.options); t.after(() => fresh.stop());
  assert.equal((await fresh.identity.execute(input, actor)).outcomeUnknown, true); assert.equal(f.calls(), 1);
});
