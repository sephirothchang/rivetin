// Validate the caller with Tower itself. Decoded cookie/JWT identifiers are never authority.
export function createTowerConnection({ baseUrl, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_TOWER_URL');
  async function request(path, body, actor) {
    const response = await fetchImpl(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', ...actor?.auth }, body: JSON.stringify(body) });
    if (!response.ok) {
      let reason = ''; try { reason = (await response.json()).message || ''; } catch { /* No server diagnostic body is exposed. */ }
      if (path === '/v2/api/create-user-audit-log' && /only allow by system user/i.test(reason)) throw new Error('TOWER_AUDIT_SYSTEM_USER_REQUIRED');
      throw new Error('TOWER_REQUEST_FAILED');
    }
    return response.json();
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
        query = 'query PluginKitIdentity($id: ID!) { user(where: { id: $id }) { id username role } }'; variables = { id: claimed };
      } catch { return null; }
    } else if (auth.Cookie) {
      const cookie = auth.Cookie.split(';').map(value => value.trim()).find(value => value.startsWith('connect.sid='));
      if (!cookie) return null;
      let session; try { session = decodeURIComponent(cookie.slice('connect.sid='.length)); } catch { return null; }
      const match = /^s:([A-Za-z0-9_-]{1,128})\.[A-Za-z0-9_+/=-]+$/.exec(session); if (!match) return null;
      query = 'query PluginKitSessionIdentity($id: ID!) { userSession(where: { id: $id }) { authorized user { id username role } } }'; variables = { id: match[1] };
    } else return null;
    try {
      const result = await request('/api', { query, variables }, { auth });
      if (result.errors?.length) return null;
      const user = claimed ? result.data?.user : result.data?.userSession?.authorized ? result.data.userSession.user : null;
      if (!user?.id || (claimed && user.id !== claimed) || typeof user.username !== 'string') return null;
      return { id: user.id, name: user.username, source: 'tower', admin: ['ROOT', 'ADMIN'].includes(user.role), auth };
    } catch { return null; }
  }
  return { request, authenticate };
}
