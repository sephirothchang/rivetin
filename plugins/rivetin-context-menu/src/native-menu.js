import { identifyResource, sameResource, isVisible } from './resources.js';

const moreLabels = new Set(['更多', '更多操作', '更多选项', 'more', 'more actions', 'more options', '⋯', '…', '...']);
function isMoreTrigger(node, win) {
  if (!isVisible(node, win) || node.closest('[disabled],[aria-disabled="true"],[inert],.ant-dropdown-disabled,.ant-btn-disabled')) return false;
  const labels = [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent]
    .map(value => (value || '').trim().toLowerCase()).filter(Boolean);
  // A dropdown class alone also appears on business buttons. Require menu semantics,
  // and reject conflicting text even if a more icon happens to be present.
  if (labels.length) return labels.every(label => moreLabels.has(label));
  return Boolean(node.querySelector('[data-testid="MoreEllipsis316BoldBlueIcon"]'));
}

// Delegate to the exact native row trigger; popup ownership stays with CloudTower.
// No global popup discovery, handler copying, positioning or lifecycle interception.
export function openNativeRowMenu(resource, win) {
  if (!resource?.id || resource.internal) return false;
  const rows = [...win.document.querySelectorAll('tr[data-row-key]')]
    .filter(row => row.getAttribute('data-row-key') === resource.id && isVisible(row, win));
  if (rows.length !== 1) return false;
  const row = rows[0], cell = row.querySelector('td[unique="name"],td[unique="path"],td.cell_name,td.cell_path');
  if (!cell || !sameResource(identifyResource(cell, win), resource)) return false;
  const triggers = [...row.querySelectorAll('td[unique="_action_"] .menu-button.ant-dropdown-trigger')]
    .filter(node => isMoreTrigger(node, win));
  if (triggers.length !== 1) return false;
  triggers[0].click();
  return true;
}
