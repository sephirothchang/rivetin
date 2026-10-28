import { createRequire } from 'node:module';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const require = createRequire(import.meta.url);
const fail = code => Object.assign(new Error(code), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validateHost(host) {
  if (!object(host) || typeof host.address !== 'string' || host.address.length > 253 ||
      !(isIP(host.address) || /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host.address)) ||
      !Number.isInteger(host.port) || host.port < 1 || host.port > 65535 ||
      typeof host.username !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\$?$/.test(host.username) ||
      typeof host.hostKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(host.hostKeySha256)) throw fail('SSH_INVALID_HOST');
  const password = typeof host.password === 'string' && host.password.length > 0 && host.password.length <= 4096;
  const privateKey = typeof host.privateKey === 'string' && host.privateKey.length > 0 && host.privateKey.length <= 65536;
  if (password === privateKey || (host.password !== undefined && !password) || (host.privateKey !== undefined && !privateKey)) throw fail('SSH_INVALID_CREDENTIAL');
}

async function handshake(Client, input, discovery) {
  const { signal, timeoutMs = 5000 } = input || {}, host = discovery ? { address: input?.address, port: input?.port } : input?.host;
  if (discovery) {
    if (!object(input) || Object.keys(input).some(key => !['address', 'port', 'signal', 'timeoutMs'].includes(key)) || !host || !isIP(host.address) || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw fail('SSH_INVALID_HOST');
  } else validateHost(host);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw fail('SSH_INVALID_LIMIT');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('SSH_INVALID_SIGNAL');
  if (signal?.aborted) throw fail('SSH_ABORTED');
  let Constructor = Client;
  if (!Constructor) { try { Constructor = require('./vendor/ssh2.cjs').Client; } catch { throw fail('SSH_UNAVAILABLE'); } }
  if (typeof Constructor !== 'function') throw fail('SSH_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    let connection, timer, settled = false, verified = false, rejectedKey = false, attempted = false;
    function finish(code, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { if (discovery || code) connection?.destroy(); else connection?.end(); } catch { /* No transport diagnostics are public. */ }
      if (code) reject(fail(code)); else resolve(value);
    }
    const abort = () => finish('SSH_ABORTED');
    try {
      connection = new Constructor();
      connection.on('error', error => finish(rejectedKey ? 'SSH_HOST_KEY_MISMATCH' : error?.level === 'client-authentication' ? 'SSH_AUTHENTICATION_FAILED' : 'SSH_CONNECTION_FAILED'));
      connection.on('close', () => finish(rejectedKey ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_CONNECTION_CLOSED'));
      connection.once('ready', () => { if (discovery || !verified || rejectedKey) finish('SSH_HOST_KEY_MISMATCH'); else finish(null, { verified: true }); });
      timer = setTimeout(() => finish('SSH_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
      const credential = discovery ? {} : host.password !== undefined ? { password: host.password } : { privateKey: host.privateKey };
      connection.connect({ host: host.address, port: host.port, username: discovery ? 'rivetin-key-discovery' : host.username, ...credential,
        ...(discovery ? {} : { hostHash: 'sha256' }), readyTimeout: timeoutMs, keepaliveInterval: 0, agentForward: false, tryKeyboard: false,
        hostVerifier(value) {
          if (discovery) {
            if (!Buffer.isBuffer(value) || value.length < 8 || value.length > 65536) { finish('SSH_KEY_UNAVAILABLE'); return false; }
            const length = value.readUInt32BE(0), algorithm = value.subarray(4, 4 + length).toString('ascii');
            if (length < 1 || length > 96 || length > value.length - 4 || !/^[A-Za-z0-9][A-Za-z0-9@._+-]*$/.test(algorithm)) { finish('SSH_KEY_UNAVAILABLE'); return false; }
            const hash = createHash('sha256').update(value).digest();
            finish(null, { algorithm, sha256Hex: hash.toString('hex'), fingerprint: 'SHA256:' + hash.toString('base64').replace(/=+$/, '') });
            // Reject the key deliberately: discovery never reaches authentication.
            return false;
          }
          verified = typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(host.hostKeySha256, 'hex'));
          rejectedKey = !verified; return verified;
        },
        authHandler(methods, partialSuccess, callback) {
          if (discovery || !verified || rejectedKey || attempted || partialSuccess) return callback(false);
          attempted = true; callback(host.password !== undefined ? 'password' : 'publickey');
        },
      });
    } catch { finish(rejectedKey ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_CONNECTION_FAILED'); }
  });
}

export function createSshTransport({ Client } = {}) {
  return {
    discover: input => handshake(Client, input, true),
    verify: input => handshake(Client, input, false),
    async run({ host, command, signal, maxBytes = 1048576, timeoutMs = 30000 } = {}) {
      validateHost(host);
      if (typeof command !== 'string' || !command.length || command.length > 1024 || /[\r\n\0]/.test(command)) throw fail('SSH_INVALID_COMMAND');
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('SSH_INVALID_LIMIT');
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('SSH_INVALID_SIGNAL');
      if (signal?.aborted) throw fail('SSH_ABORTED');
      let Constructor = Client;
      if (!Constructor) {
        try { Constructor = require('./vendor/ssh2.cjs').Client; }
        catch { throw fail('SSH_UNAVAILABLE'); }
      }
      if (typeof Constructor !== 'function') throw fail('SSH_UNAVAILABLE');
      return new Promise((resolve, reject) => {
        let connection, channel, settled = false, verified = false, rejectedKey = false, authAttempted = false;
        let totalTimer, handshakeTimer, exitCode, exitSignal;
        const stdout = Buffer.alloc(maxBytes), stderr = Buffer.alloc(maxBytes);
        let outLength = 0, errLength = 0;
        function finish(error) {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimer); clearTimeout(handshakeTimer);
          signal?.removeEventListener('abort', abort);
          try { channel?.destroy(); } catch { /* Closing must not reveal transport errors. */ }
          try { if (error) connection?.destroy(); else connection?.end(); } catch { /* Already disconnected. */ }
          if (error) reject(fail(error));
          else resolve({ stdout: stdout.subarray(0, outLength).toString('utf8'), stderr: stderr.subarray(0, errLength).toString('utf8'), exitCode });
        }
        function abort() { finish('SSH_ABORTED'); }
        function append(chunk, errorOutput = false) {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (bytes.length > maxBytes - outLength - errLength) { finish('SSH_OUTPUT_LIMIT'); return; }
          if (errorOutput) { bytes.copy(stderr, errLength); errLength += bytes.length; }
          else { bytes.copy(stdout, outLength); outLength += bytes.length; }
        }
        try {
          connection = new Constructor();
          connection.on('error', error => finish(rejectedKey ? 'SSH_HOST_KEY_MISMATCH' : error?.level === 'client-authentication' ? 'SSH_AUTHENTICATION_FAILED' : 'SSH_CONNECTION_FAILED'));
          connection.on('close', () => finish(rejectedKey ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_CONNECTION_CLOSED'));
          connection.once('ready', () => {
            clearTimeout(handshakeTimer);
            if (settled) return;
            if (!verified || rejectedKey) { finish('SSH_HOST_KEY_MISMATCH'); return; }
            connection.exec(command, { pty: false, x11: false, agentForward: false }, (error, stream) => {
              if (settled) { try { stream?.destroy(); } catch {} return; }
              if (error || !stream || !stream.stderr) { finish('SSH_EXEC_FAILED'); return; }
              channel = stream;
              channel.on('data', chunk => append(chunk));
              channel.stderr.on('data', chunk => append(chunk, true));
              channel.on('error', () => finish('SSH_EXEC_FAILED'));
              channel.stderr.on('error', () => finish('SSH_EXEC_FAILED'));
              channel.on('exit', (code, signalName) => { exitCode = code; exitSignal = signalName; });
              channel.on('close', (code, signalName) => {
                if (settled) return;
                if (exitCode === undefined) exitCode = code;
                if (exitSignal === undefined) exitSignal = signalName;
                if (exitSignal || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) finish('SSH_EXIT_STATUS_UNAVAILABLE');
                else finish();
              });
              // Collection operations cannot consume interactive input.
              channel.end();
            });
          });
          totalTimer = setTimeout(() => finish('SSH_TIMEOUT'), timeoutMs);
          handshakeTimer = setTimeout(() => finish('SSH_HANDSHAKE_TIMEOUT'), Math.min(timeoutMs, 8000));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) { abort(); return; }
          const credential = host.password !== undefined ? { password: host.password } : { privateKey: host.privateKey };
          connection.connect({
            host: host.address, port: host.port, username: host.username, ...credential,
            hostHash: 'sha256', readyTimeout: Math.min(timeoutMs, 8000), keepaliveInterval: 0,
            agentForward: false, tryKeyboard: false,
            hostVerifier(hash) {
              const valid = typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(host.hostKeySha256, 'hex'));
              verified = valid; rejectedKey = !valid;
              return valid;
            },
            authHandler(methodsLeft, partialSuccess, callback) {
              // The verifier is required before even attempting a credential-bearing method.
              if (!verified || rejectedKey || partialSuccess || authAttempted) return callback(false);
              authAttempted = true;
              callback(host.password !== undefined ? 'password' : 'publickey');
            },
          });
        } catch { finish(rejectedKey ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_CONNECTION_FAILED'); }
      });
    },
  };
}
