import { identifyResource, sameResource, isVisible } from './resources.js';

const moreLabels = new Set(['更多', '更多操作', '更多选项', 'more', 'more actions', 'more options', '⋯', '…', '...']);
const disabledSelector = '[disabled],[aria-disabled="true"],[inert],.ant-dropdown-disabled,.ant-btn-disabled,.is-disabled,.ant-btn-loading';
const ownCell = row => [...row.querySelectorAll('td[unique="name"],td[unique="path"],td.cell_name,td.cell_path')].find(cell => cell.closest('tr') === row);
function isMoreTrigger(node, win, includeDisabled = false) {
  if (!isVisible(node, win) || !includeDisabled && node.closest(disabledSelector)) return false;
  const labels = [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent]
    .map(value => (value || '').trim().toLowerCase()).filter(Boolean);
  // A dropdown class alone also appears on business buttons. Require menu semantics,
  // and reject conflicting text even if a more icon happens to be present.
  if (labels.length) return labels.every(label => moreLabels.has(label));
  return Boolean(node.querySelector('[data-testid="MoreEllipsis316BoldBlueIcon"],img[alt="1-more-ellipsis-3-16-bold-blue"]'));
}

export function nativeRowMenuReason(resource, win) {
  const rows = [...win.document.querySelectorAll('tr[data-row-key]')].filter(row => row.getAttribute('data-row-key') === resource?.id && isVisible(row, win));
  if (rows.length !== 1) return 'source-changed';
  const row = rows[0], cell = ownCell(row);
  if (!cell || !sameResource(identifyResource(cell, win), resource)) return 'source-changed';
  const triggers = [...row.querySelectorAll('td[unique="_action_"] .menu-button.ant-dropdown-trigger')].filter(node => node.closest('tr') === row && isMoreTrigger(node, win, true));
  return triggers.length > 1 ? 'trigger-ambiguous' : triggers.length === 1 && !isMoreTrigger(triggers[0], win) ? 'entry-disabled' : 'trigger-missing';
}

// Delegate to the exact native row trigger; popup ownership stays with CloudTower.
// No global popup discovery, handler copying, positioning or lifecycle interception.
export function nativeRowMenuTrigger(resource, win) {
  if (!resource?.id || resource.internal) return false;
  const rows = [...win.document.querySelectorAll('tr[data-row-key]')]
    .filter(row => row.getAttribute('data-row-key') === resource.id && isVisible(row, win));
  if (rows.length !== 1) return false;
  const row = rows[0], cell = ownCell(row);
  if (!cell || !sameResource(identifyResource(cell, win), resource)) return false;
  const triggers = [...row.querySelectorAll('td[unique="_action_"] .menu-button.ant-dropdown-trigger')]
    .filter(node => node.closest('tr') === row && isMoreTrigger(node, win, true));
  if (triggers.length !== 1 || !isMoreTrigger(triggers[0], win)) return false;
  return triggers[0];
}

export function openNativeRowMenu(resource, win) {
  const trigger = nativeRowMenuTrigger(resource, win);
  if (!trigger) return false;
  trigger.click();
  return true;
}
