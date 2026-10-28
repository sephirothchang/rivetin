import { createMockTopology } from './mock.js';
import { assess, createMockSession, lockedSwitch, protectedSwitch } from './model.js';
import { CANVAS_WIDTH, createLayout } from './layout.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const riskText = {
  NETWORK_REPARENT: ['虚拟网络所属 VDS 将改变，可能中断虚拟机通信。请核对目标上联、VLAN 与连通性。', 'Changing the parent VDS may interrupt VM connectivity. Check uplinks, VLANs and connectivity.'],
  INTERRUPTION: ['上联重连可能造成虚拟机丢包或业务中断。', 'Uplink reconnection may drop packets or interrupt VM workloads.'],
  NO_UPLINK: ['该主机上的网络将失去全部可用上联，禁止应用。', 'This host would have no active uplink for this network. Apply is blocked.'],
  SINGLE_UPLINK: ['仅剩单个可用网口，失去链路冗余。', 'Only one active port remains. Link redundancy is lost.'],
  BANDWIDTH_DROP: ['active-backup 可用单链路速率上限下降。', 'The available single-link capacity of active-backup decreases.'],
  SINGLE_FABRIC: ['上联集中到同一个模拟物理故障域。', 'Uplinks share one simulated physical failure domain.'],
  MTU_MISMATCH: ['网卡 MTU 小于 VDS 要求，禁止应用。', 'NIC MTU is below the VDS requirement. Apply is blocked.'],
  CREATE_OBJECTS: ['将新增拓扑对象，请核对名称、VLAN 与所属 VDS。', 'New topology objects will be created. Check names, VLANs and parent VDSs.'],
  UNBOUND_VDS: ['尚未关联主机上联，当前不能承载跨主机网络流量。', 'No host uplinks are connected. Cross-host traffic is not available yet.'],
  VLAN_REUSE: ['同一 VDS 内有相同 VLAN 的网络，可能共享二层广播域。', 'Networks in this VDS reuse a VLAN and may share a layer-2 broadcast domain.'],
  VLAN_MISMATCH: ['物理上联未覆盖所需 VLAN，禁止应用。', 'Required VLANs are absent on the uplink. Apply is blocked.']
};

