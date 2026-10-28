import test from 'node:test';
import assert from 'node:assert/strict';
import { createSshPreflight } from '../server/ssh-preflight.js';

const actor = { id: 'example-admin', name: 'Example administrator', source: 'demo', admin: true, auth: { Authorization: 'Bearer EXAMPLE_NOT_REAL' } };
const input = (patch = {}) => ({ hostId: 'host-example', address: '192.0.2.10', port: 22, actor, ...patch });
const fingerprint = hash => 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '');
function fixture(options = {}) {
  const state = { now: Date.now(), active: true, inventory: { hosts: [{ id: 'host-example', address: '192.0.2.10', clusterId: 'cluster-example' }], clusters: [] }, revision: 'a'.repeat(64), calls: [], audits: [], vaultReads: 0 };
  const profile = { hostId: 'host-example', address: '192.0.2.10', port: 22, username: 'collector', password: 'EXAMPLE_NEVER_LOGGED', hostKeySha256: 'b'.repeat(64) };
  const transport = { discover: async args => { state.calls.push({ type: 'discover', args }); return options.discover ? options.discover(args, state) : { algorithm: 'ssh-ed25519', sha256Hex: 'b'.repeat(64), fingerprint: fingerprint('b'.repeat(64)) }; },
    verify: async args => { state.calls.push({ type: 'verify', args }); return options.verify ? options.verify(args, state) : { verified: true }; } };
  const preflight = createSshPreflight({ inventory: async (who, context) => { assert.equal(who.auth.Authorization, actor.auth.Authorization); assert.ok(context.signal instanceof AbortSignal); return structuredClone(state.inventory); },
    vault: { get: async () => { state.vaultReads++; return structuredClone(profile); }, revision: async () => state.revision }, transport, now: () => state.now,
    assertActive: async () => { if (!state.active) throw Object.assign(new Error('SSH_CHANNEL_DISABLED'), { status: 403 }); },
    audit: async event => { state.audits.push(event); if (options.audit) await options.audit(event); } });
  return { state, preflight };
}

