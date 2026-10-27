import { validId } from './provider.js';
// Match only observed sidebar structures; build acceptance is a separate gate.
// The provider still verifies disk -> host -> physical device before data is rendered.
export function routeDisk(win) {
  try {
    const [path, query = ''] = win.location.hash.slice(1).split('?');
    if (!/^\/(clusters|hosts)\/[A-Za-z0-9_-]{1,128}\/?$/.test(path)) return null;
    const params = new URLSearchParams(query), sidebar = JSON.parse(params.get('sidebar'));
    if (JSON.parse(params.get('view')) !== 'disks' || sidebar?.type !== 'disk' || !validId(sidebar.id)) return null;
    return sidebar.id;
  } catch { return null; }
}
export function findDiskDetail(win) {
  const diskId = routeDisk(win); if (!diskId) return null;
  const roots = [...win.document.querySelectorAll('.drawer-content-inner')].filter(root => !root.closest('[hidden],[aria-hidden="true"]'));
  if (roots.length !== 1) return null;
  const root = roots[0], tabs = root.querySelector('.detail-tabs');
  if (!tabs || root.querySelectorAll('.detail-tabs').length !== 1) return null;
  const header = tabs.closest('.detail-sidebar-header');
  let content;
  if (header) {
    // Tower 4.9: the tab content follows the header and its border, not the tabs.
    const parent = header.parentElement, border = header.nextElementSibling;
    content = border?.nextElementSibling;
    if (!parent || !root.contains(parent) || tabs.parentElement !== header || root.querySelectorAll('.detail-sidebar-header').length !== 1 ||
        !border?.matches('.tab-border-bottom') || !content?.matches('.tab-content') || root.querySelectorAll('.tab-content').length !== 1) return null;
    const siblings = [...parent.children].filter(node => !node.matches('#pk-smart-info-panel[data-pk-smart-panel]'));
    if (siblings.length !== 3 || siblings[0] !== header || siblings[1] !== border || siblings[2] !== content) return null;
  } else {
    content = tabs.nextElementSibling;
    if (root.querySelector('.detail-sidebar-header') || !content?.matches('.detail-tab-content,.detail-content')) return null;
  }
  const rows = [...win.document.querySelectorAll('tr[data-row-key]')].filter(row => row.getAttribute('data-row-key') === diskId);
  const cell = rows.length === 1 ? rows[0].querySelector('td[unique="path"],td.cell_path') : null;
  const title = root.querySelector('.title-wrapper .header-title');
  const path = cell?.textContent.trim();
  if (!path || title?.textContent.trim() !== path || !/^\/dev\/[A-Za-z0-9/_-]{1,100}$/.test(path)) return null;
  return { diskId, path, root, tabs, content };
}
