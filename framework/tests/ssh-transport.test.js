import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { createSshTransport } from '../server/ssh-transport.js';
import { validateSshHost } from '../server/ssh-vault.js';

const PIN = 'a'.repeat(64);
const host = { address: '127.0.0.1', port: 22, username: 'collector', hostKeySha256: PIN, password: 'EXAMPLE_PASSWORD' };
function fake({ presentedKey = PIN, execute = stream => { stream.emit('data', Buffer.from('ok')); stream.emit('exit', 8); stream.emit('close', 8); }, connectError, beforeVerifier = false, neverReady = false } = {}) {
  const record = { destroyed: 0, ended: 0, streamDestroyed: 0, execs: [], options: null, auth: [] };
  class Client extends EventEmitter {
    connect(options) {
      record.options = options;
      queueMicrotask(() => {
        if (beforeVerifier) options.authHandler(null, false, value => record.auth.push(value));
        if (connectError) { this.emit('error', connectError); return; }
        if (!options.hostVerifier(presentedKey)) { this.emit('error', new Error('EXAMPLE_PRIVATE_SERVER_ERROR')); return; }
        options.authHandler(null, false, value => record.auth.push(value));
        options.authHandler(['password'], false, value => record.auth.push(value));
        if (!neverReady) this.emit('ready');
      });
    }
    exec(command, options, callback) {
      record.execs.push({ command, options });
      const stream = new EventEmitter(); stream.stderr = new EventEmitter();
      stream.destroy = () => { record.streamDestroyed++; };
      stream.end = () => queueMicrotask(() => execute(stream));
      callback(null, stream);
    }
    destroy() { record.destroyed++; }
    end() { record.ended++; }
  }
  return { record, transport: createSshTransport({ Client }) };
}

