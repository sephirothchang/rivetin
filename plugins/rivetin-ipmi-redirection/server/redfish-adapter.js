import { getApiProfile } from '../src/vendor-registry.js';

export class RedfishError extends Error {
  constructor(code) { super(code); this.name = 'RedfishError'; this.code = code; }
}
const fail = code => { throw new RedfishError(code); };

// Transport must be injected by a server-side caller. No implicit fetch, TLS bypass or browser token export.
export function createRedfishClient({ vendorId, baseUrl, transport, timeoutMs = 5000, maxMembers = 8 }) {
  let base;
  try { base = new URL(baseUrl); } catch { fail('INVALID_CONFIGURATION'); }
  if (!getApiProfile(vendorId) || base.protocol !== 'https:' || base.username || base.password ||
    base.pathname !== '/' || base.search || base.hash || typeof transport !== 'function' ||
    !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000 ||
    !Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 32) fail('INVALID_CONFIGURATION');

  function resource(link) {
    if (typeof link !== 'string' || /[\\\s]/.test(link) || /%2f|%5c|%2e/i.test(link)) fail('UNTRUSTED_RESOURCE');
    let url;
    try { url = new URL(link, base); } catch { fail('UNTRUSTED_RESOURCE'); }
    if (url.origin !== base.origin || url.username || url.password || url.hash || url.search ||
      !url.pathname.startsWith('/redfish/v1/')) fail('UNTRUSTED_RESOURCE');
    return url;
  }
  async function request(link, { method = 'GET', token, body, deadline = Date.now() + timeoutMs } = {}) {
    let url = resource(link);
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) fail('REQUEST_TIMEOUT');
    const abort = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      abort.abort(); reject(new RedfishError('REQUEST_TIMEOUT'));
    }, remaining); });
    const work = async () => {
      for (let redirects = 0; redirects <= 1; redirects++) {
        const response = await transport(url, { method, redirect: 'manual', signal: abort.signal,
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { 'X-Auth-Token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (abort.signal.aborted) fail('REQUEST_TIMEOUT');
        if (response.redirected) fail('UNEXPECTED_REDIRECT');
        if ([307, 308].includes(response.status) && redirects === 0) {
          const destination = resource(response.headers.get('location'));
          // Only a trailing-slash canonicalization is permitted, even for credential POSTs.
          if (destination.pathname !== url.pathname.replace(/\/$/, '') + '/' || destination.href === url.href) fail('UNEXPECTED_REDIRECT');
          url = destination; continue;
        }
        if (response.status >= 300 && response.status < 400) fail('UNEXPECTED_REDIRECT');
        if (response.status === 401) fail('AUTHENTICATION_REQUIRED');
        if (response.status === 403) fail('ACCESS_DENIED');
        if (response.status === 429) fail('SESSION_LIMIT_OR_RATE_LIMIT');
        if (!response.ok) fail('BMC_REQUEST_REJECTED');
        const data = response.status === 204 || method === 'DELETE' ? null : await response.json();
        return { response, data };
      }
      fail('UNEXPECTED_REDIRECT');
    };
    try { return await Promise.race([work(), expired]); }
    catch (error) { if (error instanceof RedfishError) throw error; fail('BMC_REQUEST_FAILED'); }
    finally { clearTimeout(timer); }
  }
  async function discover(deadline) {
    const { data: root } = await request('/redfish/v1/', { deadline });
    if (!root || typeof root !== 'object' || typeof root.RedfishVersion !== 'string') fail('NOT_A_REDFISH_SERVICE');
    let sessions = root.Links?.Sessions?.['@odata.id'];
    if (!sessions && root.SessionService?.['@odata.id']) {
      const serviceLink = resource(root.SessionService['@odata.id']);
      try {
        const service = await request(serviceLink.href, { deadline });
        if (service.data?.ServiceEnabled === false) fail('SESSION_SERVICE_DISABLED');
        sessions = service.data?.Sessions?.['@odata.id'];
      } catch (error) {
        // Some BMCs expose only the service root anonymously; the standard collection is documented.
        const path = serviceLink.pathname.replace(/\/$/, '');
        if (error.code !== 'AUTHENTICATION_REQUIRED' || path.toLowerCase() !== '/redfish/v1/sessionservice') throw error;
        sessions = path + (path.endsWith('/sessionservice') ? '/sessions' : '/Sessions');
      }
    }
    if (!sessions) fail('SESSION_COLLECTION_UNAVAILABLE');
    return { root, sessions: resource(sessions).href };
  }
  return Object.freeze({
    async probe() {
      const { root } = await discover(Date.now() + timeoutMs);
      return { vendorId, redfishVersion: root.RedfishVersion, sessionAuthentication: true, hardwareValidated: false };
    },
    async login({ username, password }) {
      if (typeof username !== 'string' || !username || username.length > 256 ||
        typeof password !== 'string' || !password || password.length > 4096) fail('INVALID_CREDENTIAL_INPUT');
      const deadline = Date.now() + timeoutMs;
      const { root, sessions } = await discover(deadline);
      const { response } = await request(sessions, { method: 'POST', body: { UserName: username, Password: password }, deadline });
      if (response.status !== 201) fail('INVALID_SESSION_RESPONSE');
      let token = response.headers.get('x-auth-token');
      const location = response.headers.get('location');
      // A malformed success may have created a session. Never guess a session ID or repeat login.
      if (!token || token.length > 8192 || /[\r\n]/.test(token) || !location) fail('INVALID_SESSION_RESPONSE');
      const sessionUrl = resource(location), collection = resource(sessions).pathname.replace(/\/$/, '') + '/';
      const sessionId = sessionUrl.pathname.slice(collection.length).replace(/\/$/, '');
      if (!sessionUrl.pathname.startsWith(collection) || !sessionId || sessionId.includes('/')) fail('INVALID_SESSION_RESPONSE');
      let busy = false;
      const active = () => { if (!token) fail('SESSION_CLOSED'); if (busy) fail('SESSION_BUSY'); };
      return Object.freeze({
        vendorId,
        async readInventory() {
          active(); busy = true;
          const result = { systems: [], managers: [], chassis: [], truncated: false };
          const readDeadline = Date.now() + Math.min(timeoutMs * 4, 30000);
          try {
            for (const [name, property] of [['systems', 'Systems'], ['managers', 'Managers'], ['chassis', 'Chassis']]) {
              const link = root[property]?.['@odata.id'];
              if (!link) continue;
              const { data } = await request(link, { token, deadline: readDeadline });
              if (!Array.isArray(data?.Members)) fail('INVALID_COLLECTION_RESPONSE');
              result.truncated ||= data.Members.length > maxMembers || Boolean(data['Members@odata.nextLink']) ||
                Number(data['Members@odata.count']) > data.Members.length;
              for (const member of data.Members.slice(0, maxMembers)) {
                const { data: item } = await request(member?.['@odata.id'], { token, deadline: readDeadline });
                if (!item || typeof item !== 'object') fail('INVALID_RESOURCE_RESPONSE');
                const summary = {};
                for (const key of ['Id', 'Name', 'Manufacturer', 'Model', 'FirmwareVersion', 'SerialNumber', 'PowerState']) {
                  if (typeof item[key] === 'string') summary[key] = item[key];
                }
                if (typeof item.Status?.Health === 'string') summary.Health = item.Status.Health;
                result[name].push(summary);
              }
            }
            return result;
          } finally { busy = false; }
        },
        async logout() {
          if (!token) return;
          active(); busy = true;
          try { await request(sessionUrl.href, { method: 'DELETE', token }); token = null; }
          finally { busy = false; }
        },
      });
    },
  });
}
