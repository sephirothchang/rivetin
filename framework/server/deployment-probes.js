import { randomBytes } from 'node:crypto';
import { readPinnedGateway } from './gateway-https.js';

const challenge = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const authenticated = actor => actor?.admin === true && actor.source === 'tower' &&
  (typeof actor.auth?.Authorization === 'string' && actor.auth.Authorization.length > 0 && actor.auth.Authorization.length < 8192 ||
   typeof actor.auth?.Cookie === 'string' && actor.auth.Cookie.length > 0 && actor.auth.Cookie.length < 16384);
const unavailable = code => ({ available: false, matched: false, code });
const observed = (matched, code) => ({ available: true, matched, code: matched ? null : code });

// These probes observe registry metadata and an authenticated ingress round trip.
// They grant no Kubernetes authority and do not claim to inspect resource specs.
export function createDeploymentProbes({ registry, origins = [], version, certificatePin, fetchImpl = fetch } = {}) {
  const instance = randomBytes(32).toString('hex');
  let origin;
  try {
    if (origins.length === 1) {
      const url = new URL(origins[0]);
      if (url.protocol === 'https:' && url.origin === origins[0] && !url.username && !url.password) origin = url.origin;
    }
  } catch { /* An absent or ambiguous trusted origin is not a probe target. */ }
  function reply(nonce) {
    if (!challenge(nonce)) throw new Error('COMPONENT_PROBE_INVALID');
    return { schemaVersion: 1, version, challenge: nonce, instance };
  }
  async function readIsland({ actor } = {}) {
    if (!authenticated(actor)) return unavailable('DEPLOYMENT_PROBE_AUTH_UNAVAILABLE');
    if (typeof registry !== 'function') return unavailable('ISLAND_UNOBSERVABLE');
    try {
      const value = await registry(actor);
      if (!Array.isArray(value?.seaMaps) || value.seaMaps.length > 1000 || value.seaMaps.some(row => typeof row?.name !== 'string')) return unavailable('ISLAND_REGISTRY_INVALID');
      const rows = value.seaMaps.filter(row => row.name === 'rivetin');
      if (!rows.length) return observed(false, 'ISLAND_REGISTRATION_MISSING');
      if (rows.length !== 1) return observed(false, 'ISLAND_REGISTRATION_MISMATCH');
      const row = rows[0], mounts = row.data;
      const matched = !row.metadata?.version && row.metadata?.info?.version === version && Array.isArray(mounts) && mounts.length === 1 &&
        mounts[0]?.region === 'PERMANENT_CLUSTER_MANAGER_MODAL' && mounts[0]?.island === './Rivetin';
      return observed(matched, 'ISLAND_REGISTRATION_MISMATCH');
    } catch (error) {
      return unavailable(error.status === 401 || error.status === 403 ? 'DEPLOYMENT_PROBE_FORBIDDEN' : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'DEPLOYMENT_PROBE_TIMEOUT' : 'ISLAND_REGISTRY_UNAVAILABLE');
    }
  }
  async function readGateway({ actor } = {}) {
    if (!authenticated(actor)) return unavailable('DEPLOYMENT_PROBE_AUTH_UNAVAILABLE');
    if (!origin) return unavailable('GATEWAY_ORIGIN_UNAVAILABLE');
    if (certificatePin !== undefined && !/^[a-f0-9]{64}$/.test(certificatePin)) return unavailable('GATEWAY_TRUST_INVALID');
    const nonce = randomBytes(16).toString('hex'), headers = {};
    for (const key of ['Authorization', 'Cookie']) if (actor.auth[key]) headers[key] = actor.auth[key];
    try {
      const url = new URL('/api/rivetin/v1/components/status?probe=' + nonce, origin);
      const request = {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(1500),
      };
      const response = certificatePin ? await readPinnedGateway(url, request, certificatePin) : await fetchImpl(url, request);
      if (response.status === 401 || response.status === 403) { await response.body?.cancel?.(); return unavailable('DEPLOYMENT_PROBE_FORBIDDEN'); }
      if (!response.ok) { await response.body?.cancel?.(); return observed(false, 'GATEWAY_HTTP_FAILED'); }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel?.(); return observed(false, 'GATEWAY_RESPONSE_MISMATCH'); }
      if (Number(response.headers.get('content-length')) > 4096) { await response.body?.cancel?.(); return observed(false, 'GATEWAY_RESPONSE_MISMATCH'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4096) return observed(false, 'GATEWAY_RESPONSE_MISMATCH');
        chunks.push(Buffer.from(chunk));
      }
      let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return observed(false, 'GATEWAY_RESPONSE_MISMATCH'); }
      return observed(value?.schemaVersion === 1 && value.version === version && value.challenge === nonce && value.instance === instance &&
        Object.keys(value).sort().join() === 'challenge,instance,schemaVersion,version', 'GATEWAY_RESPONSE_MISMATCH');
    } catch (error) {
      const code = error.cause?.code || error.code;
      if (['GATEWAY_PIN_MISMATCH', 'GATEWAY_CERT_VALIDITY_INVALID', 'GATEWAY_TRUST_INVALID', 'DEPLOYMENT_PROBE_TIMEOUT'].includes(code)) return unavailable(code);
      if (['GATEWAY_RESPONSE_LIMIT', 'GATEWAY_RESPONSE_MISMATCH'].includes(code)) return observed(false, 'GATEWAY_RESPONSE_MISMATCH');
      return unavailable(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'DEPLOYMENT_PROBE_TIMEOUT' :
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) ? 'GATEWAY_TLS_UNTRUSTED' : 'GATEWAY_UNREACHABLE');
    }
  }
  return { readIsland, readGateway, reply };
}
