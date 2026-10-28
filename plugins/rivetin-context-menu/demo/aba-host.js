// Public, synthetic host used only by the local lifecycle regression preview.
export function installAbaHost(win, { staleOnReturn = true, retainOnReset = false, moveOldEditor = false, onReset, base = '#/vms/' } = {}) {
  const doc = win.document, listeners = new Set();
  const counts = { freshA: 0, staleB: 0, submit: 0, navigation: 0, reset: 0 };
  const names = { 'vm-a': 'VM Fixture A', 'vm-b': 'VM Fixture B' };
  const table = doc.createElement('div'); table.className = 'ant-table-wrapper';
  table.innerHTML = '<table><thead><tr><th>名称</th><th>状态</th><th>vCPU</th></tr></thead></table><table><tbody>' +
    Object.entries(names).map(([id, name]) => `<tr data-row-key="${id}"><td unique="name">${name}</td><td>运行中（模拟）</td><td>2</td></tr>`).join('') + '</tbody></table>';
  doc.body.append(table);
  let pane = null, wasB = false, retainedEditor = null;
  function editor(owner) {
    counts[owner === 'vm-a' ? 'freshA' : 'staleB']++;
    const modal = doc.createElement('section'); modal.className = 'ant-modal'; modal.setAttribute('role', 'dialog');
    modal.dataset.fixtureOwner = owner; modal.setAttribute('aria-label', '编辑虚拟机');
    modal.innerHTML = '<h2 class="ant-modal-title">编辑虚拟机</h2><p>本地模拟，不执行真实操作。</p><label>vCPU<input value="2" readonly></label><label>内存 GiB<input value="4" readonly></label><button data-cancel>取消</button><button data-submit>保存（模拟）</button>';
    modal.querySelector('[data-cancel]').onclick = () => modal.remove();
    modal.querySelector('[data-submit]').onclick = () => counts.submit++;
    doc.body.append(modal);
  }
  const notify = () => { for (const listener of listeners) listener(); };
  function render(id, edge) {
    if (!id) {
      counts.reset++;
      if (!retainOnReset) { retainedEditor = moveOldEditor ? pane?.querySelector('.edit-icon') : null; pane?.remove(); pane = null; wasB = false; }
      onReset?.({ win, table, select, notify, edge });
      return;
    }
    if (!pane) {
      pane = doc.createElement('aside'); pane.className = 'drawer-content-inner frame';
      pane.innerHTML = '<div class="detail-sidebar-header"><div class="title-wrapper"><span class="header-title"></span></div></div><div class="detail-tabs"><button class="tab-item active" aria-selected="true">详情</button></div><h3>基本信息<span class="extra-action"><button class="edit-icon">编辑</button></span></h3>';
      if (retainedEditor) { pane.querySelector('.edit-icon').replaceWith(retainedEditor); retainedEditor = null; }
      doc.body.append(pane);
    }
    pane.querySelector('.header-title').textContent = names[id];
    const owner = id === 'vm-a' && wasB && staleOnReturn ? 'vm-b' : id;
    pane.querySelector('.edit-icon').onclick = () => editor(owner);
    if (id === 'vm-b') wasB = true;
    for (const row of table.querySelectorAll('tr[data-row-key]')) row.classList.toggle('active-row', row.dataset.rowKey === id);
  }
  function select(id) {
    counts.navigation++;
    const url = new URL(base, win.location.origin + '/');
    const [route, query = ''] = url.hash.split('?'), params = new URLSearchParams(query);
    params.set('sidebar', JSON.stringify({ type: 'vm', view: 'detail', id }));
    win.history.replaceState({}, '', route + '?' + params);
    notify();
    render(id);
  }
  for (const row of table.querySelectorAll('tr[data-row-key]')) row.querySelector('td').onclick = () => select(row.dataset.rowKey);
  const changed = event => {
    const params = new URLSearchParams(win.location.hash.split('?')[1]);
    if (!params.has('sidebar')) render(null, { oldURL: event.oldURL, newURL: event.newURL });
  };
  win.addEventListener('hashchange', changed);
  return { counts, table, select, get pane() { return pane; },
    history: { listen(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    stop() { win.removeEventListener('hashchange', changed); listeners.clear(); table.remove(); pane?.remove(); },
  };
}