test('discovery binds a fresh fingerprint challenge to the actor and target; confirmation returns only a draft', async () => {
  const f = fixture(), found = await f.preflight.discover(input()); assert.equal(found.fingerprint, fingerprint('b'.repeat(64))); assert.match(found.challenge, /^[a-f0-9]{64}$/); assert.equal(f.state.vaultReads, 0);
  const confirmed = await f.preflight.confirm(input({ challenge: found.challenge, acknowledged: true })); assert.deepEqual(confirmed, { hostId: 'host-example', address: '192.0.2.10', port: 22, sha256Hex: 'b'.repeat(64), confirmed: true });
  await assert.rejects(f.preflight.confirm(input({ challenge: found.challenge, acknowledged: true })), { message: 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED', status: 409 });
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.vaultReads, 0);
});

test('challenge cannot be confirmed by another actor, altered scope, expired TTL or without acknowledgment', async () => {
  const f = fixture();
  for (const patch of [{ actor: { ...actor, id: 'another-admin' } }, { port: 2222 }, { acknowledged: false }]) {
    const found = await f.preflight.discover(input()); await assert.rejects(f.preflight.confirm(input({ challenge: found.challenge, acknowledged: true, ...patch })), { message: 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED', status: 409 });
  }
  const found = await f.preflight.discover(input()); f.state.now += 120001; await assert.rejects(f.preflight.confirm(input({ challenge: found.challenge, acknowledged: true })), { message: 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED', status: 409 });
});

test('inventory permissions, exact host management IP and current target digest constrain every action', async () => {
  const f = fixture();
  for (const patch of [{ address: 'tower.example.invalid' }, { address: '127.0.0.1' }, { address: '169.254.169.254' }, { address: '::ffff:127.0.0.1' }, { port: 0 }, { password: 'EXAMPLE_NOT_ALLOWED' }]) await assert.rejects(f.preflight.discover(input(patch)), { status: 400 });
  await assert.rejects(f.preflight.discover(input({ address: '192.0.2.11' })), { status: 409 }); await assert.rejects(f.preflight.discover(input({ hostId: 'other-host' })), { status: 404 });
  await assert.rejects(f.preflight.discover(input({ actor: { ...actor, admin: false } })), { status: 403 }); assert.equal(f.state.calls.length, 0);
  const found = await f.preflight.discover(input()); f.state.inventory.hosts[0].clusterId = 'changed-cluster';
  await assert.rejects(f.preflight.confirm(input({ challenge: found.challenge, acknowledged: true })), { message: 'SSH_PREFLIGHT_TARGET_CHANGED', status: 409 });
});

test('verify uses only a saved pinned effective connection and rejects configuration changes during authentication', async () => {
  const f = fixture(), result = await f.preflight.verify({ hostId: 'host-example', actor }); assert.equal(result.verified, true); assert.equal(result.hostId, 'host-example'); assert.equal(f.state.calls[0].args.host.password, 'EXAMPLE_NEVER_LOGGED'); assert.ok(f.state.calls[0].args.timeoutMs <= 5000);
  await assert.rejects(f.preflight.verify({ hostId: 'host-example', actor, password: 'EXAMPLE_NOT_ALLOWED' }), { status: 400 });
  const changed = fixture({ verify: async (_, state) => { state.revision = 'c'.repeat(64); return { verified: true }; } }); await assert.rejects(changed.preflight.verify({ hostId: 'host-example', actor }), { message: 'SSH_PREFLIGHT_CONNECTION_CHANGED', status: 409 });
  const moved = fixture({ verify: async (_, state) => { state.inventory.hosts[0].address = '192.0.2.11'; return { verified: true }; } }); await assert.rejects(moved.preflight.verify({ hostId: 'host-example', actor }), { status: 409 });
});

test('verification cannot begin while the framework/channel gate is closed and does not log credentials or raw errors', async () => {
  const f = fixture({ verify: async () => { throw new Error('EXAMPLE_NEVER_LOGGED raw error'); } }); f.state.active = false;
  await assert.rejects(f.preflight.verify({ hostId: 'host-example', actor }), { message: 'SSH_CHANNEL_DISABLED', status: 403 }); assert.equal(f.state.vaultReads, 0);
  f.state.active = true; await assert.rejects(f.preflight.verify({ hostId: 'host-example', actor }), { message: 'SSH_PREFLIGHT_FAILED', status: 503 });
  const audit = JSON.stringify(f.state.audits); for (const forbidden of ['EXAMPLE_NEVER_LOGGED', 'EXAMPLE_NOT_REAL', '192.0.2.10', 'raw error', 'fingerprint']) assert.ok(!audit.includes(forbidden));
});

test('global two/actor one concurrency bounds and cancellation destroy current work and clear challenges', async () => {
  const waits = [], f = fixture({ verify: async args => new Promise((_, reject) => { waits.push(args); args.signal.addEventListener('abort', () => reject(new Error('SSH_ABORTED')), { once: true }); }) });
  const found = await f.preflight.discover(input());
  const first = f.preflight.verify({ hostId: 'host-example', actor }), secondActor = { ...actor, id: 'second-admin' };
  const second = f.preflight.verify({ hostId: 'host-example', actor: secondActor });
  const firstRejected = assert.rejects(first, { message: 'SSH_PREFLIGHT_CANCELLED', status: 409 }), secondRejected = assert.rejects(second, { message: 'SSH_PREFLIGHT_CANCELLED', status: 409 });
  await assert.rejects(f.preflight.verify({ hostId: 'host-example', actor }), { message: 'SSH_PREFLIGHT_BUSY', status: 429 });
  await assert.rejects(f.preflight.verify({ hostId: 'host-example', actor: { ...actor, id: 'third-admin' } }), { status: 429 });
  while (waits.length < 2) await new Promise(resolve => setImmediate(resolve)); f.preflight.cancel(); await Promise.all([firstRejected, secondRejected]); assert.ok(waits.every(item => item.signal.aborted));
  await assert.rejects(f.preflight.confirm(input({ challenge: found.challenge, acknowledged: true })), { message: 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED', status: 409 });
  assert.equal((await f.preflight.discover(input())).hostId, 'host-example'); f.preflight.stop(); await assert.rejects(f.preflight.discover(input()), { message: 'SSH_PREFLIGHT_STOPPED', status: 503 });
});

test('overall five-second deadline aborts late inventory before any authentication can start', async t => {
  let finish, connected = 0; const preflight = createSshPreflight({ inventory: async () => new Promise(resolve => { finish = resolve; }), vault: { get: async () => ({ hostId: 'host-example', address: '192.0.2.10', port: 22, hostKeySha256: 'b'.repeat(64) }), revision: async () => 'a' }, transport: { discover: async () => { connected++; }, verify: async () => { connected++; } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = preflight.verify({ hostId: 'host-example', actor }), rejected = assert.rejects(pending, { message: 'SSH_PREFLIGHT_TIMEOUT', status: 504 });
  while (!finish) await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(5000); await rejected;
  finish({ hosts: [{ id: 'host-example', address: '192.0.2.10' }] }); await new Promise(resolve => setImmediate(resolve)); assert.equal(connected, 0);
});

test('challenge capacity is bounded, expired capacity is reclaimed and audit failure does not publish trust', async () => {
  const f = fixture(); for (let count = 0; count < 100; count++) await f.preflight.discover(input());
  await assert.rejects(f.preflight.discover(input()), { message: 'SSH_PREFLIGHT_CHALLENGE_LIMIT', status: 429 }); assert.equal(f.state.calls.length, 100);
  f.state.now += 120001; assert.ok((await f.preflight.discover(input())).challenge);
  let broken = true; const failed = fixture({ audit: async event => { if (broken && event.result === 'success') throw new Error('EXAMPLE_AUDIT_SECRET'); } });
  await assert.rejects(failed.preflight.discover(input()), { message: 'SSH_PREFLIGHT_AUDIT_FAILED', status: 503 }); broken = false;
  for (let count = 0; count < 100; count++) await failed.preflight.discover(input());
});
