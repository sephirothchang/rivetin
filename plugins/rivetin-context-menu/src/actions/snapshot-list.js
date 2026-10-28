const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// A list is informational. Mutation controls remain in their own confirmation
// forms and cannot be attached to an arbitrary snapshot name or table row.
export function renderSnapshotList(doc, snapshot, locale = 'zh-CN') {
  const en = locale === 'en-US', root = doc.createElement('div');
  root.setAttribute('data-rivetin-snapshots', '');
  const items = snapshot?.snapshots;
  if (!id(snapshot?.id) || !Array.isArray(items) || items.length > 5000 ||
      items.some(item => !id(item?.id) || item.vm?.id !== snapshot.id) || new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('SNAPSHOT_LIST_UNVERIFIED');
  }
  if (!items.length) {
    const empty = doc.createElement('p'); empty.textContent = en ? 'This VM has no snapshots.' : '此虚拟机暂无快照。'; root.append(empty); return root;
  }
  const table = doc.createElement('table'); table.style.width = '100%'; table.style.textAlign = 'left';
  const head = doc.createElement('thead'), headings = doc.createElement('tr');
  for (const label of en ? ['Name', 'Snapshot ID', 'State'] : ['名称', '快照 ID', '状态']) {
    const cell = doc.createElement('th'); cell.scope = 'col'; cell.textContent = label; headings.append(cell);
  }
  head.append(headings); table.append(head);
  const body = doc.createElement('tbody');
  for (const item of items) {
    const row = doc.createElement('tr');
    for (const label of [typeof item.name === 'string' ? item.name.slice(0, 256) : item.id, item.id,
      item.entityAsyncStatus ? (en ? 'Changing' : '变更中') : (en ? 'Ready' : '就绪')]) {
      const cell = doc.createElement('td'); cell.textContent = label; cell.style.overflowWrap = 'anywhere'; row.append(cell);
    }
    body.append(row);
  }
  table.append(body); root.append(table); return root;
}