// Standalone mock UI. Live inventory, DOM, identifiers and credentials are never imported.
export function mountDemo(root, win, { session = createMockSession(createMockTopology()) } = {}) {
  const doc = win.document;
  let editing = false, selectedVds = null, selectedNic = null, selectedNetwork = null, drawer = null, modal = null;
  let sidebarTab = 'components', revealAnchor = null, suppressPaletteClickUntil = 0, hoveredDrop = null;
  let binding = null, toast = '', showLines = true, zoom = 75, focusMode = false, disposed = false;
  let exitAfterSave = false, drag = null, pointer = null, suppressNicClickUntil = 0, lastTransaction = '', resetScroll = false;
  const collapsed = new Set(), expandedUnused = new Set();
  const layout = createLayout();
  const t = (zh, en) => doc.documentElement.lang.toLowerCase().startsWith('en') ? en : zh;
  const swName = (topology, id) => topology.switches.find(s => s.id === id)?.name || t('未使用', 'Unused');
  const hostName = (topology, id) => topology.hosts.find(h => h.id === id)?.name || '';
  const button = (action, label, className = '', disabled = false, attrs = '') => `<button type="button" data-action="${action}" class="${className}" ${disabled ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const status = () => {
    const view = session.view();
    return { ...view, topology: view.draft, plan: view.pendingPlan || assess(view.current, view.draft) };
  };
  const icon = (kind, label = '') => `<span class="object-icon ${kind}" aria-hidden="true">${{ vds: '▦', host: '▱', network: '♧', port: '▣', peer: '▤', vm: '▧' }[kind] || '◇'}</span>${label}`;
  const isEditable = () => editing && session.view().state === 'editing';
  function render() {
    if (disposed) return;
    const previousViewport = root.querySelector('.viewport');
    const scroll = resetScroll ? { x: 0, y: 0 } : { x: previousViewport?.scrollLeft || 0, y: previousViewport?.scrollTop || 0 };
    resetScroll = false;
    const view = status(), { topology, plan } = view, pending = view.state === 'pending';
    if (selectedVds && !topology.switches.some(sw => sw.id === selectedVds)) { selectedVds = null; selectedNetwork = null; if (drawer !== 'nic') drawer = null; }
    if (selectedNetwork && !topology.switches.some(sw => sw.networks?.some(net => net.id === selectedNetwork))) { selectedNetwork = null; if (drawer === 'network') drawer = null; }
    lastTransaction = `${view.state}:${view.outcome}`;
    root.innerHTML = `<div class="cloud-shell ${focusMode ? 'focus-mode' : ''}">
      <header class="global-header"><div class="cloud-brand"><span>◈</span>CloudTower <small>${t('模拟界面', 'MOCK UI')}</small></div><span class="scope">${t('集群', 'Clusters')}⌄</span><div class="global-search">⌕ ${t('搜索...', 'Search...')}</div><span class="organization">${t('示例组织', 'Example organization')}</span><span class="preview-label">Rivetin · LOCAL DEMO</span><label class="locale"><select id="language" aria-label="Host language"><option value="zh-CN" ${t('selected', '')}>简体中文</option><option value="en-US" ${t('', 'selected')}>English</option></select></label><span class="avatar">D</span></header>
      ${sidebar(view)}
      <main class="cluster-main"><div class="cluster-header"><div class="breadcrumbs">${t('示例组织', 'Example organization')} › Demo-Datacenter ›</div><div class="cluster-title"><h1>Demo-Cluster</h1><span class="local-only">${t('仅本地预览 · 无真实网络操作', 'Local preview · No live network operations')}</span></div><div class="cluster-tabs"><span>${t('概览', 'Overview')}</span><span>${t('主机', 'Hosts')}</span><span>${t('虚拟机', 'VMs')}</span><strong>${t('网络拓扑', 'Network topology')}</strong><span>${t('监控分析', 'Monitoring')}</span><span>⚙ ${t('设置', 'Settings')}</span><span class="all-view">▦ ${t('全部', 'All')}⌄</span><div class="edit-controls">${pending ? '' : editing ? button('discard', t('丢弃草稿', 'Discard draft'), 'quiet', !plan.operationCount) + button('exit-edit', t('退出编辑', 'Exit editing'), 'quiet') + button('review', t('审查并保存', 'Review & save'), 'primary', !plan.operationCount) : button('enter-edit', t('编辑拓扑', 'Edit topology'), 'primary')}</div></div></div>
      <div class="demo-ribbon"><span>ⓘ</span> ${editing ? t('拖动对象自由布局；拖动圆形连接点调整关联；本轮新建对象拖到左下垃圾桶可删除。', 'Move objects to arrange them. Drag circular connectors to change links. Drag new drafts to the lower-left trash to delete.') : t('按真实页面的四列对象结构制作；名称、地址和连接均为模拟数据。点击“编辑拓扑”体验草稿操作。', 'Based on the observed four-column page structure. Names, addresses and connections are synthetic. Choose Edit topology to try draft changes.')}<span class="ribbon-lock">◇ ${t('管理 / 存储受保护', 'Management / storage protected')}</span></div>
      <section class="topology-canvas" aria-label="${t('网络拓扑画布', 'Network topology canvas')}"><div class="canvas-top-controls"><label><input id="show-lines" type="checkbox" ${showLines ? 'checked' : ''}> ${t('显示连线', 'Show connections')}</label>${button('refresh-view', '↻', 'icon-button', false, `aria-label="${t('重置视图', 'Reset view')}"`)}</div>
      <div class="viewport" data-create-canvas="true"><div class="scene-space zoom-${zoom}"><div class="scene"><svg class="topology-links" viewBox="0 0 1260 1350" aria-hidden="true"></svg><div class="scene-grid">
        <section class="layer vm-layer"><h2>${t('虚拟机', 'Virtual machines')} <small>${t('按虚拟机网络分组', 'By VM network')}</small><span>▽</span></h2>${(topology.vmGroups || []).map(group => `<div class="vm-group" data-anchor="vm:${group.networkId}">${icon('vm')}<span>${esc(group.name)}</span><b>${group.count}</b>⌄</div>`).join('')}</section>
        <section class="layer vds-layer" data-create-canvas="true"><h2>${t('虚拟分布式交换机', 'Distributed switches')}<span>▽</span></h2>${topology.switches.map(sw => vdsCard(sw, view)).join('')}<div class="creation-dropzone" data-create-canvas="true"><span>＋</span>${t('拖入 VDS 或虚拟网络', 'Drop a VDS or virtual network here')}<small>${t('自动创建到草稿', 'Automatically create draft objects')}</small></div></section>
        <section class="layer host-layer"><h2>${t('主机', 'Hosts')}<span>▽</span></h2>${topology.hosts.map(host => hostCard(host, view)).join('')}</section>
        <section class="layer physical-layer"><h2>${t('物理交换机', 'Physical switches')}<span>▽</span></h2>${(topology.peers || []).map(peer => peerCard(peer, view)).join('')}<div class="unknown-peer">${icon('peer')} ${t('未识别的物理交换机', 'Unidentified physical switch')} ⓘ</div></section>
      </div></div></div></div>
      <div class="canvas-bottom-note">${t('社区独立开发，非 SmartX 官方产品', 'Community project, not an official SmartX product')} · <a href="https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-network-topology">GitHub</a> · <a href="/LICENSE">MIT</a></div><div class="zoom-controls">${button('zoom-out', '−', '', zoom === 50, 'aria-label="Zoom out"')}<span>${zoom}%</span>${button('zoom-in', '+', '', zoom === 150, 'aria-label="Zoom in"')}${button('fit', '⛶', '', false, 'aria-label="Fit topology"')}${button('focus', focusMode ? '↙' : '↗', '', false, `aria-label="${t('切换专注视图', 'Toggle focus view')}"`)}</div></section>
      <div id="transaction" class="transaction ${pending ? 'pending' : ''}" role="status">${transaction(view)}</div></main>
      <div class="canvas-trash" data-trash="true" hidden><span aria-hidden="true">🗑</span><strong>${t('拖到此处删除', 'Drop here to delete')}</strong><small>${t('仅本轮新建草稿；新 VDS 的新建子网络一并移除', 'New drafts only; new child networks are removed with their VDS')}</small></div><div class="drag-label" hidden></div>${drawer ? details(view) : ''}${modal ? dialog(view) : ''}<div class="toast" role="status" ${toast ? '' : 'hidden'}>${esc(toast)}</div></div>`;
    root.querySelector('.viewport').scrollLeft = scroll.x;
    root.querySelector('.viewport').scrollTop = scroll.y;
    placeNodes(topology); sizeScene();
    if (revealAnchor) {
      const target = [...root.querySelectorAll('[data-anchor]')].find(el => el.dataset.anchor === revealAnchor);
      const viewport = root.querySelector('.viewport');
      if (target) { const a = target.getBoundingClientRect(), b = viewport.getBoundingClientRect();
        if (a.bottom > b.bottom - 24) viewport.scrollTop += a.bottom - b.bottom + 24;
        if (a.top < b.top + 12) viewport.scrollTop -= b.top - a.top + 12;
        if (a.right > b.right - 24) viewport.scrollLeft += a.right - b.right + 24;
        if (a.left < b.left + 12) viewport.scrollLeft -= b.left - a.left + 12;
      }
      revealAnchor = null;
    }
    drawLinks();
    if (modal) root.querySelector('.dialog')?.focus();
  }

  function sidebar(view) {
    const { topology } = view;
    const tabs = `<div class="sidebar-tabs">${button('sidebar-components', t('组件库', 'Components'), sidebarTab === 'components' ? 'active' : '')}${button('sidebar-tree', t('资源树', 'Resources'), sidebarTab === 'tree' ? 'active' : '')}</div>`;
    if (sidebarTab === 'tree') return `<aside class="resource-tree">${tabs}<div class="tree-org">⌄ ◉ ${t('示例组织', 'Example organization')}<small>● ${t('全部集群已连接（模拟）', 'All clusters connected (mock)')}</small></div><div class="tree-dc">⌄ ▥ Demo-Datacenter</div><div class="tree-cluster">⌄ ▦ Demo-Cluster</div>${topology.hosts.map(host => `<div class="tree-host">${icon('host')} ${host.name}</div>`).join('')}<p class="tree-summary">1 ${t('数据中心', 'datacenter')}，1 ${t('集群', 'cluster')}，3 ${t('主机', 'hosts')}</p><div class="tree-footer">⚙ ${t('视图选项', 'View options')}</div></aside>`;
    return `<aside class="resource-tree component-library">${tabs}<div class="library-heading"><small>TOPOLOGY BUILDER</small><h2>${t('拖拽构建网络', 'Build your network')}</h2><p>${t('拖到画布，自动生成对象草稿。', 'Drop on the canvas to create draft objects.')}</p></div><div class="palette-items">${['vds', 'network'].map(kind => `<button type="button" class="palette-item" data-action="palette-create" data-palette="${kind}" ${isEditable() ? 'draggable="true"' : 'disabled'}><span class="palette-symbol">${icon(kind)}</span><span><strong>${kind === 'vds' ? t('分布式交换机', 'Distributed switch') : t('虚拟网络', 'Virtual network')}</strong><small>${kind === 'vds' ? 'VDS · active-backup' : t('虚拟机网络 · VLAN', 'VM network · VLAN')}</small></span><span class="palette-grip">⠿</span></button>`).join('')}</div><div class="palette-guide"><strong>${isEditable() ? t('拖放规则', 'Drop rules') : view.state === 'pending' ? t('等待本轮二次确认', 'Awaiting confirmation') : t('先进入编辑模式', 'Enter edit mode first')}</strong><p>${t('VDS → 画布空白处。', 'VDS → empty canvas.')}</p><p>${t('虚拟网络 → 可编辑 VDS；空白处会配套创建新 VDS。', 'Virtual network → editable VDS. Empty canvas also creates its parent VDS.')}</p><small>${t('卡片拖动 = 布局；圆形连接点拖动 = 关联。新建草稿可拖入左下垃圾桶。', 'Move cards to arrange; drag circular ports to reconnect. Trash new drafts at the lower left.')}</small></div><div class="inventory-legend"><h3>${t('已有资源图例', 'Existing inventory')}</h3><div>${icon('host')} ${t('主机', 'Host')}</div><div>${icon('port')} ${t('物理网卡', 'Physical NIC')}</div><div>${icon('peer')} ${t('物理交换机', 'Physical switch')}</div><small>${t('来自已有清单与 LLDP，不通过拖拽创建硬件。', 'Inventory and LLDP objects; hardware is not created by dragging.')}</small></div><div class="palette-safety">◇ ${t('管理与存储对象始终锁定', 'Management and storage stay locked')}<small>${t('草稿 → 风险审查 → 90 秒人工确认', 'Draft → risk review → 90-second confirmation')}</small></div></aside>`;
  }

  function sizeScene() {
    const space = root.querySelector('.scene-space'), scene = root.querySelector('.scene'), svg = root.querySelector('.topology-links');
    const height = Math.min(6750, Math.max(1350, Math.ceil(Math.max(root.querySelector('.scene-grid').scrollHeight + 40, layout.bottom()) / 450) * 450));
    space.classList.add(`height-${height}`); scene.dataset.height = height; svg.setAttribute('viewBox', `0 0 ${CANVAS_WIDTH} ${height}`);
  }

  function placeNodes(topology) {
    layout.sync(topology);
    const scene = root.querySelector('.scene'), overlay = doc.createElement('div');
    overlay.className = 'free-nodes'; scene.append(overlay);
    for (const node of [...root.querySelectorAll('.virtual-network'), ...root.querySelectorAll('.vds-card')]) {
      overlay.append(node);
      if (node.classList.contains('vds-card')) node.querySelector('.network-list')?.remove();
      const point = layout.get(node.dataset.anchor);
      node.style.left = `${point.x}px`; node.style.top = `${point.y}px`;
    }
    root.querySelector('.creation-dropzone').style.marginTop = `${Math.min(layout.bottom() - 150, 6450)}px`;
  }

  function vdsCard(sw, view) {
    const created = view.plan.creations.some(item => item.kind === 'vds' && item.id === sw.id);
    const locked = lockedSwitch(sw), selected = selectedVds === sw.id, folded = collapsed.has(`vds:${sw.id}`);
    return `<article class="node-card vds-card ${created ? 'created-object' : ''} ${selected ? 'node-selected' : ''} ${locked ? 'protected-card' : ''}" data-layout-node="vds" data-object-id="${sw.id}" data-anchor="vds:${sw.id}" data-drop-vds="${sw.id}"><div class="node-heading" data-select-vds="${sw.id}" ${isEditable() && !locked ? `data-move-node="vds" data-object-id="${sw.id}" tabindex="0" aria-label="${t('移动交换机', 'Move switch')} ${esc(sw.name)}"` : ''}>${icon('vds')}${created ? `<span class="created-badge">${t('新建', 'NEW')}</span>` : ''}<button type="button" class="node-title" data-action="select-vds" data-vds="${sw.id}">${esc(sw.name)}</button>${locked ? `<span class="lock-badge" title="${t('受保护或只读', 'Protected or read-only')}">◇</span>` : ''}${button('collapse', folded ? '⌄' : '⌃', 'fold-button', false, `data-fold="vds:${sw.id}" aria-label="${t('折叠 VDS', 'Collapse VDS')} ${esc(sw.name)}"`)}</div>${folded ? '' : `<div class="network-list">${(sw.networks || []).map(net => `<div class="virtual-network ${view.plan.creations.some(item => item.id === net.id) ? 'created-network' : ''}" data-layout-node="network" data-object-id="${net.id}" ${isEditable() && !locked ? `data-move-node="network" tabindex="0" aria-label="${t('移动虚拟网络', 'Move virtual network')} ${esc(net.name)}"` : ''} data-anchor="network:${net.id}">${isEditable() && !locked ? `<button class="connector network-connector" type="button" draggable="true" data-drag-network="${net.id}" aria-label="${t('拖拽更换所属 VDS', 'Drag to change parent VDS')} ${esc(net.name)}" title="${t('拖到目标 VDS 更换关联', 'Drag to the target VDS to change its association')}">○</button>` : ''}${locked ? '<span class="network-lock">◇</span>' : ''}${icon('network')}<div><button type="button" class="network-title" data-action="network-info" data-network="${net.id}" data-vds="${sw.id}">${esc(net.name)}</button>${['management', 'storage'].includes(net.role) ? `<small>${t('用途', 'Role')}：${net.role === 'management' ? t('管理', 'Management') : t('存储', 'Storage')}</small>` : ''}</div><span class="vlan-pill">${net.vlan}</span></div>`).join('') || `<div class="no-network">${t('无虚拟网络', 'No virtual network')}</div>`}</div>`}${isEditable() && !locked ? `<button class="connector vds-connector" type="button" draggable="true" data-drag-vds="${sw.id}" aria-label="${t('拖拽连接主机上联', 'Drag to connect host uplinks')} ${esc(sw.name)}" title="${t('拖到主机 / bond 配置上联', 'Drag to a host / bond to configure uplinks')}">○</button>` : ''}${selected ? `<div class="node-actions">${button('vds-info', t('ⓘ 查看详情', 'ⓘ Details'), '', false, `data-vds="${sw.id}"`)}${isEditable() && !locked ? button('bind-vds', t('✎ 配置主机上联', '✎ Host uplinks'), '', false, `data-vds="${sw.id}"`) : ''}</div>` : ''}</article>`;
  }

  function hostCard(host, view) {
    const { topology, plan } = view, folded = collapsed.has(`host:${host.id}`), unused = topology.nics.filter(n => n.hostId === host.id && n.switchId === null);
    const bonds = topology.switches.filter(sw => topology.nics.some(n => n.hostId === host.id && n.switchId === sw.id));
    return `<article class="node-card host-card" data-anchor="host:${host.id}" data-drop-host="${host.id}"><div class="node-heading host-heading">${icon('host')}<div><strong>${host.name}</strong><small>${t('管理 IP', 'Management IP')}：${host.address}</small></div>${button('collapse', folded ? '⌄' : '⌃', 'fold-button', false, `data-fold="host:${host.id}" aria-label="${t('折叠主机', 'Collapse host')} ${host.name}"`)}</div>${folded ? '' : `<div class="bond-list">${bonds.map(sw => {
      const members = topology.nics.filter(n => n.hostId === host.id && n.switchId === sw.id);
      return `<div class="bond ${selectedVds === sw.id ? 'bond-highlight' : ''}" data-anchor="bond:${host.id}:${sw.id}" data-drop-bond="${sw.id}" data-host="${host.id}"><div class="bond-label"><span>♧</span><div><strong>${esc(sw.bridge)}</strong><small>active-backup${lockedSwitch(sw) ? ' ◇' : ''}</small></div></div><div class="bond-ports">${members.map((nic, index) => nicButton(nic, index === 0 ? 'A' : 'B', topology, plan)).join('')}</div></div>`;
    }).join('')}${expandedUnused.has(host.id) ? `<div class="unused-ports" data-drop-unused="${host.id}">${unused.map(nic => nicButton(nic, '', topology, plan)).join('') || `<small>${t('没有未使用网口', 'No unused ports')}</small>`}</div>` : ''}${button('unused', `${expandedUnused.has(host.id) ? t('收起未使用网口', 'Hide unused ports') : t('展开未使用网口', 'Show unused ports')} (${unused.length}) ${expandedUnused.has(host.id) ? '⌃' : '⌄'}`, 'unused-toggle', false, `data-host="${host.id}"`)}</div>`}</article>`;
  }

  function nicButton(nic, memberRole, topology, plan) {
    const sw = topology.switches.find(s => s.id === nic.switchId), locked = sw && lockedSwitch(sw);
    const changed = plan.changes.some(c => c.nicId === nic.id);
    return `<button type="button" class="nic ${locked ? 'locked-nic' : ''} ${changed ? 'changed-nic' : ''} ${selectedNic === nic.id ? 'selected-nic' : ''}" data-nic="${nic.id}" data-anchor="nic:${nic.id}" ${isEditable() && !locked ? `draggable="true" data-drag-nic="${nic.id}"` : ''} aria-label="${hostName(topology, nic.hostId)} ${nic.name} ${esc(swName(topology, nic.switchId))}${locked ? t(' 受保护', ' protected') : ''}"><span class="nic-speed">${nic.speed}</span>${memberRole ? `<span class="member-role">${memberRole}</span>` : ''}<span class="port-symbol">▣</span><span class="nic-name">${nic.name}</span>${changed ? '<i>•</i>' : ''}</button>`;
  }

  function peerCard(peer, view) {
    const folded = collapsed.has(`peer:${peer.id}`);
    return `<article class="node-card peer-card" data-anchor="peer:${peer.id}"><div class="node-heading">${icon('peer')}<div><strong>${peer.name}</strong><small>${peer.address} · LLDP ${t('模拟邻居', 'mock peer')}</small></div>${button('collapse', folded ? '⌄' : '⌃', 'fold-button', false, `data-fold="peer:${peer.id}" aria-label="${t('折叠物理交换机', 'Collapse physical switch')} ${peer.name}"`)}</div>${folded ? '' : `<div class="peer-ports">${view.topology.nics.filter(n => n.peerId === peer.id).map(nic => `<div class="peer-port" data-anchor="peer-port:${nic.id}">${icon('port')}<span>${nic.peerPort}</span><small>${hostName(view.topology, nic.hostId).replace('Demo-', '')} / ${nic.name}</small></div>`).join('')}</div>`}</article>`;
  }

  function drawLinks() {
    const svg = root.querySelector('.topology-links'), scene = root.querySelector('.scene');
    if (!svg || !scene || !showLines) return;
    const topology = session.view().draft, base = scene.getBoundingClientRect(), factor = base.width ? CANVAS_WIDTH / base.width : 1;
    const anchors = new Map([...root.querySelectorAll('[data-anchor]')].map(el => [el.dataset.anchor, el]));
    const edges = [];
    const edge = (from, to, id, swId = null, physical = false, membership = false) => {
      const source = anchors.get(from), target = anchors.get(to); if (!source || !target) return;
      const a = source.getBoundingClientRect(), b = target.getBoundingClientRect();
      const x1 = ((membership ? a.left : a.right) - base.left) * factor, y1 = (a.top + a.height / 2 - base.top) * factor;
      const x2 = (b.left - base.left) * factor, y2 = (b.top + b.height / 2 - base.top) * factor;
      const bend = Math.max(35, Math.abs(x2 - x1) * .48);
      const cx1 = membership ? Math.min(x1, x2) - 40 : x1 + bend, cx2 = membership ? Math.min(x1, x2) - 40 : x2 - bend;
      const selected = selectedVds && selectedVds === swId || selectedNic && id === `physical:${selectedNic}`;
      edges.push(`<path data-edge="${esc(id)}" class="${membership ? 'membership-link' : physical ? 'physical-link' : 'logical-link'} ${selected ? 'selected-link' : ''}" d="M${x1} ${y1} C${cx1} ${y1},${cx2} ${y2},${x2} ${y2}"/>`);
    };
    for (const sw of topology.switches) for (const net of sw.networks || []) edge(`network:${net.id}`, `vds:${sw.id}`, `membership:${net.id}`, sw.id, false, true);
    for (const group of topology.vmGroups || []) edge(`vm:${group.networkId}`, `network:${group.networkId}`, `vm:${group.networkId}`);
    for (const host of topology.hosts) for (const sw of topology.switches) if (topology.nics.some(n => n.hostId === host.id && n.switchId === sw.id)) {
      edge(`vds:${sw.id}`, anchors.has(`bond:${host.id}:${sw.id}`) ? `bond:${host.id}:${sw.id}` : `host:${host.id}`, `vds:${sw.id}:${host.id}`, sw.id);
    }
    for (const nic of topology.nics) edge(`nic:${nic.id}`, anchors.has(`peer-port:${nic.id}`) ? `peer-port:${nic.id}` : `peer:${nic.peerId}`, `physical:${nic.id}`, nic.switchId, true);
    svg.innerHTML = edges.join('');
  }

  function creationFields(view, kind, entity) {
    const existing = kind === 'vds' ? view.current.switches.some(sw => sw.id === entity.id) : view.current.switches.some(sw => sw.networks?.some(net => net.id === entity.id));
    if (existing || !isEditable()) return '';
    return `<section class="creation-fields"><strong>${t('新建对象草稿', 'New object draft')}</strong><label for="created-name">${t('名称', 'Name')}</label><input id="created-name" maxlength="64" value="${esc(entity.name)}">${kind === 'vds' ? `<label for="created-mtu">MTU</label><select id="created-mtu"><option value="1500" ${entity.mtu === 1500 ? 'selected' : ''}>1500</option><option value="9000" ${entity.mtu === 9000 ? 'selected' : ''}>9000</option></select>` : `<label for="created-vlan">VLAN ID</label><input id="created-vlan" type="number" min="1" max="4094" value="${entity.vlan}">`}${button('update-created', t('更新对象草稿', 'Update object draft'), 'secondary full-width', false, `data-kind="${kind}" data-id="${entity.id}"`)}<small>${t('仅更新草稿，应用时仍需风险审查。', 'Draft only. Risk review is required before apply.')}</small></section>`;
  }

  function details(view) {
    const topology = view.topology, nic = topology.nics.find(n => n.id === selectedNic);
    const sw = topology.switches.find(s => s.id === (drawer === 'nic' ? nic?.switchId : selectedVds));
    const network = sw?.networks?.find(net => net.id === selectedNetwork);
    const title = drawer === 'nic' ? `${hostName(topology, nic?.hostId)} / ${nic?.name}` : drawer === 'network' ? network?.name : sw?.name;
    let body = '';
    if (drawer === 'network' && network) {
      body = `${creationFields(view, 'network', network)}<h3>${t('虚拟网络', 'Virtual network')}</h3><dl><dt>${t('名称', 'Name')}</dt><dd>${esc(network.name)}</dd><dt>VDS</dt><dd>${esc(sw.name)}</dd><dt>VLAN ID</dt><dd>${network.vlan}</dd><dt>${t('用途', 'Role')}</dt><dd>${network.role}</dd></dl>${lockedSwitch(sw) ? `<p class="protected-note">◇ ${t('所属 VDS 受保护，不能新增或修改虚拟网络。', 'The parent VDS is protected. Networks cannot be added or modified.')}</p>` : ''}`;
    } else if (drawer === 'nic' && nic) {
      body = `<h3>${t('物理网口', 'Physical NIC')}</h3><dl><dt>${t('所属主机', 'Host')}</dt><dd>${hostName(topology, nic.hostId)}</dd><dt>VDS</dt><dd>${esc(swName(topology, nic.switchId))}</dd><dt>${t('速率', 'Speed')}</dt><dd>${nic.speed} GbE</dd><dt>MTU</dt><dd>${nic.mtu}</dd><dt>VLAN trunk</dt><dd>${nic.vlans.join(', ')}</dd><dt>LLDP</dt><dd>${nic.peerPort} / ${nic.fabric}</dd></dl>`;
      if (sw && lockedSwitch(sw)) body += `<p class="protected-note">◇ ${t('该 VDS 或关联网口受保护，禁止调整。', 'This VDS and its member NICs are protected from changes.')}</p>`;
      else body += `<label for="target">${t('目标 VDS', 'Destination VDS')}</label><select id="target" ${!isEditable() ? 'disabled' : ''}><option value="unassigned">${t('未使用', 'Unused')}</option>${topology.switches.filter(s => !lockedSwitch(s)).map(s => `<option value="${s.id}" ${s.id === nic.switchId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>${button('move', t('更新草稿绑定', 'Update draft binding'), 'primary full-width', !isEditable())}`;
    } else if (sw) {
      body = `${creationFields(view, 'vds', sw)}<h3>${t('基本信息', 'Basic information')}</h3><dl><dt>${t('网桥', 'Bridge')}</dt><dd>${esc(sw.bridge)}</dd><dt>${t('网口绑定模式', 'Bond mode')}</dt><dd>active-backup</dd><dt>MTU</dt><dd>${sw.mtu}</dd><dt>${t('用途', 'Roles')}</dt><dd>${sw.roles.join(', ')}</dd></dl>`;
      if (lockedSwitch(sw)) body += `<p class="protected-note">◇ ${protectedSwitch(sw) ? t('承载管理 / 存储网络，整个 VDS 及其使用网口均锁定。', 'Carries management / storage. The whole VDS and every member NIC stay locked.') : t('本地虚拟网桥，无可验证物理上联。本预览保持只读。', 'Local virtual bridge without verified physical uplinks. Read-only in this preview.')}</p>`;
      else body += button('bind-vds', t('配置主机上联', 'Configure host uplinks'), 'primary full-width', !isEditable(), `data-vds="${sw.id}"`) + button('create-network-here', t('＋ 创建虚拟网络', '＋ Create virtual network'), 'secondary full-width', !isEditable(), `data-vds="${sw.id}"`);
      body += `<h3>${t('关联主机', 'Connected hosts')}</h3><table class="host-bindings"><thead><tr><th>${t('名称', 'Name')}</th><th>${t('活动网口 A', 'Active A')}</th><th>${t('备用网口 B', 'Standby B')}</th></tr></thead><tbody>${topology.hosts.map(host => { const members = topology.nics.filter(n => n.hostId === host.id && n.switchId === sw.id); return `<tr><td>${host.name}</td><td>${members[0]?.name || '—'}</td><td>${members.slice(1).map(n => n.name).join(', ') || '—'}</td></tr>`; }).join('')}</tbody></table>`;
    }
    return `<aside class="details-drawer" aria-label="${t('对象详情', 'Object details')}"><div class="drawer-heading"><h2>${esc(title || '')}</h2>${button('close-drawer', '×', 'icon-button', false, 'aria-label="Close details"')}</div><div class="drawer-tabs">${t('详情', 'Details')} <span>${t('网络', 'Networks')}</span><span>${t('关联主机', 'Connected hosts')}</span></div><div class="drawer-content">${body}<h3>${view.state === 'pending' ? t('待确认变更', 'Pending changes') : t('草稿变更', 'Draft changes')} (${view.plan.operationCount})</h3>${changeList(view)}</div><div class="drawer-footer">${button('review', t('审查全部草稿', 'Review all draft changes'), 'primary full-width', !isEditable() || !view.plan.operationCount)}</div></aside>`;
  }

  function changeList(view) {
    const creations = view.plan.creations.map(item => `<div class="creation-change"><strong>＋ ${item.kind === 'vds' ? t('创建 VDS', 'Create VDS') : t('创建虚拟网络', 'Create virtual network')} · ${esc(item.name)}</strong><span>${item.kind === 'network' ? `${esc(swName(view.topology, item.switchId))} · VLAN ${item.vlan}` : t('新分布式交换机 · 业务用途', 'New distributed switch · workload role')}</span></div>`).join('');
    const relations = view.plan.relations.map(item => `<div><strong>↪ ${esc(item.name)}</strong><span>${esc(swName(view.topology, item.from))} → ${esc(swName(view.topology, item.to))}</span></div>`).join('');
    const changes = view.plan.changes.map(c => `<div><strong>${hostName(view.topology, c.hostId)} / ${view.topology.nics.find(n => n.id === c.nicId).name}</strong><span>${esc(swName(view.topology, c.from))} → ${esc(swName(view.topology, c.to))}</span></div>`).join('');
    return `<div class="change-list">${creations}${relations}${changes}${!view.plan.operationCount ? `<p class="muted">${t('没有未保存的拓扑变更。', 'No unsaved topology changes.')}</p>` : ''}</div>`;
  }

  function transaction(view) {
    if (view.state === 'pending') return `<div><strong>${t('模拟变更已应用 · 等待人工二次确认', 'Mock change applied · awaiting manual confirmation')}</strong><small>${t('应用时开始计时；未确认将恢复模拟快照。请检查业务连通性。', 'The timer starts on apply. Verify connectivity; timeout restores the mock snapshot.')}</small></div><div class="countdown"><b id="seconds">${view.remaining}</b><span>${t('秒后回滚', 'sec to rollback')}</span></div>${button('cancel', t('立即回滚', 'Roll back now'), 'secondary')}${button('confirm', t('连通性正常，确认保留', 'Connectivity checked, keep change'), 'primary')}`;
    const outcomes = { timeout: ['90 秒内未确认，已恢复变更前模拟快照。', 'Not confirmed within 90 seconds. Previous mock snapshot restored.'], confirmed: ['已人工二次确认，保留本页模拟变更。', 'Manually confirmed. Mock changes retained in this page.'], cancelled: ['已人工回滚，恢复变更前模拟快照。', 'Rolled back manually. Previous mock snapshot restored.'] };
    return `<span>${outcomes[view.outcome] ? `✓ ${t(...outcomes[view.outcome])}` : `${t('本地模拟', 'Local mock')} · ${view.plan.operationCount} ${t('项草稿变更', 'draft changes')} · ${t('应用后 90 秒内二次确认，否则回滚', 'Confirm within 90 seconds after apply, or roll back')}`}</span>`;
  }

  function dialog(view) {
    let body = '', actions = '', title = '';
    if (modal === 'review') {
      title = t('保存前风险审查', 'Review before applying');
      body = `<p>${t('以下变更仅作用于模拟数据。真实环境同类操作可能中断业务。', 'These changes affect only mock data. Equivalent live operations may interrupt workloads.')}</p>${changeList(view)}<ul class="risk-list">${view.plan.risks.map(r => `<li class="${r.level}"><span>${r.level === 'blocker' ? '⊘' : '△'}</span><div><strong>${esc([hostName(view.topology, r.hostId), r.switchId ? swName(view.topology, r.switchId) : ''].filter(Boolean).join(' / '))}</strong>${t(...riskText[r.code])}</div></li>`).join('')}</ul><p class="confirmation-note">◷ ${t('点击“应用模拟变更”后立即开始 90 秒确认窗口；未确认或主动回滚将恢复本页快照。', 'Apply mock change starts the 90-second window. Timeout or manual rollback restores the page snapshot.')}</p>${view.plan.blocked ? `<p class="blocking-note">${t('存在阻断风险，请返回修正草稿。', 'Blocking risks found. Return and resolve the draft.')}</p>` : `<label class="ack"><input id="ack" type="checkbox">${t('我了解业务中断风险，将在 90 秒内检查并二次确认。', 'I understand the disruption risk and will check and confirm within 90 seconds.')}</label>`}`;
      actions = button('close-modal', t('返回编辑', 'Back to editing'), 'secondary') + button('apply', t('应用模拟变更', 'Apply mock change'), 'primary', true);
    } else if (modal === 'binding') {
      title = t('配置主机上联', 'Configure host uplinks');
      const sw = view.topology.switches.find(s => s.id === binding.switchId);
      body = `<p><strong>${esc(sw.name)}</strong> · ${esc(sw.bridge)} · active-backup</p><label for="bind-host">${t('主机', 'Host')}</label><select id="bind-host">${view.topology.hosts.map(h => `<option value="${h.id}" ${h.id === binding.hostId ? 'selected' : ''}>${h.name}</option>`).join('')}</select><p class="muted">${t('仅调整所选主机的此 VDS 绑定；其他主机不变。A 为首个模拟活动网口，其余为备用。管理与存储网口不会进入候选清单。', 'Only this VDS on the selected host changes. Other hosts stay unchanged. The first mock member is active A; the rest are standby. Management / storage ports are excluded.')}</p><div class="nic-options">${eligibleNics(view.topology, binding.hostId).map(nic => `<label><input type="checkbox" data-bind-nic="${nic.id}" ${binding.nicIds.includes(nic.id) ? 'checked' : ''}><strong>${nic.name}</strong><span>${nic.speed} GbE · MTU ${nic.mtu}</span><small>${esc(swName(view.topology, nic.switchId))}</small></label>`).join('')}</div><p class="confirmation-note">${t('保存至草稿后仍需审查风险；此步骤不应用、不开始计时。', 'Saving the draft still requires risk review. This step does not apply changes or start the timer.')}</p>`;
      actions = button('close-modal', t('取消', 'Cancel'), 'secondary') + button('save-binding', t('更新上联草稿', 'Update uplink draft'), 'primary');
    } else {
      title = t('有未保存的拓扑草稿', 'Unsaved topology draft');
      body = `<p>${t('离开前请选择如何处理这些修改。', 'Choose how to handle these changes before leaving.')}</p>${changeList(view)}`;
      actions = button('close-modal', t('取消', 'Cancel'), 'secondary') + button('discard-exit', t('丢弃并退出', 'Discard and exit'), 'secondary') + button('review-exit', t('审查、保存并退出', 'Review, save and exit'), 'primary');
    }
    return `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-heading"><h2 id="dialog-title">${title}</h2>${button('close-modal', '×', 'icon-button', false, 'aria-label="Close dialog"')}</div><div class="dialog-body">${body}</div><div class="dialog-actions">${actions}</div></section></div>`;
  }

  function eligibleNics(topology, hostId) {
    return topology.nics.filter(n => n.hostId === hostId && !topology.switches.some(s => s.id === n.switchId && lockedSwitch(s)));
  }
  function openBinding(switchId, hostId, sourceSwitchId = null) {
    if (!isEditable()) throw new Error('SESSION_LOCKED');
    const topology = session.view().draft, target = topology.switches.find(s => s.id === switchId);
    if (!target || lockedSwitch(target) || sourceSwitchId && topology.switches.some(s => s.id === sourceSwitchId && lockedSwitch(s))) throw new Error('PROTECTED_NETWORK');
    binding = { switchId, hostId, nicIds: topology.nics.filter(n => n.hostId === hostId && n.switchId === (sourceSwitchId || switchId)).map(n => n.id) };
    modal = 'binding';
  }
  function act(callback) {
    try { toast = ''; callback(); } catch (error) {
      const messages = { EXISTING_OBJECT: ['只能删除本轮新建且尚未确认的草稿对象。', 'Only new, unconfirmed draft objects can be deleted.'], DELETE_REFERENCED_NETWORK: ['该新建 VDS 关联了已有虚拟网络，请先将已有网络连回其他 VDS，再删除。', 'This new VDS contains an existing network. Reconnect it to another VDS before deleting.'], INVALID_CREATION: ['名称或参数无效，请检查名称长度、VLAN 和 MTU。', 'Invalid name or settings. Check the name, VLAN and MTU.'], DUPLICATE_NAME: ['对象名称已存在，请使用不同的名称。', 'That object name already exists. Choose another name.'], CAPACITY_EXCEEDED: ['达到演示容量上限：最多 20 个 VDS 和 80 个虚拟网络。', 'Demo capacity reached: 20 VDSs and 80 virtual networks.'], INVALID_DROP_TARGET: ['请拖到画布空白处，或将虚拟网络放到可编辑 VDS 上。', 'Drop on empty canvas, or drop a virtual network on an editable VDS.'], PROTECTED_NETWORK: ['管理 / 存储及只读网桥受到保护，禁止直接或间接修改。', 'Management / storage and read-only bridges are protected from direct or indirect changes.'], CROSS_HOST_NIC: ['物理网口不能跨主机绑定。', 'A physical NIC cannot be bound across hosts.'], SESSION_LOCKED: ['请进入编辑模式，或先处理待确认变更。', 'Enter edit mode, or finish the pending transaction.'], NO_PENDING_TRANSACTION: ['确认窗口已结束，过期变更已恢复模拟快照。', 'The window ended. An expired change has been rolled back.'] };
      toast = messages[error.message] ? t(...messages[error.message]) : t('操作被拒绝，请检查对象、草稿或风险条件。', 'Operation rejected. Check the objects, draft and risk conditions.');
    }
    render();
  }

  function click(event) {
    const actionNode = event.target.closest('[data-action]'), action = actionNode?.dataset.action;
    if (Date.now() < suppressNicClickUntil && event.detail > 0) return;
    if (action) {
      if (action === 'palette-create' && event.detail > 0 && Date.now() < suppressPaletteClickUntil) return;
      act(() => {
        const view = session.view();
        if (action === 'enter-edit') { editing = true; sidebarTab = 'components'; }
        if (action === 'sidebar-components') sidebarTab = 'components';
        if (action === 'sidebar-tree') sidebarTab = 'tree';
        if (action === 'palette-create') createFromPalette(actionNode.dataset.palette);
        if (action === 'create-network-here') createFromPalette('network', actionNode.dataset.vds);
        if (action === 'network-info') { selectedNetwork = actionNode.dataset.network; selectedVds = actionNode.dataset.vds; selectedNic = null; drawer = 'network'; }
        if (action === 'update-created') {
          if (!isEditable()) throw new Error('SESSION_LOCKED');
          const kind = actionNode.dataset.kind, id = actionNode.dataset.id;
          const name = root.querySelector('#created-name').value.trim();
          const settings = kind === 'vds' ? { name, mtu: Number(root.querySelector('#created-mtu').value) } : { name, vlan: Number(root.querySelector('#created-vlan').value) };
          session.configureCreated(kind, id, settings);
        }
        if (action === 'exit-edit') { if (session.review().operationCount) modal = 'leave'; else editing = false; }
        if (action === 'discard') session.discard();
        if (action === 'discard-exit') { session.discard(); editing = false; modal = null; }
        if (action === 'review-exit') { exitAfterSave = true; modal = 'review'; }
        if (action === 'review') modal = 'review';
        if (action === 'close-modal') { modal = null; binding = null; exitAfterSave = false; }
        if (action === 'apply') { session.apply(root.querySelector('#ack')?.checked === true); modal = null; }
        if (action === 'confirm') { session.confirm(); if (exitAfterSave) editing = false; exitAfterSave = false; }
        if (action === 'cancel') { session.cancel(); exitAfterSave = false; }
        if (action === 'move') { if (!isEditable()) throw new Error('SESSION_LOCKED'); const value = root.querySelector('#target').value; session.move(selectedNic, value === 'unassigned' ? null : value); }
        if (action === 'collapse') { const key = actionNode.dataset.fold; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); }
        if (action === 'unused') { const id = actionNode.dataset.host; expandedUnused.has(id) ? expandedUnused.delete(id) : expandedUnused.add(id); }
        if (action === 'select-vds') { selectedVds = actionNode.dataset.vds; selectedNic = null; selectedNetwork = null; if (drawer) drawer = 'vds'; }
        if (action === 'vds-info') { selectedVds = actionNode.dataset.vds; selectedNic = null; drawer = 'vds'; }
        if (action === 'bind-vds') openBinding(actionNode.dataset.vds, view.draft.hosts[0].id);
        if (action === 'save-binding') { session.assign(binding.hostId, binding.switchId, binding.nicIds); modal = null; binding = null; }
        if (action === 'close-drawer') drawer = null;
        if (action === 'zoom-in') zoom = Math.min(150, zoom + 25);
        if (action === 'zoom-out') zoom = Math.max(50, zoom - 25);
        if (action === 'fit') { const box = root.querySelector('.viewport'); zoom = [150, 125, 100, 75, 50].find(value => CANVAS_WIDTH * value / 100 <= box.clientWidth && Number(root.querySelector('.scene').dataset.height) * value / 100 <= box.clientHeight) || 50; }
        if (action === 'focus') focusMode = !focusMode;
        if (action === 'refresh-view') { layout.reset(); zoom = 75; collapsed.clear(); expandedUnused.clear(); selectedVds = null; selectedNic = null; drawer = null; resetScroll = true; }
      });
      return;
    }
    const nic = event.target.closest('[data-nic]');
    if (nic) { if (Date.now() < suppressNicClickUntil) return; selectedNic = nic.dataset.nic; selectedVds = session.view().draft.nics.find(n => n.id === selectedNic)?.switchId; drawer = 'nic'; render(); return; }
    const vds = event.target.closest('[data-select-vds]');
    if (vds) { selectedVds = vds.dataset.selectVds; selectedNic = null; render(); }
  }
  function change(event) {
    if (event.target.id === 'language') { doc.documentElement.lang = event.target.value; render(); }
    if (event.target.id === 'show-lines') { showLines = event.target.checked; render(); }
    if (event.target.id === 'ack') root.querySelector('[data-action="apply"]').disabled = !event.target.checked;
    if (event.target.dataset.bindNic) {
      const id = event.target.dataset.bindNic;
      binding.nicIds = event.target.checked ? [...binding.nicIds, id] : binding.nicIds.filter(value => value !== id);
    }
    if (event.target.id === 'bind-host') { const sw = binding.switchId; openBinding(sw, event.target.value); render(); }
  }

  function createFromPalette(kind, switchId = null) {
    if (!isEditable()) throw new Error('SESSION_LOCKED');
    if (kind === 'vds') { selectedVds = session.createVds(); selectedNetwork = null; drawer = 'vds'; revealAnchor = `vds:${selectedVds}`; }
    else if (kind === 'network') { const created = session.createNetwork(switchId); selectedVds = created.switchId; selectedNetwork = created.id; drawer = 'network'; revealAnchor = `network:${selectedNetwork}`; }
    else throw new Error('INVALID_CREATION');
    selectedNic = null; collapsed.delete(`vds:${selectedVds}`);
    toast = t('已自动创建对象草稿，保存前可继续调整。', 'Draft objects created automatically. You can adjust them before saving.');
  }

  const payloadFor = element => element.dataset.palette ? { type: 'palette', kind: element.dataset.palette } : element.dataset.dragNic ? { type: 'nic', id: element.dataset.dragNic } : element.dataset.dragNetwork ? { type: 'network', id: element.dataset.dragNetwork } : element.dataset.dragVds ? { type: 'vds', id: element.dataset.dragVds } : { type: 'node', kind: element.dataset.moveNode, id: element.dataset.objectId };
  function resolveDrop(payload, target, point = null) {
    if (!isEditable()) throw new Error('SESSION_LOCKED');
    const topology = session.view().draft;
    if (payload.type === 'palette') {
      if (payload.kind === 'network' && target.dataset.dropVds) createFromPalette('network', target.dataset.dropVds);
      else if (target.dataset.createCanvas) createFromPalette(payload.kind);
      else throw new Error('INVALID_DROP_TARGET');
      if (point && target.dataset.createCanvas) {
        layout.sync(session.view().draft);
        layout.set(`vds:${selectedVds}`, point.x, point.y);
        if (selectedNetwork) layout.set(`network:${selectedNetwork}`, point.x + 16, point.y + 98);
      }
    } else if (payload.type === 'network') {
      if (!target.dataset.dropVds) throw new Error('INVALID_DROP_TARGET');
      session.reparent(payload.id, target.dataset.dropVds); collapsed.delete(`vds:${target.dataset.dropVds}`);
      if (selectedNetwork === payload.id) selectedVds = target.dataset.dropVds;
      toast = t('已更新虚拟网络所属 VDS 草稿，保存前需要风险审查。', 'Parent VDS updated in the draft. Risk review is required before saving.');
    } else if (payload.type === 'nic') {
      const nic = topology.nics.find(n => n.id === payload.id);
      const hostId = target.dataset.host || target.dataset.dropUnused;
      if (hostId && hostId !== nic.hostId) throw new Error('CROSS_HOST_NIC');
      if (!('dropVds' in target.dataset) && !('dropBond' in target.dataset) && !('dropUnused' in target.dataset)) return;
      session.move(payload.id, target.dataset.dropVds || target.dataset.dropBond || null);
    } else if (payload.type === 'vds') {
      // A VDS drag configures one host; it never swaps another VDS or other hosts.
      if (target.dataset.dropBond) openBinding(payload.id, target.dataset.host, target.dataset.dropBond);
      else if (target.dataset.dropHost) openBinding(payload.id, target.dataset.dropHost);
    }
  }
  const targets = '[data-trash], [data-drop-bond], [data-drop-unused], [data-drop-vds], [data-drop-host], [data-create-canvas]';
  const targetAt = event => event.target.closest(targets);
  function highlightDrop(target, payload) {
    clearHighlight(); if (!target) return;
    const sw = session.view().draft.switches.find(sw => sw.id === (target.dataset.dropVds || target.dataset.dropBond));
    const rejected = sw && lockedSwitch(sw) || payload.type === 'network' && !target.dataset.dropVds || payload.type === 'palette' && !target.dataset.createCanvas && !(payload.kind === 'network' && target.dataset.dropVds);
    hoveredDrop = target; target.classList.add(rejected ? 'drop-rejected' : 'drop-highlight');
  }
  function clearHighlight() { hoveredDrop?.classList.remove('drop-highlight', 'drop-rejected'); hoveredDrop = null; }
  function dragStart(event) {
    const source = event.target.closest('[data-drag-nic], [data-drag-vds], [data-drag-network], [data-palette]');
    if (!source || !isEditable()) { event.preventDefault(); return; }
    pointer = null; drag = payloadFor(source); event.dataTransfer.setData('application/x-rivetin-topology', JSON.stringify(drag)); event.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(event) { if (drag && targetAt(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; highlightDrop(targetAt(event), drag); } }
  function worldPoint(event) {
    const scene = root.querySelector('.scene').getBoundingClientRect(), scale = scene.width ? scene.width / CANVAS_WIDTH : zoom / 100;
    return { x: (event.clientX - scene.left) / scale, y: (event.clientY - scene.top) / scale };
  }
  function drop(event) { const target = targetAt(event), payload = drag; drag = null; clearHighlight(); if (!target || !payload) return; event.preventDefault(); if (payload.type === 'palette') suppressPaletteClickUntil = Date.now() + 300; act(() => resolveDrop(payload, target, worldPoint(event))); }
  function deletable(payload) {
    const view = session.view();
    return payload.type === 'node' && view.state === 'editing' && (payload.kind === 'vds' ? !view.current.switches.some(sw => sw.id === payload.id) : !view.current.switches.some(sw => sw.networks?.some(net => net.id === payload.id)));
  }
  function movable(payload) {
    const topology = session.view().draft;
    const sw = topology.switches.find(sw => payload.kind === 'vds' ? sw.id === payload.id : sw.networks?.some(net => net.id === payload.id));
    return sw && !lockedSwitch(sw);
  }
  function nodeOrigins(payload) {
    const origins = new Map([[`${payload.kind}:${payload.id}`, layout.get(`${payload.kind}:${payload.id}`)]]);
    if (payload.kind === 'vds') for (const net of session.view().draft.switches.find(sw => sw.id === payload.id).networks) origins.set(`network:${net.id}`, layout.get(`network:${net.id}`));
    return origins;
  }
  function moveNode(key, origins, x, y) {
    const origin = origins.get(key);
    layout.set(key, x, y);
    const actual = layout.get(key);
    for (const [child, old] of origins) if (child !== key) layout.set(child, old.x + actual.x - origin.x, old.y + actual.y - origin.y);
  }
  function pointerDown(event) {
    const source = event.target.closest('[data-drag-nic], [data-drag-vds], [data-drag-network], [data-palette], [data-move-node]');
    if (!source || event.button !== 0 || !isEditable()) return;
    if (event.target.closest('[data-action="collapse"]')) return;
    const payload = payloadFor(source);
    if (payload.type === 'node' && !movable(payload)) return;
    const origins = payload.type === 'node' ? nodeOrigins(payload) : new Map();
    pointer = { payload, x: event.clientX, y: event.clientY, active: false, origins, start: worldPoint(event) };
    event.preventDefault();
  }
  function positionNodes() {
    for (const node of root.querySelectorAll('[data-layout-node]')) {
      const point = layout.get(node.dataset.anchor); if (!point) continue;
      node.style.left = `${point.x}px`; node.style.top = `${point.y}px`;
    }
    drawLinks();
  }
  function pointerMove(event) {
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) {
      pointer.active = true;
      const payload = pointer.payload, target = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest(targets);
      if (payload.type === 'node') {
        if (!isEditable()) { clearPointer(); return; }
        const point = worldPoint(event), key = `${payload.kind}:${payload.id}`, origin = pointer.origins.get(key);
        moveNode(key, pointer.origins, origin.x + point.x - pointer.start.x, origin.y + point.y - pointer.start.y);
        positionNodes();
        const trash = root.querySelector('[data-trash]'); trash.hidden = !deletable(payload);
        trash.classList.toggle('trash-active', !trash.hidden && target === trash);
        const label = root.querySelector('.drag-label'); label.hidden = false; label.textContent = payload.kind === 'vds' ? session.view().draft.switches.find(sw => sw.id === payload.id).name : session.view().draft.switches.flatMap(sw => sw.networks || []).find(net => net.id === payload.id).name; label.style.left = `${event.clientX + 16}px`; label.style.top = `${event.clientY + 12}px`;
      } else {
        highlightDrop(target, payload);
        const svg = root.querySelector('.topology-links'), a = pointer.start, b = worldPoint(event);
        svg.querySelector('.connection-preview')?.remove();
        const line = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('class', 'connection-preview'); line.setAttribute('d', `M${a.x} ${a.y} L${b.x} ${b.y}`); svg.append(line);
      }
    }
  }
  function pointerUp(event) {
    const target = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest(targets);
    const saved = pointer; pointer = null; clearHighlight(); hideDragUI(); if (!saved?.active) return;
    if (saved.payload.type === 'palette') suppressPaletteClickUntil = Date.now() + 300;
    suppressNicClickUntil = Date.now() + 300;
    if (saved.payload.type === 'node') {
      act(() => {
        if (!isEditable() || !movable(saved.payload)) throw new Error('SESSION_LOCKED');
        if (target?.dataset.trash && deletable(saved.payload)) {
          // Restore presentation before deletion so a rejected delete is entirely reversible.
          for (const [key, point] of saved.origins) layout.set(key, point.x, point.y);
          session.deleteCreated(saved.payload.kind, saved.payload.id);
          toast = t('已删除本轮新建草稿；新 VDS 的新建子网络及相关上联草稿一并撤销。', 'New draft deleted; new VDS children and related draft uplink assignments are undone.');
        }
      });
    } else if (target && root.contains(target)) act(() => resolveDrop(saved.payload, target, worldPoint(event)));
  }
  function hideDragUI() { root.querySelector('[data-trash]')?.setAttribute('hidden', ''); root.querySelector('.drag-label')?.setAttribute('hidden', ''); root.querySelector('.connection-preview')?.remove(); }
  const clearPointer = () => { if (pointer?.active && pointer.payload.type === 'node') { for (const [key, point] of pointer.origins) layout.set(key, point.x, point.y); positionNodes(); } pointer = null; clearHighlight(); hideDragUI(); };
  const clearDrag = () => { drag = null; clearHighlight(); hideDragUI(); };
  function keydown(event) {
    if (event.key === 'Escape' && pointer?.active) { event.preventDefault(); clearPointer(); return; }
    const node = event.target.closest('[data-move-node]'), steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (node && event.target === node && steps[event.key] && isEditable()) {
      event.preventDefault(); const payload = payloadFor(node); if (!movable(payload)) return;
      const key = `${payload.kind}:${payload.id}`, origins = nodeOrigins(payload), point = origins.get(key), [dx, dy] = steps[event.key], step = event.shiftKey ? 40 : 10;
      moveNode(key, origins, point.x + dx * step, point.y + dy * step); positionNodes(); sizeScene();
    }
    if (event.key === 'Escape') { if (modal) { modal = null; binding = null; exitAfterSave = false; render(); } else if (drawer) { drawer = null; render(); } }
    if (modal && event.key === 'Tab') {
      const items = [...root.querySelectorAll('.dialog button:not(:disabled), .dialog input, .dialog select')], first = items[0], last = items.at(-1), focused = doc.activeElement;
      if (event.shiftKey && (focused === first || focused.classList.contains('dialog'))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (focused === last || focused.classList.contains('dialog'))) { event.preventDefault(); first?.focus(); }
    }
  }
  function beforeUnload(event) { const view = session.view(); if (view.state === 'pending' || assess(view.current, view.draft).operationCount) { event.preventDefault(); event.returnValue = ''; } }
  function updateTime() {
    if (disposed) return;
    const view = session.view();
    if (`${view.state}:${view.outcome}` !== lastTransaction) { if (view.outcome === 'timeout') exitAfterSave = false; render(); }
    else if (view.state === 'pending') { const element = root.querySelector('#seconds'); if (element) element.textContent = view.remaining; }
  }
  const handlers = { click, change, keydown, dragstart: dragStart, dragover: dragOver, drop, dragend: clearDrag, pointerdown: pointerDown };
  for (const [type, handler] of Object.entries(handlers)) root.addEventListener(type, handler);
  doc.addEventListener('pointermove', pointerMove); doc.addEventListener('pointerup', pointerUp); doc.addEventListener('pointercancel', clearPointer); win.addEventListener('blur', clearPointer);
  win.addEventListener('beforeunload', beforeUnload); win.addEventListener('resize', drawLinks); doc.addEventListener('visibilitychange', updateTime);
  const observer = new win.MutationObserver(render); observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
  const timer = win.setInterval(updateTime, 200);
  render();
  return () => {
    if (disposed) return;
    disposed = true; session.dispose(); win.clearInterval(timer); observer.disconnect();
    for (const [type, handler] of Object.entries(handlers)) root.removeEventListener(type, handler);
    doc.removeEventListener('pointermove', pointerMove); doc.removeEventListener('pointerup', pointerUp); doc.removeEventListener('pointercancel', clearPointer); win.removeEventListener('blur', clearPointer);
    win.removeEventListener('beforeunload', beforeUnload); win.removeEventListener('resize', drawLinks); doc.removeEventListener('visibilitychange', updateTime);
    root.replaceChildren(); drag = null; pointer = null; binding = null;
  };
}
