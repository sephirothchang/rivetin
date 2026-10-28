import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';

const failure = code => Object.assign(new Error(code), { code });

// Explicit leaf-pin identity for one configured origin, independent of global PKI.
// An unverified TLS socket is never returned to the HTTP layer: queued headers
// (including the current actor's authentication) cannot leave before verification.
export function readPinnedGateway(url, { headers, signal }, pin) {
  if (!(url instanceof URL) || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/rivetin/v1/components/status' ||
      !/^[a-f0-9]{64}$/.test(pin || '')) return Promise.reject(failure('GATEWAY_TRUST_INVALID'));
  const expected = Buffer.from(pin, 'hex');
  class PinnedAgent extends https.Agent {
    createConnection(options, callback) {
      let completed = false;
      const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: isIP(url.hostname) ? '' : url.hostname,
        minVersion: 'TLSv1.2', rejectUnauthorized: false });
      const timer = setTimeout(() => finish(failure('DEPLOYMENT_PROBE_TIMEOUT')), 1500);
      function finish(error) {
        if (completed) return; completed = true; clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (error) { socket.destroy(); callback(error); } else callback(null, socket);
      }
      function aborted() { finish(failure('DEPLOYMENT_PROBE_TIMEOUT')); }
      socket.once('error', () => finish(failure('GATEWAY_UNREACHABLE')));
      socket.once('secureConnect', () => {
        try {
          const raw = socket.getPeerCertificate()?.raw;
          if (!raw || raw.length > 64 * 1024 || !timingSafeEqual(createHash('sha256').update(raw).digest(), expected)) throw failure('GATEWAY_PIN_MISMATCH');
          const cert = new X509Certificate(raw), start = Date.parse(cert.validFrom), end = Date.parse(cert.validTo), now = Date.now();
          if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) throw failure('GATEWAY_CERT_VALIDITY_INVALID');
          finish();
        } catch (error) { finish(error.code ? error : failure('GATEWAY_TRUST_INVALID')); }
      });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      // Intentionally no socket return; Agent waits for the verified callback.
    }
  }
  const agent = new PinnedAgent({ keepAlive: false, maxCachedSessions: 0, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; agent.destroy();
      if (error) reject(error); else resolve(value);
    };
    const request = https.request(url, { method: 'GET', headers, signal, agent, maxHeaderSize: 8192 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) { response.destroy(); finish(failure('GATEWAY_RESPONSE_LIMIT')); } else chunks.push(chunk);
      });
      response.once('error', () => finish(failure('GATEWAY_UNREACHABLE')));
      response.once('end', () => {
        try {
          const value = new Response(Buffer.concat(chunks), { status: response.statusCode,
            headers: { 'content-type': response.headers['content-type'] || '', 'content-length': String(size) } });
          finish(null, value);
        } catch { finish(failure('GATEWAY_RESPONSE_MISMATCH')); }
      });
    });
    request.once('error', error => finish(failure(signal?.aborted ? 'DEPLOYMENT_PROBE_TIMEOUT' :
      ['GATEWAY_PIN_MISMATCH','GATEWAY_CERT_VALIDITY_INVALID','GATEWAY_TRUST_INVALID','DEPLOYMENT_PROBE_TIMEOUT'].includes(error.code) ? error.code : 'GATEWAY_UNREACHABLE')));
    request.end();
  });
}
