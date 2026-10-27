import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openNativeRowMenu } from '../src/native-menu.js';
import { identifyResource } from '../src/resources.js';

const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture({ second = false } = {}) {
  const dom = new JSDOM('<table><tbody></tbody></table><div id="outside">Outside</div>', {
    url: 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22',
  });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden],.ant-dropdown-hidden') || this.style.display === 'none' ? [] : [{ width: 180, height: 100 }];
  };
  const counts = { row: 0, trigger: [], native: [] }, rows = new Map(), popups = new Map();
  function addRow(id) {
    const row = doc.createElement('tr'); row.dataset.rowKey = id;
    row.innerHTML = '<td unique="name"><span class="name" tabindex="0">Same VM name</span></td><td unique="_action_"><div class="menu-button ant-dropdown-trigger" role="button" tabindex="0">More</div></td>';
    row.onclick = () => { counts.row++; };
    const popup = doc.createElement('div'); popup.className = 'ant-dropdown ant-dropdown-hidden'; popup.hidden = true;
    popup.style.cssText = 'position: absolute; left: 30px; top: 40px; min-width: 120px;';
    popup.innerHTML = '<ul role="menu"><li role="menuitem" class="ant-dropdown-menu-item action">Edit</li><li role="menuitem" aria-disabled="true" class="ant-dropdown-menu-item ant-dropdown-menu-item-disabled disabled">Delete</li></ul>';
    popup.querySelector('.action').onclick = () => { counts.native.push(id); };
    popup.querySelector('.disabled').onclick = event => { event.preventDefault(); };
    const trigger = row.querySelector('.ant-dropdown-trigger');
    trigger.onclick = event => {
      event.stopPropagation(); counts.trigger.push(id);
      popup.hidden = !popup.hidden; popup.classList.toggle('ant-dropdown-hidden', popup.hidden);
    };
    doc.querySelector('tbody').append(row); doc.body.append(popup); rows.set(id, row); popups.set(id, popup);
  }
  addRow('vm-a'); if (second) addRow('vm-b');
  const resource = id => identifyResource(rows.get(id).querySelector('.name'), win);
  const visible = popup => !popup.hidden && !popup.classList.contains('ant-dropdown-hidden') && popup.style.display !== 'none';
  return { win, doc, counts, rows, popups, resource, visible, dispose: () => dom.window.close() };
}

test('native row trigger opens without selecting a row, navigating or executing a business action', () => {
  const f = fixture();
  try {
    const before = f.win.location.href, resource = f.resource('vm-a'), keys = Object.keys(resource);
    assert.equal(openNativeRowMenu(resource, f.win), true);
    assert.equal(f.visible(f.popups.get('vm-a')), true); assert.deepEqual(f.counts.trigger, ['vm-a']);
    assert.equal(f.counts.row, 0); assert.deepEqual(f.counts.native, []); assert.equal(f.win.location.href, before);
    assert.equal(f.doc.querySelector('.drawer-content-inner,.frame'), null); assert.deepEqual(Object.keys(resource), keys);
    f.popups.get('vm-a').querySelector('.action').click(); assert.deepEqual(f.counts.native, ['vm-a']); assert.equal(f.counts.row, 0);
  } finally { f.dispose(); }
});

test('same-name resources select their own strong row ID', () => {
  const f = fixture({ second: true });
  try {
    assert.equal(openNativeRowMenu(f.resource('vm-b'), f.win), true);
    assert.deepEqual(f.counts.trigger, ['vm-b']); assert.equal(f.visible(f.popups.get('vm-a')), false);
    f.popups.get('vm-b').querySelector('.action').click(); assert.deepEqual(f.counts.native, ['vm-b']); assert.equal(f.counts.row, 0);
  } finally { f.dispose(); }
});

for (const kind of ['missing trigger', 'duplicate trigger', 'duplicate matching row', 'hidden row', 'hidden trigger', 'wrong action column']) test(`${kind} is rejected without clicking`, () => {
  const f = fixture();
  try {
    const resource = f.resource('vm-a'), row = f.rows.get('vm-a'), trigger = row.querySelector('.ant-dropdown-trigger');
    if (kind === 'missing trigger') trigger.remove();
    if (kind === 'duplicate trigger') row.querySelector('td[unique="_action_"]').append(trigger.cloneNode(true));
    if (kind === 'duplicate matching row') f.doc.querySelector('tbody').append(row.cloneNode(true));
    if (kind === 'hidden row') row.hidden = true;
    if (kind === 'hidden trigger') trigger.hidden = true;
    if (kind === 'wrong action column') row.querySelector('td[unique="_action_"]').setAttribute('unique', 'unrelated');
    assert.equal(openNativeRowMenu(resource, f.win), false); assert.deepEqual(f.counts.trigger, []); assert.equal(f.counts.row, 0); assert.deepEqual(f.counts.native, []);
  } finally { f.dispose(); }
});

