import React from 'react';
import ReactDOM from 'react-dom';
import { createSshSettings } from '../../../framework/src/ssh-settings.js';
const h = React.createElement, Settings = createSshSettings(React);
let enabled = false, approved = false, failApproval = false;
const sha = 'a'.repeat(64), pluginId = 'rivetin-demo-collector';
function registration() {
  return { pluginId, pluginName: { 'zh-CN': '示例身份采集（模拟）', 'en-US': 'Example identity collection (mock)' }, packageId: 'b'.repeat(64), digest: sha, approved,
    commands: [{ id: 'host-identity', operation: 'host.identity', purpose: { 'zh-CN': '读取内核身份，用于本地模拟审核流程。', 'en-US': 'Read kernel identity for the local mock review flow.' }, hostIds: ['demo-host-1', 'demo-host-2'], intervalSeconds: 86400, preview: ['/usr/bin/uname -srm'], risk: 'read-only' }] };
}
const client = async (route, method = 'GET', body) => {
  if (route !== '/ssh-channel') throw new Error('DEMO_ROUTE_UNAVAILABLE');
  if (method === 'GET') return { enabled, transportReady: true, hosts: ['1', '2'].map(n => ({ hostId: `demo-host-${n}`, clusterId: 'demo-cluster', address: `192.0.2.${10 + Number(n)}`, username: 'example-reader', hostKeySha256: 'SHA256:EXAMPLE_NOT_A_HOST_KEY', credentialConfigured: true })), registrations: [registration()], recentRuns: [] };
  if (body.action === 'review') return { challenge: 'demo-challenge', digest: sha, expiresAt: Date.now() + 120000, registration: registration() };
  if (body.action === 'approve') {
    if (failApproval) { failApproval = false; throw new Error('SSH_APPROVAL_CONFLICT'); }
    if (!enabled || body.digest !== sha || body.challenge !== 'demo-challenge' || body.acknowledged !== true) throw new Error('SSH_APPROVAL_REJECTED');
    approved = true; return { approved: true };
  }
  if (body.action === 'revoke') { approved = false; return { approved: false }; }
  throw new Error('DEMO_ACTION_UNAVAILABLE');
};
function App() {
  const [locale, setLocale] = React.useState('zh-CN'), [generation, setGeneration] = React.useState(0);
  const en = locale === 'en-US', t = (zh, english) => en ? english : zh;
  function toggle() { enabled = !enabled; approved = false; setGeneration(value => value + 1); }
  return h(React.Fragment, null,
    h('header', null, h('strong', null, t('Rivetin · SSH 通道本地演示', 'Rivetin · SSH channel local demo')),
      h('button', { onClick: toggle }, enabled ? t('模拟关闭通道', 'Mock channel off') : t('模拟启用通道', 'Mock channel on')),
      h('button', { onClick: () => { failApproval = true; } }, t('模拟下次授权失败', 'Fail next mock approval')),
      h('button', { onClick: () => { setLocale(en ? 'zh-CN' : 'en-US'); document.documentElement.lang = en ? 'zh-CN' : 'en-US'; } }, en ? '中文' : 'English')),
    h('div', { className: 'demo-notice' }, t('所有主机、凭据状态、命令登记与授权均为内存模拟；此演示没有网络采集能力，不连接 CloudTower 或任何主机。', 'All hosts, credential states, command registrations and approvals are in-memory mocks. This demo has no collection transport and connects to neither CloudTower nor hosts.')),
    h('main', { className: 'demo-content' }, h(Settings, { key: generation, client, locale })));
}
ReactDOM.render(h(App), document.getElementById('root'));
