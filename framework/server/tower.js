// Validate the caller with Tower itself. Decoded cookie/JWT identifiers are never authority.
export function createTowerConnection({ baseUrl, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_TOWER_URL');
  async function responseJson(response) {
    const max = 16 * 1024 * 1024, chunks = []; let size = 0;
    if (Number(response.headers?.get?.('content-length')) > max) { await response.body?.cancel?.(); throw new Error('TOWER_RESPONSE_TOO_LARGE'); }
    if (!response.body?.[Symbol.asyncIterator]) {
      // Test transports may supply a pre-parsed body; real Fetch responses always stream.
      if (typeof response.json === 'function' && !response.headers) return response.json();
      throw new Error('TOWER_RESPONSE_INVALID');
    }
    for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error('TOWER_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('TOWER_RESPONSE_INVALID'); }
  }
  async function request(path, body, actor) {
    if (typeof path !== 'string' || !/^\/(?:api|v2\/api\/[a-z0-9-]+)$/.test(path)) throw new Error('INVALID_TOWER_PATH');
    const response = await fetchImpl(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', ...actor?.auth }, body: JSON.stringify(body) });
    if (!response.ok) {
      let reason = ''; try { reason = (await responseJson(response)).message || ''; } catch { /* No server diagnostic body is exposed. */ }
      if (path === '/v2/api/create-user-audit-log' && /only allow by system user/i.test(reason)) throw new Error('TOWER_AUDIT_SYSTEM_USER_REQUIRED');
      throw Object.assign(new Error('TOWER_REQUEST_FAILED'), { status: response.status });
    }
    return responseJson(response);
  }
  async function authenticate(req) {
    const auth = {};
    if (req.headers.authorization && req.headers.authorization.length < 8192) auth.Authorization = req.headers.authorization;
    if (req.headers.cookie && req.headers.cookie.length < 16384) auth.Cookie = req.headers.cookie;
    let query, variables, claimed;
    if (auth.Authorization) {
      try {
        const token = auth.Authorization.replace(/^Bearer /i, ''), raw = Buffer.from(token.split('.')[1], 'base64url').toString();
        try { claimed = JSON.parse(raw); } catch { claimed = raw; }
        if (typeof claimed !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claimed)) return null;
        query = 'query RivetinIdentity($id: ID!) { user(where: { id: $id }) { id username role } }'; variables = { id: claimed };
      } catch { return null; }
    } else if (auth.Cookie) {
      const cookie = auth.Cookie.split(';').map(value => value.trim()).find(value => value.startsWith('connect.sid='));
      if (!cookie) return null;
      let session; try { session = decodeURIComponent(cookie.slice('connect.sid='.length)); } catch { return null; }
      const match = /^s:([A-Za-z0-9_-]{1,128})\.[A-Za-z0-9_+/=-]+$/.exec(session); if (!match) return null;
      query = 'query RivetinSessionIdentity($id: ID!) { userSession(where: { id: $id }) { authorized user { id username role } } }'; variables = { id: match[1] };
    } else return null;
    try {
      const result = await request('/api', { query, variables }, { auth });
      if (result.errors?.length) return null;
      const user = claimed ? result.data?.user : result.data?.userSession?.authorized ? result.data.userSession.user : null;
      if (!user?.id || (claimed && user.id !== claimed) || typeof user.username !== 'string') return null;
      return { id: user.id, name: user.username, source: 'tower', role: user.role, admin: ['ROOT', 'ADMIN'].includes(user.role), auth };
    } catch { return null; }
  }
  async function islandRegistry(actor) {
    if (!actor?.admin || actor.source !== 'tower' || !actor.auth?.Authorization && !actor.auth?.Cookie) throw new Error('DEPLOYMENT_PROBE_AUTH_UNAVAILABLE');
    const headers = {};
    for (const key of ['Authorization', 'Cookie']) if (actor.auth[key]) headers[key] = actor.auth[key];
    const response = await fetchImpl(new URL('/api/island-registry/sea-maps?refreshCache=true', base), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1500), headers,
    });
    if (!response.ok) { await response.body?.cancel?.(); throw Object.assign(new Error('ISLAND_REGISTRY_UNAVAILABLE'), { status: response.status }); }
    return responseJson(response);
  }
  return { request, authenticate, islandRegistry };
}