test('a mismatched resource type cannot borrow a row with the same ID', () => {
  const f = fixture();
  try {
    assert.equal(openNativeRowMenu({ ...f.resource('vm-a'), type: 'host' }, f.win), false);
    assert.deepEqual(f.counts.trigger, []); assert.equal(f.counts.row, 0);
  } finally { f.dispose(); }
});

test('a hidden duplicate does not make a single visible row ambiguous', () => {
  const f = fixture();
  try {
    const duplicate = f.rows.get('vm-a').cloneNode(true); duplicate.hidden = true; f.doc.querySelector('tbody').append(duplicate);
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), true); assert.deepEqual(f.counts.trigger, ['vm-a']);
  } finally { f.dispose(); }
});

test('both native disabled button and aria-disabled trigger are rejected', () => {
  for (const mode of ['disabled', 'aria-disabled']) {
    const f = fixture();
    try {
      const trigger = f.rows.get('vm-a').querySelector('.ant-dropdown-trigger');
      if (mode === 'aria-disabled') trigger.setAttribute('aria-disabled', 'true');
      else { const button = f.doc.createElement('button'); button.className = 'menu-button ant-dropdown-trigger'; button.setAttribute('aria-label', 'More actions'); button.disabled = true; button.onclick = trigger.onclick; trigger.replaceWith(button); }
      assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.deepEqual(f.counts.trigger, []);
    } finally { f.dispose(); }
  }
});

test('a generic dropdown business button is never treated as a more trigger', () => {
  const f = fixture();
  try {
    const trigger = f.rows.get('vm-a').querySelector('.ant-dropdown-trigger'), button = f.doc.createElement('button');
    let business = 0;
    button.className = 'ant-dropdown-trigger'; button.textContent = 'Delete'; button.onclick = () => business++; trigger.replaceWith(button);
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.deepEqual(f.counts.trigger, []); assert.equal(f.counts.row, 0); assert.equal(business, 0);
  } finally { f.dispose(); }
});

for (const mode of ['unknown meaning', 'business label', 'business label with more icon', 'conflicting accessible label']) test(`${mode} on a menu-button fails closed`, () => {
  const f = fixture();
  try {
    const trigger = f.rows.get('vm-a').querySelector('.menu-button'); let business = 0;
    trigger.textContent = mode === 'unknown meaning' ? '' : 'Delete'; trigger.onclick = () => business++;
    if (mode === 'conflicting accessible label') trigger.setAttribute('aria-label', 'More actions');
    if (mode === 'business label with more icon') trigger.insertAdjacentHTML('beforeend', '<svg data-testid="MoreEllipsis316BoldBlueIcon"></svg>');
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.equal(business, 0); assert.equal(f.counts.row, 0);
  } finally { f.dispose(); }
});

test('the observed icon-only more trigger is accepted', () => {
  const f = fixture();
  try {
    f.rows.get('vm-a').querySelector('.menu-button').innerHTML = '<svg data-testid="MoreEllipsis316BoldBlueIcon"></svg>';
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), true); assert.deepEqual(f.counts.trigger, ['vm-a']);
  } finally { f.dispose(); }
});

for (const ancestor of ['cell', 'row', 'table', 'fieldset', 'inert', 'dropdown class']) test(`inherited disabled state on ${ancestor} prevents the trigger click`, () => {
  const f = fixture();
  try {
    const row = f.rows.get('vm-a'), trigger = row.querySelector('.menu-button');
    trigger.setAttribute('aria-disabled', 'false');
    if (ancestor === 'cell') trigger.closest('td').setAttribute('aria-disabled', 'true');
    if (ancestor === 'row') row.setAttribute('aria-disabled', 'true');
    if (ancestor === 'table') row.closest('table').setAttribute('aria-disabled', 'true');
    if (ancestor === 'fieldset') { const parent = f.doc.createElement('fieldset'); parent.disabled = true; f.doc.body.append(parent); parent.append(row.closest('table')); }
    if (ancestor === 'inert') row.setAttribute('inert', '');
    if (ancestor === 'dropdown class') trigger.closest('td').classList.add('ant-dropdown-disabled');
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.deepEqual(f.counts.trigger, []); assert.equal(f.counts.row, 0); assert.deepEqual(f.counts.native, []);
  } finally { f.dispose(); }
});

