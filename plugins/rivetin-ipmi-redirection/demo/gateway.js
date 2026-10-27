import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loginMegaRac } from '../server/megarac-adapter.js';

export const DEMO_HOSTS = Object.freeze({
  'demo-node-1': { name: 'Demo-Node-01', ip: '203.0.113.21' },
  'demo-node-2': { name: 'Demo-Node-02', ip: '203.0.113.22' },
});
const DEMO_USER = 'DEMO_ADMIN', DEMO_PASSWORD = 'DEMO_ONLY_NOT_A_REAL_PASSWORD';
export function mockBmcTransport(_url, options) {
  const fields = new URLSearchParams(options.body);
  if (fields.get('username') !== DEMO_USER || fields.get('password') !== DEMO_PASSWORD) {
    return Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 401 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ ok: 0, passwordStatus: 0,
    CSRFToken: randomBytes(24).toString('hex'), privilege: 4, extendedpriv: 3,
    racsession_id: randomBytes(12).toString('hex'), channel: 1,
  }), { status: 200, headers: { 'set-cookie': 'DEMO_UPSTREAM_SESSION=SIMULATED; HttpOnly' } }));
}
const style = `body{margin:0;background:#eef3f9;color:#263b58;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;display:grid;place-items:center;min-height:100vh}.card{background:white;border:1px solid #dce6f2;border-radius:16px;box-shadow:0 15px 60px #26425e12;padding:38px 44px;width:min(560px,90vw)}h1{font-size:25px;margin:8px 0 12px}.tag{display:inline-block;background:#eaf4ff;color:#0879d1;padding:3px 10px;border-radius:20px;font-size:12px}p{color:#6d8199}label{display:block;color:#6d8199;font-size:12px;margin-top:16px}input{display:block;width:100%;box-sizing:border-box;border:1px solid #dae3ee;border-radius:7px;padding:10px;font:inherit;margin-top:5px;background:#f6f8fb}a{color:#0a7ce0}dl{display:grid;grid-template-columns:100px 1fr;gap:12px;font-size:14px}dt{color:#8797ac}dd{margin:0}.success{color:#248557;font-weight:600}small{color:#92a0b2;font-size:12px}`;
function html(title, content, script = '') {
  const nonce = randomBytes(18).toString('base64');
  return { body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${style}</style><div class="card">${content}</div>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`,
    csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` };
}
function sendHtml(res, page, status = 200) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': page.csp, 'Referrer-Policy': 'no-referrer' }); res.end(page.body); }
function json(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); }
export function createDemoGateway({ towerOrigin = 'http://127.0.0.1:43170', gatewayOrigin = 'http://127.0.0.1:43171', clock = Date.now, transport = mockBmcTransport } = {}) {
  const tickets = new Map(), sessions = new Map();
  function prune() { const now = clock(); for (const map of [tickets, sessions]) for (const [key, value] of map) if (value.expires <= now) map.delete(key); }
  const timer = setInterval(prune, 10000); timer.unref();
  async function handler(req, res) {
    prune(); const url = new URL(req.url, gatewayOrigin);
    const origin = req.headers.origin;
    const cors = origin === towerOrigin ? { 'Access-Control-Allow-Origin': towerOrigin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS' && url.pathname === '/api/launch') {
      return json(res, origin === towerOrigin ? 200 : 403, {}, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    }
    if (url.pathname === '/api/launch' && req.method === 'POST') {
      if (origin !== towerOrigin || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: 'DEMO_ORIGIN_REQUIRED' });
      if (tickets.size + sessions.size >= 100) return json(res, 429, { error: 'DEMO_CAPACITY_LIMIT' }, cors);
      let data, text = '';
      try { for await (const chunk of req) { text += chunk; if (text.length > 4096) throw new Error(); } data = JSON.parse(text); }
      catch { return json(res, 400, { error: 'INVALID_REQUEST' }, cors); }
      if (!data || Object.keys(data).some(key => !['hostId', 'vendor'].includes(key)) || !Object.hasOwn(DEMO_HOSTS, data.hostId) || (data.vendor != null && data.vendor !== 'ami-megarac')) return json(res, 403, { error: 'HOST_NOT_ALLOWED' }, cors);
      const ticket = randomBytes(24).toString('hex'); tickets.set(ticket, { hostId: data.hostId, expires: clock() + 30000 });
      return json(res, 200, { launchUrl: `${gatewayOrigin}/launch/${ticket}` }, cors);
    }
    if (url.pathname.startsWith('/launch/') && req.method === 'GET') {
      const key = url.pathname.slice('/launch/'.length), ticket = tickets.get(key); tickets.delete(key);
      if (!ticket || ticket.expires <= clock()) return sendHtml(res, html('演示链接已失效', '<h1>链接已失效</h1><p>请返回本地 Tower，重新点击 IPMI 地址。</p>'), 410);
      try {
        const login = await loginMegaRac({ baseUrl: 'https://bmc.example.invalid', username: DEMO_USER, password: DEMO_PASSWORD, transport });
        const id = randomBytes(24).toString('hex'); sessions.set(id, { ...login, hostId: ticket.hostId, expires: clock() + 300000 });
        res.setHeader('Set-Cookie', `c89_demo_gateway=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`);
        const state = JSON.stringify(login.browserState).replaceAll('<', '\\u003c');
        return sendHtml(res, html('建立模拟会话', '<span class="tag">MegaRAC SP-X · 本地模拟</span><h1>正在建立演示会话…</h1><p>不连接真实 BMC。</p>',
          `const state=${state};for(const [key,value] of Object.entries(state)){sessionStorage.setItem(key,value);localStorage.setItem(key,value)}location.replace('/dashboard');`));
      } catch { return sendHtml(res, html('模拟登录失败', '<h1>无法建立会话</h1><p>演示适配器拒绝了登录；未重试，也未更改密码。</p>'), 502); }
    }
    const id = /(?:^|;\s*)c89_demo_gateway=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const session = id && sessions.get(id);
    if (url.pathname === '/api/status') {
      const token = req.headers['x-csrftoken'];
      if (!session || typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) return json(res, 401, { error: 'SESSION_REQUIRED' });
      return json(res, 200, { authenticated: true, host: DEMO_HOSTS[session.hostId], username: DEMO_USER, simulated: true });
    }
    if (url.pathname === '/dashboard') {
      if (!session) return sendHtml(res, html('演示会话已失效', '<h1>请重新打开演示会话</h1>'), 401);
      return sendHtml(res, html('MegaRAC SP-X · 模拟会话', '<span class="tag">MegaRAC SP-X · 本地模拟</span><h1>正在验证浏览器会话…</h1><p id="result">检查网关 Cookie 和 BMC 页面会话状态。</p><dl id="details"></dl><p><a href="http://127.0.0.1:43170/">返回本地 Tower</a></p><small>未连接真实设备。真实页面代理、KVM 和固件兼容性尚未验证。</small>',
        `fetch('/api/status',{headers:{'X-CSRFTOKEN':sessionStorage.getItem('garc')||''}}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(d=>{document.querySelector('h1').textContent='模拟会话已建立';const result=document.getElementById('result');result.textContent='浏览器会话验证通过，无需输入演示密码。';result.className='success';for(const [key,value] of [['主机',d.host.name],['IPMI 地址',d.host.ip],['演示用户',d.username]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;document.getElementById('details').append(dt,dd)}}).catch(()=>{document.querySelector('h1').textContent='会话验证失败';document.getElementById('result').textContent='请从本地 Tower 重新打开。'});`));
    }
    if (url.pathname === '/login') {
      const host = DEMO_HOSTS[url.searchParams.get('host')];
      return sendHtml(res, html('MegaRAC SP-X · 模拟登录页', `<span class="tag">MegaRAC SP-X · 本地模拟</span><h1>IPMI 登录</h1><p>${host ? `${host.name} · ${host.ip}` : '未选择演示主机'}</p><label>用户名<input disabled placeholder="仅展示原生登录入口"></label><label>密码<input disabled type="password" placeholder="不输入真实密码"></label><p>普通跳转已完成。要验证自动登录，请在插件配置中选择“MegaRAC 自动登录 · 模拟”。</p><p><a href="http://127.0.0.1:43170/">返回本地 Tower</a></p>`));
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  return { handler, dispose: () => { clearInterval(timer); tickets.clear(); sessions.clear(); } };
}
