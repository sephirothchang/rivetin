import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { createSshTransport } from '../server/ssh-transport.js';

const host = { address: '127.0.0.1', port: 22, username: 'collector', password: 'EXAMPLE_PASSWORD', hostKeySha256: 'a'.repeat(64) };
const algorithm = Buffer.from('ssh-ed25519'), rawKey = Buffer.concat([Buffer.from([0, 0, 0, algorithm.length]), algorithm, Buffer.alloc(36, 1)]);
function fake({ key = 'a'.repeat(64), hang = false, error, earlyAuth = false } = {}) {
  const state = { options: null, auth: [], destroyed: 0, ended: 0, commands: 0 };
  class Client extends EventEmitter {
    connect(options) { state.options = options; queueMicrotask(() => {
      if (hang) return;
      if (earlyAuth) options.authHandler(null, false, value => state.auth.push(value));
      const accepted = options.hostVerifier(options.hostHash ? key : rawKey); if (!accepted) { this.emit('error', new Error('EXAMPLE_RAW_ERROR')); return; }
      options.authHandler(null, false, value => state.auth.push(value)); if (error) { this.emit('error', error); return; } this.emit('ready');
    }); }
    exec() { state.commands++; throw new Error('EXEC_MUST_NEVER_BE_CALLED'); }
    shell() { throw new Error('SHELL_MUST_NEVER_BE_CALLED'); }
    destroy() { state.destroyed++; }
    end() { state.ended++; }
  }
  return { state, transport: createSshTransport({ Client }) };
}

test('fingerprint discovery rejects the key before any authentication and passes no credential or agent', async () => {
  const f = fake(), found = await f.transport.discover({ address: host.address, port: 22 });
  assert.equal(found.algorithm, 'ssh-ed25519'); assert.equal(found.sha256Hex, createHash('sha256').update(rawKey).digest('hex')); assert.equal(found.fingerprint, 'SHA256:' + createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, ''));
  for (const name of ['password', 'privateKey', 'agent', 'hostHash']) assert.equal(f.state.options[name], undefined); assert.equal(f.state.options.tryKeyboard, false); assert.equal(f.state.options.agentForward, false); assert.deepEqual(f.state.auth, []); assert.equal(f.state.commands, 0); assert.equal(f.state.destroyed, 1);
  await assert.rejects(f.transport.discover({ address: host.address, port: 22, password: 'EXAMPLE_REJECT' }), /SSH_INVALID_HOST/);
});

test('saved pin verification authenticates only after matching the pin and immediately closes without exec', async () => {
  const f = fake({ earlyAuth: true }); assert.deepEqual(await f.transport.verify({ host }), { verified: true }); assert.deepEqual(f.state.auth, [false, 'password']); assert.equal(f.state.commands, 0); assert.equal(f.state.ended, 1);
  const wrong = fake({ key: 'b'.repeat(64), earlyAuth: true }); await assert.rejects(wrong.transport.verify({ host }), /SSH_HOST_KEY_MISMATCH/); assert.deepEqual(wrong.state.auth, [false]); assert.equal(wrong.state.commands, 0);
  const failed = fake({ error: { level: 'client-authentication', message: 'EXAMPLE_PASSWORD' } }); await assert.rejects(failed.transport.verify({ host }), /^Error: SSH_AUTHENTICATION_FAILED$/);
});

test('preflight deadlines are capped at five seconds and cancellation terminates the socket', async () => {
  const f = fake({ hang: true }); await assert.rejects(f.transport.verify({ host, timeoutMs: 10 }), /SSH_TIMEOUT/); assert.equal(f.state.destroyed, 1);
  await assert.rejects(f.transport.verify({ host, timeoutMs: 5001 }), /SSH_INVALID_LIMIT/);
  const controller = new AbortController(), second = fake({ hang: true }), pending = second.transport.verify({ host, signal: controller.signal }); controller.abort(); await assert.rejects(pending, /SSH_ABORTED/); assert.equal(second.state.destroyed, 1);
});

test('real loopback handshake: discovery sends no authentication and verification opens no session or forwarding', async t => {
  const { Server, Client, utils } = createRequire(import.meta.url)('ssh2');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const hash = createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('hex'), clients = new Set(), seen = { auth: 0, session: 0, forwarding: 0 };
  const server = new Server({ hostKeys: [key] }, connection => {
    clients.add(connection); connection.on('close', () => clients.delete(connection)); connection.on('error', () => {});
    connection.on('authentication', context => { seen.auth++; if (context.method === 'password' && context.password === host.password && context.username === host.username) context.accept(); else context.reject(); });
    connection.on('session', (_, reject) => { seen.session++; reject(); }); connection.on('tcpip', (_, reject) => { seen.forwarding++; reject(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  const transport = createSshTransport({ Client }), port = server.address().port;
  const found = await transport.discover({ address: '127.0.0.1', port, timeoutMs: 2000 }); assert.equal(found.sha256Hex, hash); assert.equal(seen.auth, 0);
  assert.deepEqual(await transport.verify({ host: { ...host, port, hostKeySha256: hash }, timeoutMs: 2000 }), { verified: true }); assert.ok(seen.auth > 0); assert.equal(seen.session, 0); assert.equal(seen.forwarding, 0);
});
