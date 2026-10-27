import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import Hub from 'pluginKitDemo/PluginKit';

const h = React.createElement;
const hosts = {
  'demo-node-1': { name: 'Demo-Node-01', ip: '192.0.2.21', ipmi: '203.0.113.21' },
  'demo-node-2': { name: 'Demo-Node-02', ip: '192.0.2.22', ipmi: '203.0.113.22' },
  'demo-node-3': { name: 'Demo-Node-03', ip: '192.0.2.23', ipmi: '' },
};
function Field({ label, value }) {
  const [copied, setCopied] = useState(false);
  return h('div', { className: 'ip-field' },
    h('div', { className: 'copy-icon-wrapper' },
      value ? h('span', { className: 'copy-content' }, value) : h('span', null, '未配置'),
      value && h('button', { className: 'copy-button', 'aria-label': `复制${label}`,
        onClick: async () => { try { await navigator.clipboard.writeText(value); } catch { /* A secure browser context may be required. */ } setCopied(true); } }, copied ? '✓' : '⧉')),
    h('label', null, label));
}
function App() {
  const [route, setRoute] = useState(location.hash), [menu, setMenu] = useState(false), [english, setEnglish] = useState(false);
  useEffect(() => { document.documentElement.lang = english ? 'en-US' : 'zh-CN'; }, [english]);
  useEffect(() => { const change = () => setRoute(location.hash); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = event => { if (!event.target.closest('.main-menu,.switcher')) setMenu(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [menu]);
  const id = /\/hosts\/([^?]+)/.exec(route)?.[1] || 'demo-node-1';
  const host = hosts[id] || hosts['demo-node-1'];
  function select(next) { location.hash = `/hosts/${next}?view=%22detail%22`; }
  return h(React.Fragment, null,
    h('header', { className: 'topbar' }, h('div', { className: 'brand' }, h('span', null, '◩'), 'CloudTower', h('small', null, 'LOCAL')),
      h('button', { className: 'switcher', onClick: () => setMenu(!menu), 'aria-expanded': menu }, '集群 ▾'),
      h('div', { className: 'search' }, '⌕  搜索…'), h('span', { className: 'demo-mark' }, '本地原型 · 模拟数据'),
      h('button', { className: 'language-button', onClick: () => setEnglish(!english) }, english ? '中文' : 'English'), h('div', { className: 'avatar' }, 'D')),
    menu && h('div', { className: 'main-menu', role: 'menu', 'aria-label': '主菜单' },
      h('div', { className: 'menu-column' }, h('small', null, '资源中心'), ...['集群', '内容库', '文件存储', 'Kubernetes 服务', '容器镜像仓库', '网络与安全'].map(text => h('button', { key: text, role: 'menuitem' }, text))),
      h('div', { className: 'menu-column' }, h('small', null, '运维工具'), ...['巡检中心', '资源优化', '回收站', '报表', '升级中心'].map(text => h('button', { key: text, role: 'menuitem' }, text)),
        h('div', { className: 'settings-group', role: 'group', 'aria-label': '设置' }, h('small', null, '设置'),
          h('button', { role: 'menuitem' }, english ? 'System settings' : '系统配置'),
          h('button', { role: 'menuitem' }, h('span', null, english ? 'Label management' : '标签管理'))))),
    h('aside', { className: 'sidebar' }, h('div', { className: 'lab' }, '◈ 示例实验室', h('small', null, '● 本地模拟集群')),
      h('div', { className: 'tree' }, h('p', null, '▧ Demo-Datacenter'), h('p', null, '　▾ Demo-Cluster-01'),
        ...Object.entries(hosts).map(([key, value]) => h('button', { key, className: id === key ? 'selected' : '', onClick: () => select(key) }, `▱ ${value.name}`))),
      h('div', { className: 'sidebar-foot' }, '1 数据中心，1 集群，3 主机')),
    h('main', null, h('div', { className: 'breadcrumb' }, '示例实验室　›　Demo-Datacenter　›　Demo-Cluster-01'),
      h('div', { className: 'heading' }, h('h1', null, host.name), h('span', { className: 'connection' }, '● 模拟环境')),
      h('div', { className: 'tabs' }, h('button', { className: 'active' }, '概览'), ...['虚拟机', '监控视图', '硬件运行状况'].map(text => h('button', { key: text }, text))),
      h('section', { className: 'info-card' }, h('h2', null, '主机信息'),
        h('div', { className: 'facts' }, ...[['CPU 型号', 'AMD EPYC 7K62 48-Core Processor'], ['服务器型号', 'VMware, Inc. VMware20,1'], ['CPU 总量', '24 核 × 2.5 GHz'], ['物理盘池', '1 个'], ['CPU 架构', 'x86_64'], ['运行时间', '本地模拟数据'], ['内存容量', '125.3 GiB'], ['序列号', 'DEMO-ONLY-0001']].map(([label, value]) => h('div', { key: label, className: 'fact' }, h('span', null, label), h('strong', null, value)))),
        h('div', { className: 'ip-row' }, h(Field, { label: english ? 'Management IP' : '管理 IP', value: host.ip }),
          h(Field, { label: english ? 'Storage IP' : '存储 IP', value: '198.51.100.21' }), h(Field, { label: 'IPMI IP', value: host.ipmi }))),
      h('section', { className: 'disk-card' }, h('strong', null, 'SMTX 系统盘'), h('span', null, '详情　›')),
      h('div', { className: 'grid' }, ...[['物理盘', '2', 'NVMe SSD'], ['网口', '8', '已连接'], ['USB 设备', '0', '已挂载'], ['CPU', '18.65%', '最近 2 小时平均使用率'], ['CPU 分配', '24', 'CPU'], ['内存', '4.25%', '最近 2 小时平均使用率']].map(([title, number, note]) => h('section', { className: 'metric-card', key: title }, h('h2', null, title), h('strong', null, number), h('span', null, note), h('div', { className: 'sparkline' })))),
      h('p', { className: 'local-footnote' }, '所有 IP 和主机均用于页面模拟。IPMI 链接只打开本地演示网关；本原型不连接真实 Tower 或 BMC。')),
    h(Hub, null));
}
if (!location.hash) location.hash = '/hosts/demo-node-1?view=%22detail%22';
ReactDOM.render(h(App), document.getElementById('root'));