test('SSH transport pins before authentication, executes once without a PTY and retains nonzero exit status', async () => {
  const { transport, record } = fake();
  assert.deepEqual(await transport.run({ host, command: '/usr/bin/uname -srm' }), { stdout: 'ok', stderr: '', exitCode: 8 });
  assert.equal(record.options.hostHash, 'sha256'); assert.equal(record.options.readyTimeout, 8000);
  assert.equal(record.options.agentForward, false); assert.equal(record.options.tryKeyboard, false); assert.equal(record.options.agent, undefined);
  assert.deepEqual(record.execs, [{ command: '/usr/bin/uname -srm', options: { pty: false, x11: false, agentForward: false } }]);
  assert.deepEqual(record.auth, ['password', false]); assert.equal(record.ended, 1);
});
test('vault-approved account names including trailing dollar reach the transport unchanged', async () => {
  for (const username of ['collector', '_collector', 'collector-reader', 'collector$']) {
    const profile = validateSshHost({ ...host, hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', devices: [], username });
    const { transport, record } = fake();
    await transport.run({ host: profile, command: '/usr/bin/uname -srm' });
    assert.equal(record.options.username, username); assert.deepEqual(record.auth, ['password', false]);
  }
});

test('authentication before verification is refused and a mismatched key sends no credential-bearing method', async () => {
  const { transport, record } = fake({ presentedKey: 'b'.repeat(64), beforeVerifier: true });
  await assert.rejects(transport.run({ host, command: 'uname' }), /^Error: SSH_HOST_KEY_MISMATCH$/);
  assert.deepEqual(record.auth, [false]); assert.equal(record.execs.length, 0); assert.equal(record.destroyed, 1);
});

test('private keys stay in memory and select only publickey authentication', async () => {
  const { transport, record } = fake();
  const { password, ...keyHost } = host;
  await transport.run({ host: { ...keyHost, privateKey: 'EXAMPLE_IN_MEMORY_PRIVATE_KEY' }, command: 'uname' });
  assert.deepEqual(record.auth, ['publickey', false]); assert.equal(record.options.password, undefined);
  assert.equal(record.options.privateKey, 'EXAMPLE_IN_MEMORY_PRIVATE_KEY');
});

test('output bound counts stdout and stderr together and closes channel plus socket', async () => {
  const { transport, record } = fake({ execute: stream => { stream.emit('data', Buffer.from('123')); stream.stderr.emit('data', Buffer.from('456')); } });
  await assert.rejects(transport.run({ host, command: 'uname', maxBytes: 5 }), /^Error: SSH_OUTPUT_LIMIT$/);
  assert.equal(record.destroyed, 1); assert.equal(record.streamDestroyed, 1);
});

test('abort closes the current channel immediately and pre-aborted calls never connect', async () => {
  const control = new AbortController(), { transport, record } = fake({ execute: () => control.abort() });
  await assert.rejects(transport.run({ host, command: 'uname', signal: control.signal }), /^Error: SSH_ABORTED$/);
  assert.equal(record.destroyed, 1); assert.equal(record.streamDestroyed, 1);
  const second = fake();
  await assert.rejects(second.transport.run({ host, command: 'uname', signal: control.signal }), /^Error: SSH_ABORTED$/);
  assert.equal(second.record.options, null);
});

test('whole-operation timeout terminates without retrying', async () => {
  const { transport, record } = fake({ execute: () => {} });
  await assert.rejects(transport.run({ host, command: 'uname', timeoutMs: 20 }), /^Error: SSH_TIMEOUT$/);
  assert.equal(record.execs.length, 1); assert.equal(record.destroyed, 1);
});

test('the independent handshake budget is at most eight seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, record } = fake({ neverReady: true });
  const pending = transport.run({ host, command: 'uname', timeoutMs: 60000 });
  const rejected = assert.rejects(pending, /^Error: SSH_HANDSHAKE_TIMEOUT$/);
  await Promise.resolve(); t.mock.timers.tick(8000); await rejected;
  assert.equal(record.execs.length, 0); assert.equal(record.destroyed, 1);
});

test('unknown exit status or termination signal fails closed', async () => {
  for (const args of [[undefined], [0, 'TERM'], [256], [-1], [null]]) {
    const { transport } = fake({ execute: stream => stream.emit('close', ...args) });
    await assert.rejects(transport.run({ host, command: 'uname' }), /^Error: SSH_EXIT_STATUS_UNAVAILABLE$/);
  }
});

test('transport errors never expose server errors, addresses or credentials', async () => {
  const { transport } = fake({ connectError: Object.assign(new Error('EXAMPLE_PASSWORD EXAMPLE_PRIVATE_SERVER_ERROR'), { level: 'client-authentication' }) });
  await assert.rejects(transport.run({ host, command: 'uname' }), error => error.message === 'SSH_AUTHENTICATION_FAILED' && error.code === error.message);
});

test('invalid endpoints, pin formats, credentials, commands and limits are rejected before connecting', async () => {
  const { transport, record } = fake();
  for (const change of [{ address: 'https://tower.example.invalid' }, { address: 'user@host' }, { port: 0 }, { hostKeySha256: 'SHA256:EXAMPLE' }, { hostKeySha256: 'A'.repeat(64) }, { username: '-collector' }])
    await assert.rejects(transport.run({ host: { ...host, ...change }, command: 'uname' }), /^Error: SSH_INVALID_HOST$/);
  for (const change of [{ password: '' }, { password: undefined }, { privateKey: 'EXAMPLE_KEY' }])
    await assert.rejects(transport.run({ host: { ...host, ...change }, command: 'uname' }), /^Error: SSH_INVALID_CREDENTIAL$/);
  for (const command of ['', 'uname\nreboot', 'uname\r', 'uname\0', 'x'.repeat(1025)])
    await assert.rejects(transport.run({ host, command }), /^Error: SSH_INVALID_COMMAND$/);
  for (const limits of [{ maxBytes: 0 }, { maxBytes: 1048577 }, { timeoutMs: 0 }, { timeoutMs: 60001 }])
    await assert.rejects(transport.run({ host, command: 'uname', ...limits }), /^Error: SSH_INVALID_LIMIT$/);
  await assert.rejects(transport.run({ host, command: 'uname', signal: {} }), /^Error: SSH_INVALID_SIGNAL$/);
  assert.equal(record.options, null);
});

const { Server, Client: ProtocolClient, utils } = createRequire(import.meta.url)('ssh2');
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const keyHash = createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('hex');
async function localServer(t, handle, { acceptPassword = true, acceptPublicKey = false } = {}) {
  const clients = new Set(), seen = { auth: 0, exec: [], pty: 0, shell: 0, subsystem: 0, forwarding: 0 };
  const server = new Server({ hostKeys: [key] }, connection => {
    clients.add(connection); connection.on('close', () => clients.delete(connection)); connection.on('error', () => {});
    connection.on('authentication', context => {
      seen.auth++;
      if (acceptPassword && context.method === 'password' && context.username === host.username && context.password === host.password) context.accept();
      else if (acceptPublicKey && context.method === 'publickey' && context.username === host.username && context.key.data.equals(utils.parseKey(key).getPublicSSH()) &&
        (!context.signature || utils.parseKey(key).verify(context.blob, context.signature, context.hashAlgo))) context.accept();
      else context.reject();
    });
    connection.on('tcpip', (accept, reject) => { seen.forwarding++; reject(); });
    connection.on('session', accept => {
      const session = accept(); session.on('error', () => {});
      session.on('pty', (acceptPty, reject) => { seen.pty++; reject(); });
      session.on('shell', (acceptShell, reject) => { seen.shell++; reject(); });
      session.on('subsystem', (acceptSubsystem, reject) => { seen.subsystem++; reject(); });
      session.on('exec', (acceptExec, reject, info) => { seen.exec.push(info.command); const stream = acceptExec(); stream.on('error', () => {}); handle(stream); });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  return { host: { ...host, port: server.address().port, hostKeySha256: keyHash }, seen };
}

test('real local SSH protocol: pinned authentication, stdout/stderr, exit status and no ancillary channels', async t => {
  const fixture = await localServer(t, stream => { stream.write('EXAMPLE_STDOUT'); stream.stderr.write('EXAMPLE_STDERR'); stream.exit(8); stream.end(); });
  const value = await createSshTransport({ Client: ProtocolClient }).run({ host: fixture.host, command: '/usr/bin/uname -srm', timeoutMs: 2000 });
  assert.deepEqual(value, { stdout: 'EXAMPLE_STDOUT', stderr: 'EXAMPLE_STDERR', exitCode: 8 });
  assert.deepEqual(fixture.seen.exec, ['/usr/bin/uname -srm']);
  for (const field of ['pty', 'shell', 'subsystem', 'forwarding']) assert.equal(fixture.seen[field], 0);
});

test('real local SSH protocol rejects changed host keys before attempting authentication', async t => {
  const fixture = await localServer(t, stream => stream.end());
  await assert.rejects(createSshTransport({ Client: ProtocolClient }).run({ host: { ...fixture.host, hostKeySha256: PIN }, command: 'uname', timeoutMs: 2000 }), /^Error: SSH_HOST_KEY_MISMATCH$/);
  assert.equal(fixture.seen.auth, 0); assert.equal(fixture.seen.exec.length, 0);
});

test('real local SSH protocol accepts an in-memory private key without loading key files', async t => {
  const fixture = await localServer(t, stream => { stream.exit(0); stream.end('key-authenticated'); }, { acceptPassword: false, acceptPublicKey: true });
  const { password, ...keyHost } = fixture.host;
  const value = await createSshTransport({ Client: ProtocolClient }).run({ host: { ...keyHost, privateKey: key }, command: 'uname', timeoutMs: 2000 });
  assert.deepEqual(value, { stdout: 'key-authenticated', stderr: '', exitCode: 0 });
});

test('real local SSH protocol reports authentication rejection without retries or details', async t => {
  const fixture = await localServer(t, stream => stream.end(), { acceptPassword: false });
  await assert.rejects(createSshTransport({ Client: ProtocolClient }).run({ host: fixture.host, command: 'uname', timeoutMs: 2000 }), /^Error: SSH_AUTHENTICATION_FAILED$/);
  assert.equal(fixture.seen.auth, 1); assert.equal(fixture.seen.exec.length, 0);
});

test('real local SSH protocol enforces combined output limits', async t => {
  const fixture = await localServer(t, stream => { stream.write('12345'); stream.stderr.write('67890'); });
  await assert.rejects(createSshTransport({ Client: ProtocolClient }).run({ host: fixture.host, command: 'uname', maxBytes: 8, timeoutMs: 2000 }), /^Error: SSH_OUTPUT_LIMIT$/);
});

test('real local SSH protocol supports cancellation and bounded timeout', async t => {
  const control = new AbortController();
  const fixture = await localServer(t, () => control.abort());
  await assert.rejects(createSshTransport({ Client: ProtocolClient }).run({ host: fixture.host, command: 'uname', signal: control.signal, timeoutMs: 2000 }), /^Error: SSH_ABORTED$/);
  await assert.rejects(createSshTransport({ Client: ProtocolClient }).run({ host: fixture.host, command: 'uname', timeoutMs: 300 }), /^Error: SSH_TIMEOUT$/);
});

test('production lazy loader uses the bundled runtime, or fails closed when it has not been built', async t => {
  if (!existsSync(new URL('../server/vendor/ssh2.cjs', import.meta.url))) {
    await assert.rejects(createSshTransport().run({ host, command: 'uname' }), /^Error: SSH_UNAVAILABLE$/);
    return;
  }
  const fixture = await localServer(t, stream => { stream.exit(0); stream.end('bundled-runtime'); });
  assert.deepEqual(await createSshTransport().run({ host: fixture.host, command: 'uname', timeoutMs: 2000 }), { stdout: 'bundled-runtime', stderr: '', exitCode: 0 });
});
