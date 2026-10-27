export class BmcLoginError extends Error {
  constructor(code) { super(code); this.name = 'BmcLoginError'; this.code = code; }
}
// Server-side only. The transport is explicit so the demo cannot fall back to a real network.
export async function loginMegaRac({ baseUrl, username, password, transport, timeoutMs = 5000 }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || typeof transport !== 'function') {
    throw new BmcLoginError('INVALID_CONFIGURATION');
  }
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await transport(new URL('/api/session', base), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(), signal: abort.signal, redirect: 'error',
    });
    if (!response.ok) throw new BmcLoginError('LOGIN_REJECTED');
    const data = await response.json();
    if (data.passwordStatus === 1) throw new BmcLoginError('PASSWORD_CHANGE_REQUIRED');
    if (data.ok !== 0 || typeof data.CSRFToken !== 'string' || !data.CSRFToken || data.racsession_id == null) {
      throw new BmcLoginError('INVALID_LOGIN_RESPONSE');
    }
    return {
      csrfToken: data.CSRFToken,
      browserState: { garc: data.CSRFToken, privilege_id: String(data.privilege),
        extended_privilege: String(data.extendedpriv), session_id: String(data.racsession_id),
        channel: String(data.channel), username },
      upstreamCookies: response.headers.get('set-cookie') || '',
    };
  } catch (error) {
    if (error instanceof BmcLoginError) throw error;
    throw new BmcLoginError(abort.signal.aborted ? 'LOGIN_TIMEOUT' : 'LOGIN_FAILED');
  } finally { clearTimeout(timer); }
}
