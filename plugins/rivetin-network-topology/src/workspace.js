import { normalizeClusters, normalizeSnapshot, snapshotIsStale } from './snapshot.js';
import { workspaceStyle } from './workspace-style.js';
import { createWorkspaceDraft, draftableSwitch } from './workspace-draft.js';

// Standalone plugin-owned page controller. source is injected; no HTTP, Apollo or mock fallback.
export function mountTopologyWorkspace(root, win, { source, initialClusterId, locale = 'zh-CN', now = () => Date.now(), timeoutMs = 10000, signal: lifecycleSignal, onDirtyChange = () => {} } = {}) {
  if (lifecycleSignal?.aborted) return () => {};
  const doc = win.document, t = (zh, en) => activeLocale.startsWith('en') ? en : zh;
  let activeLocale = locale, draftError = false;
  let stopped = false, generation = 0, controller = null, loading = false, error = false;
  let clusters = [], clusterId = initialClusterId, snapshot = null, layoutEditing = false, selected = null, drag = null, draft = null, draftEditing = false;
  const positions = new Map(), nodes = new Map(), links = [], timers = new Set();
  let previousDirty = false;
  const shell = doc.createElement('section'); shell.className = 'rvt-topology';
  const style = doc.createElement('style'); style.textContent = workspaceStyle; shell.append(style); root.append(shell);
  function el(tag, text = '', className = '') {
    const node = doc.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
  }
  const translations = [];
  function localized(tag, zh, en, className = '') { const node = el(tag, t(zh, en), className); translations.push(() => { node.textContent = t(zh, en); }); return node; }
  const heading = el('header'), title = localized('h1', '网络拓扑', 'Network topology'), controls = el('div', '', 'topo-controls');
  const selectLabel = el('label'), clusterLabel = doc.createTextNode(t('集群 ', 'Cluster ')), select = el('select');
  translations.push(() => { clusterLabel.textContent = t('集群 ', 'Cluster '); }); selectLabel.append(clusterLabel, select);
  const refresh = localized('button', '重新读取', 'Reload'), edit = el('button'), reset = localized('button', '重置布局', 'Reset layout');
  const draftButton = el('button'), discard = localized('button', '丢弃关联草稿', 'Discard relationship draft');
  for (const button of [refresh, edit, reset, draftButton, discard]) button.type = 'button';
  controls.append(selectLabel, refresh, edit, reset, draftButton, discard); heading.append(title, controls); shell.append(heading);
  shell.append(localized('p', '资源关系只读。布局编辑仅改变本页位置，不保存或修改 VDS、虚拟网络、网口绑定或 VLAN；不提供网络应用与回滚。', 'Resource relationships are read-only. Layout editing only moves cards in this page; it does not save or change VDSs, networks, NIC bindings or VLANs. Network apply and rollback are unavailable.', 'topo-notice'));
  const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const meta = el('p', '', 'topo-meta'), warning = el('p', '', 'topo-notice topo-warning');
  const viewport = el('div', '', 'topo-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', t('拓扑画布', 'Topology canvas'));
  const scene = el('div', '', 'topo-scene'), details = el('section', '', 'topo-details'), draftReview = el('section', '', 'topo-details'); details.hidden = true; draftReview.hidden = true;
  viewport.append(scene); shell.append(status, meta, warning, viewport, details, draftReview);
  const footer = el('footer'), footerText = doc.createTextNode(t('社区独立开发，非 SmartX 官方产品 · ', 'Community project, not an official SmartX product · ')); footer.append(footerText);
  translations.push(() => { footerText.textContent = t('社区独立开发，非 SmartX 官方产品 · ', 'Community project, not an official SmartX product · '); });
  for (const [name, href] of [['GitHub', 'https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-network-topology'], ['MIT', 'https://github.com/sephirothchang/rivetin/blob/main/plugins/rivetin-network-topology/LICENSE']]) {
    const link = el('a', name); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; footer.append(link, doc.createTextNode(' '));
  }
  shell.append(footer);
  const transactionCapability = el('section', '', 'topo-notice');
  transactionCapability.setAttribute('aria-label', t('真实网络事务能力', 'Live network transaction capability'));
  transactionCapability.append(localized('h2', '真实网络变更与服务端回滚', 'Live network changes and server-side rollback'),
    localized('p', '当前仅支持读取资源和本地关联草稿。真实变更、二次确认及服务端回滚尚不可用；本页不会发送网络修改。', 'This page currently supports resource reads and local relationship drafts. Live changes, confirmation and server-side rollback are not available; this page will not submit network modifications.'));
  const unavailable = localized('button', '真实网络应用尚不可用', 'Live network apply unavailable'); unavailable.type = 'button'; unavailable.disabled = true; transactionCapability.append(unavailable);
  shell.insertBefore(transactionCapability, viewport);
  const unknown = () => t('未知', 'Unknown');
  function updateStatus() {
    if (stopped) return;
    select.setAttribute('aria-label', t('集群', 'Cluster')); viewport.setAttribute('aria-label', t('拓扑画布', 'Topology canvas'));
    transactionCapability.setAttribute('aria-label', t('真实网络事务能力', 'Live network transaction capability'));
    const dirty = !!draft?.changes().length;
    if (dirty !== previousDirty) { previousDirty = dirty; onDirtyChange(dirty); }
    select.disabled = true; select.title = t('跟随原网络拓扑页的集群上下文', 'Follows the native topology page cluster context'); refresh.disabled = loading || dirty;
    edit.disabled = loading || !snapshot; reset.disabled = loading || !snapshot;
    edit.textContent = layoutEditing ? t('结束布局编辑', 'Finish layout editing') : t('编辑布局', 'Edit layout');
    edit.setAttribute('aria-pressed', String(layoutEditing));
    draftButton.textContent = draftEditing ? t('结束关联草稿编辑', 'Finish relationship draft') : t('编辑关联草稿', 'Edit relationship draft');
    draftButton.setAttribute('aria-pressed', String(draftEditing));
    draftButton.disabled = loading || !snapshot || !snapshot.complete || snapshotIsStale(snapshot, now());
    discard.disabled = !dirty;
    status.setAttribute('role', error ? 'alert' : 'status');
    status.textContent = loading ? t('正在读取资源…', 'Reading resources…') : error ? t('无法读取可信拓扑。请重新读取或联系管理员检查资源接口；未使用演示数据替代。', 'Cannot read a valid topology. Reload or ask an administrator to check the resource service. Demo data has not been substituted.') : snapshot ? t('资源读取完成', 'Resources loaded') : t('暂无可读取的集群', 'No readable clusters');
    meta.textContent = snapshot ? `${snapshot.cluster.name} · ${t('观察时间', 'Observed at')} ${snapshot.observedAt} · ${t('资源版本', 'Revision')} ${snapshot.revision}` : '';
    const warnings = [];
    if (snapshot && !snapshot.complete) warnings.push(t('资源清单不完整，仅展示已返回关系。', 'Inventory is incomplete; only returned relationships are shown.'));
    if (snapshot && snapshotIsStale(snapshot, now())) warnings.push(t('资源观察已超过 60 秒，请重新读取以核对当前状态。', 'Resources were observed over 60 seconds ago. Reload to check the current state.'));
    if (snapshot && !snapshot.peers.length) warnings.push(t('未提供 LLDP 邻居证据，物理交换机关系未知。', 'No LLDP neighbor evidence was supplied; physical switch relationships are unknown.'));
    if (dirty) warnings.push(t('存在本地关联草稿；先丢弃再切换集群或重新读取。虚线仅表示草稿目标，实线保持实际关系。', 'A local relationship draft exists. Discard it before switching clusters or reloading. Dashed draft lines show proposed targets; solid lines retain actual relationships.'));
    warning.textContent = warnings.join(' '); warning.hidden = !warnings.length;
    for (const item of nodes.values()) item.element.dataset.movable = String(layoutEditing && ['vds', 'network'].includes(item.kind));
    for (const handle of scene.querySelectorAll('[data-connection-kind]')) {
      const parent = handle.dataset.connectionKind === 'network' ? snapshot?.switches.find(sw => sw.networks.some(net => net.id === handle.dataset.connectionId))?.id : snapshot?.nics.find(nic => nic.id === handle.dataset.connectionId)?.switchId;
      handle.disabled = !draftEditing || !snapshot?.complete || snapshotIsStale(snapshot, now()) || !draftableSwitch(snapshot, parent);
    }
  }
  function showDetails(item) {
    selected = item.key; details.replaceChildren(el('h2', t('对象详情', 'Object details')));
    const dl = el('dl');
    for (const [key, value] of Object.entries(item.data)) {
      if (Array.isArray(value)) continue;
      dl.append(el('dt', key), el('dd', value === null ? unknown() : String(value)));
    }
    details.append(dl); details.hidden = false;
    if (draftEditing && ['network', 'host'].includes(item.kind)) {
      const resources = item.kind === 'network' ? [{ kind: 'network', id: item.data.id, name: item.data.name }] : snapshot.nics.filter(nic => nic.hostId === item.data.id).map(nic => ({ kind: 'nic', id: nic.id, name: nic.name }));
      details.append(el('p', t('以下仅生成本地差异，不提交网络修改。用途未知、管理/存储或清单不完整时拒绝编辑。', 'The following only creates local differences, without submitting network changes. Unknown purposes, management/storage or incomplete inventory block editing.')));
      for (const resource of resources) {
        const row = el('div'), target = el('select'); target.setAttribute('aria-label', `${resource.name} ${t('草稿目标 VDS', 'draft target VDS')}`);
        for (const sw of snapshot.switches.filter(sw => draftableSwitch(snapshot, sw.id))) { const option = el('option', sw.name); option.value = sw.id; target.append(option); }
        const propose = el('button', t('加入关联草稿', 'Add relationship draft')); propose.type = 'button'; propose.disabled = !target.options.length;
        propose.addEventListener('click', () => proposeChange(resource.kind, resource.id, target.value));
        row.append(el('span', `${resource.name} `), target, propose); details.append(row);
      }
    }
    for (const node of nodes.values()) node.element.setAttribute('aria-pressed', String(node.key === selected));
  }
  function position(item) {
    const point = positions.get(item.key); item.element.style.left = `${point.x}px`; item.element.style.top = `${point.y}px`;
  }
  function drawLinks() {
    for (const link of links) {
      const a = nodes.get(link.from), b = nodes.get(link.to); if (!a || !b) continue;
      const ap = positions.get(a.key), bp = positions.get(b.key), x1 = ap.x + 262, y1 = ap.y + 32, x2 = bp.x, y2 = bp.y + 32;
      const middle = (x1 + x2) / 2; link.element.setAttribute('d', `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`);
    }
    const svg = scene.querySelector('svg'); if (!svg) return;
    svg.querySelector('[data-draft-links]')?.remove();
    const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g'); group.dataset.draftLinks = 'true';
    for (const change of draft?.changes() || []) {
      const from = positions.get(change.kind === 'network' ? `network:${change.id}` : `host:${change.hostId}`), to = positions.get(`vds:${change.to}`);
      if (!from || !to) continue;
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.dataset.kind = 'draft'; path.setAttribute('d', `M${from.x},${from.y + 40} L${to.x + 262},${to.y + 40}`); group.append(path);
    }
    svg.append(group);
  }
  function renderDraftReview(message = '') {
    draftError = !!message;
    const changes = draft?.changes() || [];
    draftReview.replaceChildren(el('h2', t('本地关联草稿 / 差异审查', 'Local relationship draft / review')));
    if (message) { const alert = el('p', message); alert.setAttribute('role', 'alert'); draftReview.append(alert); }
    for (const change of changes) {
      const from = snapshot.switches.find(sw => sw.id === change.from)?.name || t('未关联', 'Unassigned'), to = snapshot.switches.find(sw => sw.id === change.to)?.name;
      draftReview.append(el('p', `${change.kind} ${change.id}${change.hostId ? ` · ${t('主机', 'Host')} ${change.hostId}` : ''}: ${from} → ${to}`));
      draftReview.append(el('small', change.kind === 'network'
        ? t('仅本地关联意图；当前真实虚拟网络迁移未开放。', 'Local relationship intent only; live virtual-network migration is not available.')
        : t('仅本地网口意图；真实变更须经过服务端完整计划与回滚条件核验。', 'Local NIC intent only; live changes require a complete server plan and verified rollback conditions.')));
    }
    draftReview.append(el('p', t('尚未应用。未验证真实权限、VLAN/MTU覆盖、连通性或业务依赖；本页不提供真实应用、模拟应用或90秒回滚。', 'Not applied. Live permissions, VLAN/MTU coverage, connectivity and workload dependencies have not been checked. This page offers no live apply, simulated apply or 90-second rollback.')));
    draftReview.hidden = !changes.length && !message; drawLinks(); updateStatus();
  }
  function proposeChange(kind, id, target) {
    try { if (!draftEditing || !draft) throw new Error(); if (kind === 'network') draft.reparent(id, target); else if (kind === 'nic') draft.bindNic(id, target); else throw new Error(); renderDraftReview(); }
    catch { renderDraftReview(draftErrorMessage()); }
  }
  function draftErrorMessage() { return t('拒绝生成草稿：请检查清单完整性、新鲜度及来源/目标用途，管理、存储、混合用途或未知对象保持锁定。', 'Draft rejected. Check inventory completeness, freshness and source/target purposes. Management, storage, mixed-purpose and unknown objects stay locked.'); }
  function renderScene() {
    scene.replaceChildren(); nodes.clear(); links.length = 0; details.hidden = true; selected = null;
    if (!snapshot) { scene.style.height = '420px'; return; }
    let maximum = 640;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('topo-links'); svg.setAttribute('width', '1540'); svg.setAttribute('aria-hidden', 'true'); scene.append(svg);
    for (const [label, x] of [[t('虚拟机', 'Virtual machines'), 20], [t('分布式交换机 / 虚拟网络', 'VDS / Virtual networks'), 385], [t('主机 / 物理网口', 'Hosts / Physical NICs'), 760], [t('物理交换机', 'Physical switches'), 1140]]) {
      const column = el('div', label, 'topo-column'); column.style.left = `${x}px`; scene.append(column);
    }
    function card(kind, id, name, data, x, y, summary = '') {
      const key = `${kind}:${id}`, element = el('article', '', 'topo-node'); element.tabIndex = 0; element.dataset.key = key; element.dataset.kind = kind; element.setAttribute('aria-label', name); element.setAttribute('aria-pressed', 'false');
      element.append(el('h3', name)); if (summary) element.append(el('small', summary));
      if (['network', 'vds'].includes(kind)) element.dataset.dropVds = kind === 'vds' ? id : '';
      if (kind === 'network') {
        const handle = el('button', t('拖动关联连接点', 'Drag relationship port')); handle.type = 'button'; handle.draggable = true; handle.dataset.connectionKind = 'network'; handle.dataset.connectionId = id; element.append(handle);
      }
      const item = { key, kind, data, element }; nodes.set(key, item);
      if (!positions.has(key)) positions.set(key, { x, y }); scene.append(element); position(item); maximum = Math.max(maximum, positions.get(key).y + 260); return element;
    }
    let y = 66;
    for (const sw of snapshot.switches) {
      card('vds', sw.id, sw.name, { id: sw.id, name: sw.name, mtu: sw.mtu, purpose: sw.purpose }, 385, y, `MTU ${sw.mtu ?? unknown()} · ${sw.purpose || unknown()}`); y += 92;
      for (const net of sw.networks) {
        card('network', net.id, net.name, { ...net, vdsId: sw.id }, 401, y, `VLAN ${net.vlan ?? unknown()}`);
        links.push({ from: `vds:${sw.id}`, to: `network:${net.id}`, kind: 'network' });
        const group = snapshot.vmGroups.find(item => item.networkId === net.id);
        if (group) { card('vm', net.id, `${group.count ?? unknown()} ${t('台虚拟机', 'VMs')}`, { networkId: net.id, count: group.count }, 20, y, net.name); links.push({ from: `vm:${net.id}`, to: `network:${net.id}`, kind: 'vm' }); }
        y += 90;
      }
      y += 24;
    }
    y = 66;
    for (const host of snapshot.hosts) {
      const element = card('host', host.id, host.name, host, 760, y), nics = snapshot.nics.filter(nic => nic.hostId === host.id);
      for (const nic of nics) {
        const row = el('div', '', 'topo-nic'); row.append(el('strong', nic.name));
        const sw = snapshot.switches.find(item => item.id === nic.switchId);
        row.append(el('small', `${sw?.name || t('未关联 VDS', 'No associated VDS')} · ${nic.link} · ${nic.speedMbps === null ? unknown() : `${nic.speedMbps} Mbps`}`));
        row.append(el('small', `${t('网桥 / bond', 'Bridge / bond')} ${nic.bond ?? unknown()} · ${nic.bondMode ?? unknown()}`)); element.append(row);
        const handle = el('button', t('拖动网口关联', 'Drag NIC relationship')); handle.type = 'button'; handle.draggable = true; handle.dataset.connectionKind = 'nic'; handle.dataset.connectionId = nic.id; row.append(handle);
        if (nic.peerId) links.push({ from: `host:${host.id}`, to: `peer:${nic.peerId}`, kind: 'lldp' });
      }
      for (const switchId of new Set(nics.map(nic => nic.switchId).filter(Boolean))) links.push({ from: `vds:${switchId}`, to: `host:${host.id}`, kind: 'uplink' });
      y += 86 + nics.length * 78; maximum = Math.max(maximum, y);
    }
    snapshot.peers.forEach((peer, index) => card('peer', peer.id, peer.name, peer, 1140, 66 + index * 100));
    for (const key of positions.keys()) if (!nodes.has(key)) positions.delete(key);
    for (const link of links) {
      link.element = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); link.element.dataset.kind = link.kind; svg.append(link.element);
    }
    scene.style.height = `${maximum}px`; svg.setAttribute('height', String(maximum)); drawLinks(); updateStatus();
  }
  async function request(call, signal) {
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('TOPOLOGY_READ_CANCELLED'));
        signal.addEventListener('abort', onAbort, { once: true });
        const finish = (callback, value) => { signal.removeEventListener('abort', onAbort); callback(value); };
        if (signal.aborted) { finish(reject, new Error('TOPOLOGY_READ_CANCELLED')); return; }
        timer = win.setTimeout(() => { if (controller?.signal === signal) controller.abort(); finish(reject, new Error('TOPOLOGY_READ_TIMEOUT')); }, timeoutMs); timers.add(timer);
        Promise.resolve().then(() => { if (signal.aborted) throw new Error('TOPOLOGY_READ_CANCELLED'); return call(signal); }).then(value => finish(resolve, value), error => finish(reject, error));
      });
    } finally { win.clearTimeout(timer); timers.delete(timer); }
  }
  async function load(relist = false) {
    if (stopped) return;
    const ticket = ++generation; controller?.abort(); controller = new win.AbortController(); const signal = controller.signal;
    loading = true; error = false; snapshot = null; layoutEditing = false; drag = null; draft = null; draftEditing = false; draftReview.hidden = true; renderScene(); updateStatus();
    try {
      if (typeof source?.listClusters !== 'function' || typeof source?.read !== 'function') throw new Error('TOPOLOGY_SOURCE_UNAVAILABLE');
      if (typeof clusterId !== 'string' || !clusterId.trim()) throw new Error('TOPOLOGY_CONTEXT_INVALID');
      if (relist) {
        const next = normalizeClusters(await request(signal => source.listClusters({ signal }), signal));
        if (stopped || ticket !== generation) return;
        clusters = next; if (!clusters.some(item => item.id === clusterId)) throw new Error('TOPOLOGY_CONTEXT_NOT_ALLOWED');
        select.replaceChildren(...clusters.map(item => { const option = el('option', item.name); option.value = item.id; return option; })); select.value = clusterId;
      }
      if (clusterId) {
        const value = await request(signal => source.read({ clusterId, signal }), signal);
        if (stopped || ticket !== generation) return;
        snapshot = normalizeSnapshot(value, clusterId, now());
        draft = createWorkspaceDraft(snapshot, now);
      }
    } catch { if (stopped || ticket !== generation) return; error = true; snapshot = null; }
    finally { if (!stopped && ticket === generation) { loading = false; renderScene(); updateStatus(); } }
  }
  function nodeFrom(event) { const element = event.target.closest?.('[data-key]'); return element && nodes.get(element.dataset.key); }
  function move(item, dx, dy, origin) {
    const next = { x: Math.max(300, Math.min(700, origin.x + dx)), y: Math.max(60, Math.min(parseFloat(scene.style.height) - 90, origin.y + dy)) };
    const current = positions.get(item.key), delta = { x: next.x - current.x, y: next.y - current.y };
    positions.set(item.key, next); position(item);
    if (item.kind === 'vds') for (const net of snapshot.switches.find(sw => `vds:${sw.id}` === item.key).networks) {
      const child = nodes.get(`network:${net.id}`), point = positions.get(child.key); positions.set(child.key, { x: point.x + delta.x, y: point.y + delta.y }); position(child);
    }
    drawLinks();
  }
  function onClick(event) { const item = nodeFrom(event); if (item) showDetails(item); }
  function onPointerDown(event) {
    const item = nodeFrom(event); if (!item || event.target.closest('button') || !layoutEditing || !['vds', 'network'].includes(item.kind) || event.button !== 0) return;
    drag = { item, x: event.clientX, y: event.clientY, origins: new Map([...positions].map(([key, value]) => [key, { ...value }])) };
    item.element.setPointerCapture?.(event.pointerId); event.preventDefault();
  }
  function onPointerMove(event) {
    if (!drag) return;
    move(drag.item, event.clientX - drag.x, event.clientY - drag.y, drag.origins.get(drag.item.key));
  }
  function cancelDrag() { if (!drag) return; for (const [key, point] of drag.origins) { positions.set(key, point); const item = nodes.get(key); if (item) position(item); } drag = null; drawLinks(); }
  function onKeyDown(event) {
    if (event.key === 'Escape') { cancelDrag(); return; }
    const item = nodeFrom(event), directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!layoutEditing || !item || !['vds', 'network'].includes(item.kind) || !directions[event.key]) return;
    event.preventDefault(); const [x, y] = directions[event.key], step = event.shiftKey ? 40 : 10; move(item, x * step, y * step, positions.get(item.key));
  }
  function onChange() { select.value = clusterId; }
  function onRefresh() { if (!draft?.changes().length) void load(true); }
  function onEdit() { cancelDrag(); layoutEditing = !layoutEditing; draftEditing = false; updateStatus(); }
  function onReset() { cancelDrag(); positions.clear(); renderScene(); }
  function onPointerUp() { drag = null; }
  let connection = null;
  function onDragStart(event) {
    const handle = event.target.closest?.('[data-connection-kind]'); if (!draftEditing || !handle) { event.preventDefault(); return; }
    connection = { kind: handle.dataset.connectionKind, id: handle.dataset.connectionId }; event.dataTransfer?.setData('text/plain', 'rivetin-topology-local-draft');
  }
  function onDragOver(event) { if (connection && event.target.closest?.('[data-kind=vds]')) event.preventDefault(); }
  function onDrop(event) { const target = event.target.closest?.('[data-kind=vds]'); if (connection && target) { event.preventDefault(); proposeChange(connection.kind, connection.id, target.dataset.dropVds); } connection = null; }
  function onDragEnd() { connection = null; }
  function onDraft() { cancelDrag(); draftEditing = !draftEditing; layoutEditing = false; updateStatus(); if (selected && nodes.has(selected)) showDetails(nodes.get(selected)); }
  function onDiscard() { draft?.clear(); connection = null; renderDraftReview(); }
  function onBeforeUnload(event) { if (draft?.changes().length) { event.preventDefault(); event.returnValue = ''; } }
  select.addEventListener('change', onChange); refresh.addEventListener('click', onRefresh); edit.addEventListener('click', onEdit); reset.addEventListener('click', onReset);
  scene.addEventListener('click', onClick); scene.addEventListener('pointerdown', onPointerDown); scene.addEventListener('keydown', onKeyDown);
  win.addEventListener('pointermove', onPointerMove); win.addEventListener('pointerup', onPointerUp); win.addEventListener('pointercancel', cancelDrag);
  draftButton.addEventListener('click', onDraft); discard.addEventListener('click', onDiscard);
  scene.addEventListener('dragstart', onDragStart); scene.addEventListener('dragover', onDragOver); scene.addEventListener('drop', onDrop); scene.addEventListener('dragend', onDragEnd); win.addEventListener('beforeunload', onBeforeUnload);
  const freshnessTimer = win.setInterval(updateStatus, 10000);
  lifecycleSignal?.addEventListener('abort', dispose, { once: true });
  void load(true);
  function dispose() {
    if (stopped) return; stopped = true; generation++; controller?.abort();
    for (const timer of timers) win.clearTimeout(timer); timers.clear(); win.clearInterval(freshnessTimer);
    select.removeEventListener('change', onChange); refresh.removeEventListener('click', onRefresh); edit.removeEventListener('click', onEdit); reset.removeEventListener('click', onReset);
    scene.removeEventListener('click', onClick); scene.removeEventListener('pointerdown', onPointerDown); scene.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('pointermove', onPointerMove); win.removeEventListener('pointerup', onPointerUp); win.removeEventListener('pointercancel', cancelDrag);
    draftButton.removeEventListener('click', onDraft); discard.removeEventListener('click', onDiscard);
    scene.removeEventListener('dragstart', onDragStart); scene.removeEventListener('dragover', onDragOver); scene.removeEventListener('drop', onDrop); scene.removeEventListener('dragend', onDragEnd); win.removeEventListener('beforeunload', onBeforeUnload);
    shell.remove(); nodes.clear(); positions.clear(); translations.length = 0; drag = null;
    lifecycleSignal?.removeEventListener('abort', dispose);
    if (previousDirty) { previousDirty = false; onDirtyChange(false); }
  }
  dispose.updateLocale = nextLocale => {
    if (stopped || nextLocale === activeLocale) return;
    cancelDrag(); const selectedKey = selected, selectionValues = [...details.querySelectorAll('select')].map(node => node.value);
    const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop }, reviewError = draftError;
    activeLocale = nextLocale;
    for (const translate of translations) translate();
    renderScene(); renderDraftReview(reviewError ? draftErrorMessage() : '');
    if (selectedKey && nodes.has(selectedKey)) { showDetails(nodes.get(selectedKey)); [...details.querySelectorAll('select')].forEach((node, index) => { if (selectionValues[index] !== undefined) node.value = selectionValues[index]; }); }
    viewport.scrollLeft = scroll.left; viewport.scrollTop = scroll.top;
    updateStatus();
  };
  return dispose;
}