test('native disabled menu items retain their state and remain governed by host handlers', () => {
  const f = fixture();
  try {
    openNativeRowMenu(f.resource('vm-a'), f.win);
    const item = f.popups.get('vm-a').querySelector('.disabled');
    assert.equal(item.getAttribute('aria-disabled'), 'true'); assert.ok(item.classList.contains('ant-dropdown-menu-item-disabled'));
    item.click(); assert.deepEqual(f.counts.native, []); assert.equal(f.counts.row, 0);
  } finally { f.dispose(); }
});

test('an unrelated existing popup and native popup positioning are never altered', async () => {
  const f = fixture({ second: true });
  try {
    const existing = f.popups.get('vm-b'); existing.hidden = false; existing.classList.remove('ant-dropdown-hidden');
    const before = existing.outerHTML, ownPopup = f.popups.get('vm-a'), originalStyle = ownPopup.getAttribute('style');
    openNativeRowMenu(f.resource('vm-a'), f.win); await settle();
    assert.equal(existing.outerHTML, before); assert.equal(ownPopup.getAttribute('style'), originalStyle);
    assert.equal(ownPopup.hasAttribute('data-pk-native-context'), false);
    ownPopup.style.left = '500px'; ownPopup.style.top = '250px'; ownPopup.style.transform = 'translateX(4px)';
    const moved = ownPopup.getAttribute('style'); await settle(); assert.equal(ownPopup.getAttribute('style'), moved);
  } finally { f.dispose(); }
});

test('native portal submenu remains open and executes its own host handler', async () => {
  const f = fixture();
  try {
    openNativeRowMenu(f.resource('vm-a'), f.win);
    const parent = f.popups.get('vm-a'), submenu = f.doc.createElement('div');
    submenu.className = 'ant-dropdown native-submenu-portal'; submenu.style.left = '260px';
    submenu.innerHTML = '<ul role="menu"><li role="menuitem">Native nested edit</li></ul>';
    submenu.querySelector('li').onclick = () => f.counts.native.push('nested-vm-a');
    f.doc.body.append(submenu); await settle();
    assert.equal(f.visible(parent), true); assert.equal(submenu.isConnected, true); assert.equal(submenu.style.left, '260px');
    submenu.querySelector('li').click(); assert.deepEqual(f.counts.native, ['nested-vm-a']); assert.equal(f.visible(parent), true);
    parent.hidden = true; submenu.hidden = true; await settle();
    assert.equal(parent.hidden, true); assert.equal(submenu.hidden, true);
  } finally { f.dispose(); }
});

test('opening a row menu adds no plugin styles, attributes, observers, listeners or timers', t => {
  const f = fixture();
  try {
    const resource = f.resource('vm-a');
    // Warm jsdom's selector/style internals before observing calls attributable to the helper.
    f.win.getComputedStyle(f.doc.body); openNativeRowMenu(resource, f.win);
    f.rows.get('vm-a').querySelector('.ant-dropdown-trigger').click(); f.counts.trigger.length = 0;
    const rowBefore = f.rows.get('vm-a').outerHTML, styleBefore = f.popups.get('vm-a').getAttribute('style'), childrenBefore = f.doc.body.children.length;
    const timer = t.mock.method(f.win, 'setTimeout'), docListener = t.mock.method(f.doc, 'addEventListener'), windowListener = t.mock.method(f.win, 'addEventListener');
    let observers = 0; const OriginalObserver = f.win.MutationObserver;
    t.mock.method(f.win, 'MutationObserver', function (...args) { observers++; return new OriginalObserver(...args); });
    assert.equal(openNativeRowMenu(resource, f.win), true);
    assert.equal(timer.mock.callCount(), 0); assert.equal(docListener.mock.callCount(), 0); assert.equal(windowListener.mock.callCount(), 0); assert.equal(observers, 0);
    assert.equal(f.rows.get('vm-a').outerHTML, rowBefore); assert.equal(f.popups.get('vm-a').getAttribute('style'), styleBefore);
    assert.equal(f.doc.body.children.length, childrenBefore); assert.equal(f.doc.querySelector('style,[data-pk-native-context]'), null); assert.deepEqual(f.counts.trigger, ['vm-a']);
  } finally { f.dispose(); }
});
