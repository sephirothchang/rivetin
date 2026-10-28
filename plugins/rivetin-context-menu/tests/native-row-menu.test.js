import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openNativeRowMenu, nativeRowMenuReason } from '../src/native-menu.js';
import { identifyResource } from '../src/resources.js';
import { createNativeRowMenuAdapter } from '../src/native/row-menu.js';

const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function adapterFixture(t, options = {}) {
  const id = options.legacyImg ? 'nic-a' : 'host-a', type = options.legacyImg ? 'nic' : 'host';
  const more = options.legacyImg ? '<span class="idqfg35 icon-wrapper menu-button ant-dropdown-trigger"><span class="icon-inner"><img alt="1-more-ellipsis-3-16-bold-blue" src="./static/media/1-more-ellipsis-3-16-bold-blue.a71c9e251203b0f61c7d.svg" width="16px" height="16px"></span></span>' : '<button class="menu-button ant-dropdown-trigger" title="More">More</button>';
  const dom = new JSDOM(`<table><tr data-row-key="${id}"><td unique="name" id="adapter-source">Same name</td><td unique="_action_">${more}</td></tr></table>`, { url: 'https://tower.example.invalid/#/hosts' });
  const win = dom.window, doc = win.document, source = doc.getElementById('adapter-source'), row = source.closest('tr'), trigger = row.querySelector('.ant-dropdown-trigger');
  const rect = (left, top, width = 120, height = 30) => ({ left, top, right: left + width, bottom: top + height, width, height });
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden],.ant-dropdown-hidden') ? [] : [this.getBoundingClientRect()]; };
  win.HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains('ant-dropdown') ? rect(options.far ? 900 : 20, 50, 180, 140) : rect(20, 20); };
  const counts = { more: 0, submenu: 0, leaves: [], row: 0, network: 0 }, observers = new Set(), intervals = new Set(), timers = new Set();
  const Observer = win.MutationObserver, interval = win.setInterval.bind(win), clearInterval = win.clearInterval.bind(win), timeout = win.setTimeout.bind(win), clearTimeout = win.clearTimeout.bind(win);
  win.MutationObserver = class extends Observer { constructor(fn) { super(fn); observers.add(this); } disconnect() { observers.delete(this); super.disconnect(); } };
  win.setInterval = (...args) => { const id = interval(...args); intervals.add(id); return id; }; win.clearInterval = id => { intervals.delete(id); clearInterval(id); };
  win.setTimeout = (...args) => { const id = timeout(...args); timers.add(id); return id; }; win.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
  win.fetch = () => { counts.network++; throw new Error('NETWORK_FORBIDDEN'); };
  row.onclick = () => counts.row++;
  const resource = { type, id, name: 'Same name', element: source };
  let enabled = true;
  const identify = node => { const owner = node.closest('tr[data-row-key]'); return owner && { type, id: owner.dataset.rowKey, element: owner }; };
  const popup = doc.createElement('div'); popup.className = 'ant-dropdown ant-dropdown-hidden'; popup.hidden = true;
  popup.innerHTML = '<ul role="menu"><li role="menuitem" data-leaf="edit">Edit</li><li role="menuitem" class="ant-dropdown-menu-item-danger" data-leaf="remove">Remove</li><li role="menuitem" aria-disabled="true" data-leaf="disabled">Disabled</li></ul>';
  for (const node of popup.querySelectorAll('[data-leaf]')) node.onclick = () => { counts.leaves.push(node.dataset.leaf); if (options.dialogOnLeaf) { const dialog = doc.createElement('section'); dialog.className = 'ant-modal'; doc.body.append(dialog); } };
  doc.body.append(popup);
  const children = [];
  function addSubmenu(parentPopup = popup, name = 'Advanced', depth = 1) {
    const item = doc.createElement('li'); item.className = 'ant-dropdown-menu-submenu'; item.setAttribute('role', 'menuitem'); item.setAttribute('aria-haspopup', 'menu'); item.textContent = name;
    const child = doc.createElement('div'); child.className = 'ant-dropdown ant-dropdown-hidden'; child.hidden = true;
    child.innerHTML = `<ul role="menu"><li role="menuitem" data-child="${depth}">Nested ${depth}</li></ul>`;
    child.querySelector('li').onclick = () => counts.leaves.push('nested-' + depth);
    item.onclick = event => { event.stopPropagation(); counts.submenu++; child.hidden = !child.hidden; child.classList.toggle('ant-dropdown-hidden', child.hidden); item.classList.toggle('ant-dropdown-menu-submenu-open', !child.hidden); };
    parentPopup.querySelector('[role="menu"]').append(item); doc.body.append(child); children.push({ item, popup: child }); return child;
  }
  trigger.onclick = event => {
    event.stopPropagation(); counts.more++;
    if (options.noPopup) return;
    popup.hidden = !popup.hidden; popup.classList.toggle('ant-dropdown-hidden', popup.hidden);
    if (!options.noState) trigger.classList.toggle('ant-dropdown-open', !popup.hidden);
    if (popup.hidden) for (const child of children) { child.popup.hidden = true; child.popup.classList.add('ant-dropdown-hidden'); child.item.classList.remove('ant-dropdown-menu-submenu-open'); }
    if (options.extraPopup && !popup.hidden) { const extra = popup.cloneNode(true); extra.id = 'deceptive-popup'; doc.body.append(extra); }
  };
  const adapter = createNativeRowMenuAdapter({ win, identify, isEnabled: () => enabled, timeoutMs: 500, ...options.adapter });
  t.after(() => { adapter.stop(); win.close(); });
  return { win, doc, row, source, trigger, popup, resource, adapter, counts, observers, intervals, timers, addSubmenu,
    prepare: options => adapter.prepare(resource, options), disable() { enabled = false; },
    clean() { assert.equal(observers.size, 0); assert.equal(intervals.size, 0); assert.equal(timers.size, 0); assert.equal(counts.network + counts.row, 0); } };
}

function vdsHoverSubmenu(f, { delay = 15, noOpen = false, wrongOwner = false, eventModel = 'react', retainedShell = false, onEnter } = {}) {
  const item = f.doc.createElement('li'); item.className = 'ant-dropdown-menu-submenu ant-dropdown-menu-submenu-vertical'; item.setAttribute('role', 'menuitem');
  item.innerHTML = '<div class="ant-dropdown-menu-submenu-title" role="button" aria-haspopup="true" aria-expanded="false"><svg data-testid="EditPen16BlueIcon"></svg><span>编辑</span><span class="ant-dropdown-menu-submenu-arrow" aria-hidden="true">›</span></div>';
  const title = item.firstElementChild;
  const popup = f.doc.createElement('div'); popup.className = 'ant-dropdown-menu-submenu ant-dropdown-menu-submenu-popup ant-dropdown-menu ant-dropdown-menu-light'; popup.hidden = true;
  popup.innerHTML = '<ul id="example-vds-edit-menu" class="ant-dropdown-menu ant-dropdown-menu-sub ant-dropdown-menu-vertical" role="menu"><li class="ant-dropdown-menu-item" role="menuitem" data-vds-leaf="basic">编辑基本信息和关联网口</li><li class="ant-dropdown-menu-item" role="menuitem" data-vds-leaf="igmp">编辑 IGMP/MLD 侦听</li></ul>';
  for (const leaf of popup.querySelectorAll('[role="menuitem"]')) leaf.onclick = () => f.counts.leaves.push('vds-' + leaf.dataset.vdsLeaf);
  const counts = { enter: 0, leave: 0, titleClick: 0 }; let timer = null;
  title.onclick = event => { event.stopPropagation(); counts.titleClick++; /* rc-menu hover mode does not open on title click. */ };
  const update = open => {
    title.setAttribute('aria-expanded', String(open)); item.classList.toggle('ant-dropdown-menu-submenu-open', open);
    popup.hidden = retainedShell ? false : !open;
    if (retainedShell) {
      popup.classList.toggle('ant-dropdown-menu-submenu-hidden', !open); popup.style.cssText = `display:block;visibility:visible;width:130px;height:${open ? 140 : 0}px`;
      const menu = popup.querySelector('[role="menu"]'); menu.classList.toggle('ant-dropdown-menu-hidden', !open); menu.style.display = open ? 'block' : 'none';
    }
    if (open) title.setAttribute('aria-owns', wrongOwner ? 'another-menu' : 'example-vds-edit-menu'); else title.removeAttribute('aria-owns');
  };
  if (retainedShell) {
    popup.getBoundingClientRect = () => ({ left: 20, top: 50, right: 150, bottom: title.getAttribute('aria-expanded') === 'true' ? 190 : 50, width: 130, height: title.getAttribute('aria-expanded') === 'true' ? 140 : 0 });
    update(false);
  }
  const cancel = () => { if (timer !== null) { f.win.clearTimeout(timer); timer = null; } };
  const enter = () => { counts.enter++; cancel(); onEnter?.(); if (!noOpen) timer = f.win.setTimeout(() => { cancel(); update(true); }, delay); };
  const leave = () => { counts.leave++; cancel(); update(false); };
  title.addEventListener(eventModel === 'react' ? 'mouseover' : 'mouseenter', enter);
  title.addEventListener(eventModel === 'react' ? 'mouseout' : 'mouseleave', leave);
  f.popup.querySelector('[role="menu"]').append(item); f.doc.body.append(popup);
  return { item, title, popup, counts };
}

test('the observed VDS hover model does not open its submenu on programmatic title click', async t => {
  const f = adapterFixture(t), sub = vdsHoverSubmenu(f); f.trigger.click(); sub.title.click();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sub.popup.hidden, true); assert.equal(sub.title.getAttribute('aria-expanded'), 'false'); assert.equal(sub.counts.titleClick, 1); assert.deepEqual(f.counts.leaves, []);
  f.trigger.click(); f.clean();
});
for (const eventModel of ['react', 'native']) test(`VDS ${eventModel} hover opens and closes the official submenu without a prepare leaf click`, async t => {
  const f = adapterFixture(t), sub = vdsHoverSubmenu(f, { eventModel }), session = await f.prepare(); assert.ok(session);
  const group = session.tree.find(item => item.label === '编辑'); assert.ok(group); assert.deepEqual(group.children.map(item => item.label), ['编辑基本信息和关联网口', '编辑 IGMP/MLD 侦听']);
  assert.ok(group.children.every(item => !Object.hasOwn(item, 'children')), 'a submenu-popup ancestor must not turn real leaf items into openers');
  assert.deepEqual(f.counts.leaves, []); assert.equal(sub.counts.titleClick, 0); assert.equal(sub.counts.enter, 1); assert.equal(sub.counts.leave, 1); assert.equal(sub.popup.hidden, true); assert.equal(f.popup.hidden, true);
  assert.deepEqual(await session.execute(group.children[1].id), { status: 'handed-off', surface: 'native-action' });
  assert.deepEqual(f.counts.leaves, ['vds-igmp']); assert.equal(sub.counts.enter, 2); assert.equal(sub.counts.titleClick, 0); f.clean();
});
test('VDS submenu hover cannot override an explicitly disabled title', async t => {
  const f = adapterFixture(t), sub = vdsHoverSubmenu(f); sub.title.setAttribute('aria-disabled', 'true');
  const session = await f.prepare(); assert.ok(session); const group = session.tree.find(item => item.label === '编辑'); assert.equal(group.disabled, true); assert.deepEqual(group.children, []);
  assert.deepEqual(await session.execute(group.id), { status: 'unsupported', reason: 'entry-disabled' }); assert.equal(sub.counts.enter, 0); assert.deepEqual(f.counts.leaves, []); session.close(); f.clean();
});
test('VDS hover still requires public opened state and exact child popup ownership', async t => {
  const f = adapterFixture(t, { adapter: { timeoutMs: 150 } }), sub = vdsHoverSubmenu(f, { wrongOwner: true }), reasons = [];
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null); assert.deepEqual(reasons, ['popup-unproven']); assert.deepEqual(f.counts.leaves, []); assert.equal(sub.counts.titleClick, 0); assert.equal(sub.popup.hidden, true); f.clean();
});
test('VDS no-response hover reports popup-timeout rather than clicking an unknown leaf', async t => {
  const f = adapterFixture(t, { adapter: { timeoutMs: 150 } }), sub = vdsHoverSubmenu(f, { noOpen: true }), reasons = [];
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null); assert.deepEqual(reasons, ['popup-timeout']); assert.deepEqual(f.counts.leaves, []); assert.equal(sub.counts.titleClick, 0); f.clean();
});
test('cancelling VDS hover clears the host enter delay using only its own leave events', async t => {
  const f = adapterFixture(t), controller = new f.win.AbortController(), reasons = [], sub = vdsHoverSubmenu(f, { delay: 80 });
  const preparing = f.prepare({ signal: controller.signal, onFailure: code => reasons.push(code) });
  for (let i = 0; i < 30 && sub.counts.enter === 0; i++) await Promise.resolve();
  assert.equal(sub.counts.enter, 1); controller.abort(); assert.equal(await preparing, null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(reasons, ['cancelled']); assert.equal(sub.popup.hidden, true); assert.equal(sub.title.getAttribute('aria-expanded'), 'false'); assert.ok(sub.counts.leave > 0); assert.deepEqual(f.counts.leaves, []); f.clean();
});
test('VDS duplicate native submenu labels never trigger hover or leaf selection', async t => {
  const f = adapterFixture(t), first = vdsHoverSubmenu(f), second = vdsHoverSubmenu(f), session = await f.prepare(); assert.ok(session);
  const groups = session.tree.filter(item => item.label === '编辑'); assert.equal(groups.length, 2); assert.ok(groups.every(item => item.disabled && item.reasonCode === 'menu-ambiguous'));
  assert.equal(first.counts.enter + second.counts.enter, 0); assert.deepEqual(f.counts.leaves, []); session.close(); f.clean();
});
test('VDS fresh duplicate child leaves cancel without clicking or leaving a hover popup open', async t => {
  const f = adapterFixture(t), sub = vdsHoverSubmenu(f), reasons = [], session = await f.prepare({ onFailure: code => reasons.push(code) });
  const action = session.tree.find(item => item.label === '编辑').children[0], leaf = sub.popup.querySelector('[role="menuitem"]'); leaf.parentElement.append(leaf.cloneNode(true));
  assert.deepEqual(await session.execute(action.id), { status: 'unsupported', reason: 'menu-ambiguous' });
  assert.deepEqual(reasons, ['menu-ambiguous']); assert.deepEqual(f.counts.leaves, []); assert.equal(sub.popup.hidden, true); assert.equal(f.popup.hidden, true); assert.equal(sub.counts.titleClick, 0); f.clean();
});
test('VDS retained zero-height hidden shell finishes prepare and does not block a later menu', async t => {
  const f = adapterFixture(t), sub = vdsHoverSubmenu(f, { retainedShell: true }), reasons = [];
  const first = await f.prepare({ onFailure: code => reasons.push(code) }); assert.ok(first); assert.equal(first.tree.find(item => item.label === '编辑').children.length, 2);
  assert.equal(sub.popup.hidden, false); assert.equal(f.win.getComputedStyle(sub.popup).display, 'block'); assert.equal(f.win.getComputedStyle(sub.popup).visibility, 'visible');
  assert.equal(sub.popup.getBoundingClientRect().height, 0); assert.equal(sub.popup.getClientRects().length, 1);
  assert.ok(sub.popup.classList.contains('ant-dropdown-menu-submenu-hidden')); assert.ok(sub.popup.querySelector('[role="menu"]').classList.contains('ant-dropdown-menu-hidden')); assert.equal(sub.popup.querySelector('[role="menu"]').style.display, 'none');
  assert.deepEqual(f.counts.leaves, []); assert.equal(sub.counts.enter, 1); assert.equal(sub.counts.leave, 1); first.close(); f.clean();
  const second = await f.prepare({ onFailure: code => reasons.push(code) }); assert.ok(second); assert.deepEqual(f.counts.leaves, []); assert.equal(sub.counts.enter, 2); assert.equal(sub.counts.leave, 2);
  const leaf = second.tree.find(item => item.label === '编辑').children[0];
  assert.deepEqual(await second.execute(leaf.id), { status: 'handed-off', surface: 'native-action' }); assert.deepEqual(f.counts.leaves, ['vds-basic']); assert.deepEqual(reasons, []); f.clean();
});
for (const hiddenClass of ['ant-dropdown-menu-submenu-hidden', 'ant-dropdown-menu-hidden']) test(`native entry under ${hiddenClass} cannot be read or executed`, async t => {
  const f = adapterFixture(t); f.popup.querySelector('[data-leaf="edit"]').classList.add(hiddenClass);
  const session = await f.prepare(); assert.ok(session); assert.equal(session.tree.some(item => item.label === 'Edit'), false); assert.deepEqual(f.counts.leaves, []); session.close(); f.clean();
});
test('a non-hidden zero-height popup shell still blocks an unrelated native menu', async t => {
  const f = adapterFixture(t), shell = f.doc.createElement('div'), reasons = [];
  shell.className = 'ant-dropdown-menu-submenu-popup'; shell.style.cssText = 'display:block;visibility:visible;height:0;width:130px'; shell.innerHTML = '<ul role="menu" style="display:none"></ul>';
  shell.getBoundingClientRect = () => ({ left: 900, right: 1030, top: 30, bottom: 30, width: 130, height: 0 }); shell.getClientRects = () => [shell.getBoundingClientRect()]; f.doc.body.append(shell);
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null); assert.deepEqual(reasons, ['blocked-by-dialog']); assert.equal(f.counts.more, 0); assert.deepEqual(f.counts.leaves, []); f.clean();
});
test('the hidden-shell fix does not accept a More trigger with no client rects', async t => {
  const f = adapterFixture(t), reasons = []; f.trigger.getClientRects = () => [];
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null); assert.deepEqual(reasons, ['trigger-missing']); assert.equal(f.counts.more, 0); f.clean();
});
test('locked React 16 EnterLeaveEventPlugin opens and hides a real portal through public hover events', async t => {
  let teardown = () => {}; t.after(() => teardown());
  const f = adapterFixture(t), originals = new Map();
  for (const [key, value] of Object.entries({ window: f.win, document: f.doc, navigator: f.win.navigator, HTMLElement: f.win.HTMLElement, Node: f.win.Node, MessageChannel: undefined })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const React = require('react'), ReactDOM = require('react-dom'), h = React.createElement, mount = f.popup.querySelector('[role="menu"]');
  const counts = { enter: 0, leave: 0, titleClick: 0 }; assert.equal(React.version, '16.14.0');
  teardown = () => {
    f.adapter.stop(); ReactDOM.unmountComponentAtNode(mount);
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  };
  function HostSubmenu() {
    const [open, setOpen] = React.useState(false);
    return h(React.Fragment, null,
      h('li', { role: 'menuitem', className: 'ant-dropdown-menu-submenu' + (open ? ' ant-dropdown-menu-submenu-open' : '') },
        h('div', { role: 'button', className: 'ant-dropdown-menu-submenu-title', 'aria-haspopup': 'true', 'aria-expanded': String(open), 'aria-owns': open ? 'example-vds-react-menu' : undefined,
          onMouseEnter() { counts.enter++; setOpen(true); }, onMouseLeave() { counts.leave++; setOpen(false); }, onClick() { counts.titleClick++; } }, '编辑')),
      ReactDOM.createPortal(h('div', { hidden: !open, className: 'ant-dropdown-menu-submenu ant-dropdown-menu-submenu-popup' },
        h('ul', { role: 'menu', id: 'example-vds-react-menu' }, h('li', { role: 'menuitem', onClick() { f.counts.leaves.push('react-vds-edit'); } }, '编辑基本信息和关联网口'))), f.doc.body));
  }
  ReactDOM.render(h(HostSubmenu), mount);
  const title = mount.querySelector('.ant-dropdown-menu-submenu-title');
  title.dispatchEvent(new f.win.MouseEvent('mouseover', { bubbles: true, relatedTarget: mount }));
  assert.equal(counts.enter, 0, 'React 16 ignores mouseover with relatedTarget because it expects the matching mouseout');
  const session = await f.prepare(); assert.ok(session); assert.equal(session.tree[0].children[0].label, '编辑基本信息和关联网口');
  assert.equal(counts.enter, 1); assert.equal(counts.leave, 1); assert.equal(counts.titleClick, 0); assert.deepEqual(f.counts.leaves, []);
  assert.deepEqual(await session.execute(session.tree[0].children[0].id), { status: 'handed-off', surface: 'native-action' });
  assert.deepEqual(f.counts.leaves, ['react-vds-edit']); assert.equal(counts.titleClick, 0); f.clean();
});

test('adapter prepare reads exact row metadata then hides its own popup without business clicks', async t => {
  const f = adapterFixture(t); const session = await f.prepare(); assert.ok(session);
  assert.deepEqual(session.tree.map(item => [item.label, item.disabled, item.danger]), [['Edit', false, false], ['Remove', false, true], ['Disabled', true, false]]);
  assert.ok(Object.isFrozen(session.tree)); assert.equal(f.popup.hidden, true); assert.equal(f.counts.more, 2); assert.deepEqual(f.counts.leaves, []);
  session.close(); f.clean();
});
test('adapter opaque leaf execution reopens original menu and delegates once, never claims business completion', async t => {
  const f = adapterFixture(t, { dialogOnLeaf: true }), session = await f.prepare();
  const action = session.tree.find(item => item.label === 'Remove');
  assert.deepEqual(await session.execute(action.id), { status: 'handed-off', surface: 'native-action' });
  assert.deepEqual(f.counts.leaves, ['remove']); const more = f.counts.more;
  session.close(); assert.equal(f.counts.more, more); assert.ok(f.doc.querySelector('.ant-modal')); f.clean();
  assert.equal((await session.execute(action.id)).status, 'unsupported');
});
test('adapter never accepts a label or another session opaque ID as an action', async t => {
  const f = adapterFixture(t), first = await f.prepare(), id = first.tree[0].id, second = await f.prepare();
  assert.equal((await second.execute('Edit')).status, 'unsupported'); assert.equal((await second.execute(id)).status, 'unsupported');
  assert.deepEqual(f.counts.leaves, []); second.close(); f.clean();
});
for (const options of [{ noState: true }, { far: true }, { extraPopup: true }]) test('adapter rejects unproven popup ownership ' + JSON.stringify(options), async t => {
  const f = adapterFixture(t, options); assert.equal(await f.prepare(), null); assert.deepEqual(f.counts.leaves, []); f.clean();
});
test('adapter explicit popup association overrides distance but conflicting aria reference rejects it', async t => {
  const f = adapterFixture(t, { far: true }); f.popup.id = 'native-owned'; f.trigger.setAttribute('aria-controls', 'native-owned');
  const session = await f.prepare(); assert.ok(session); session.close(); f.clean();
  f.trigger.setAttribute('aria-controls', 'some-other-popup'); assert.equal(await f.prepare(), null); f.clean();
});
test('adapter refuses any preexisting visible popup or modal without clicking a trigger', async t => {
  const f = adapterFixture(t); const modal = f.doc.createElement('section'); modal.className = 'ant-modal'; f.doc.body.append(modal);
  assert.equal(await f.prepare(), null); assert.equal(f.counts.more, 0); modal.remove();
  f.popup.hidden = false; f.popup.classList.remove('ant-dropdown-hidden'); assert.equal(await f.prepare(), null); assert.equal(f.counts.more, 0); f.clean();
});
test('adapter only clicks a unique More-semantic trigger, never a generic dropdown business button', async t => {
  const f = adapterFixture(t); f.trigger.title = 'Delete'; f.trigger.textContent = 'Delete'; assert.equal(await f.prepare(), null); assert.equal(f.counts.more, 0);
  f.trigger.title = 'More'; f.trigger.textContent = 'More'; f.trigger.parentElement.append(f.trigger.cloneNode(true)); assert.equal(await f.prepare(), null); f.clean();
});
test('adapter never treats a name-cell dropdown as the native row action trigger', async t => {
  const f = adapterFixture(t); f.source.append(f.trigger); assert.equal(await f.prepare(), null); assert.equal(f.counts.more, 0); f.clean();
});
test('adapter copies a native red icon as danger presentation without mapping its label to a command', async t => {
  const f = adapterFixture(t); f.popup.querySelector('[data-leaf="edit"]').insertAdjacentHTML('afterbegin', '<svg data-testid="Delete16GradientRedIcon"></svg>');
  const session = await f.prepare(); assert.equal(session.tree[0].danger, true); assert.equal(session.tree[0].label, 'Edit'); session.close(); f.clean();
});
test('adapter duplicate native labels are inspectable but never executable', async t => {
  const f = adapterFixture(t); const original = f.popup.querySelector('[data-leaf="edit"]'); original.parentElement.append(original.cloneNode(true));
  const session = await f.prepare(); const duplicates = session.tree.filter(item => item.label === 'Edit'); assert.equal(duplicates.length, 2); assert.ok(duplicates.every(item => item.disabled));
  assert.equal((await session.execute(duplicates[0].id)).status, 'unsupported'); assert.deepEqual(f.counts.leaves, []); session.close(); f.clean();
});
for (const change of ['rename', 'duplicate', 'disable', 'kind']) test('adapter rejects a fresh path whose native leaf changed: ' + change, async t => {
  const f = adapterFixture(t), session = await f.prepare(), id = session.tree[0].id, node = f.popup.querySelector('[data-leaf="edit"]');
  if (change === 'rename') node.textContent = 'Different action';
  if (change === 'duplicate') node.parentElement.append(node.cloneNode(true));
  if (change === 'disable') node.setAttribute('aria-disabled', 'true');
  if (change === 'kind') node.setAttribute('aria-haspopup', 'menu');
  assert.equal((await session.execute(id)).status, 'unsupported'); assert.deepEqual(f.counts.leaves, []); f.clean();
});
for (const change of ['replace-row', 'replace-trigger', 'recycle-id', 'route', 'disable']) test('adapter exact source proof rejects stale ' + change, async t => {
  const f = adapterFixture(t), session = await f.prepare(), id = session.tree[0].id;
  if (change === 'replace-row') f.row.replaceWith(f.row.cloneNode(true));
  if (change === 'replace-trigger') f.trigger.replaceWith(f.trigger.cloneNode(true));
  if (change === 'recycle-id') f.row.dataset.rowKey = 'host-b';
  if (change === 'route') f.win.history.replaceState({}, '', '#/hosts/host-b');
  if (change === 'disable') f.disable();
  await settle(); assert.equal((await session.execute(id)).status, 'unsupported'); assert.deepEqual(f.counts.leaves, []); session.close(); f.clean();
});
test('adapter reads nested native submenus without selecting leaves and reopens their exact path on execute', async t => {
  const f = adapterFixture(t), child = f.addSubmenu(), grandchild = f.addSubmenu(child, 'More advanced', 2); void grandchild;
  const session = await f.prepare(); assert.ok(session); const leaf = session.tree.find(item => item.label === 'Advanced').children.find(item => item.label === 'More advanced').children[0];
  assert.equal(leaf.label, 'Nested 2'); assert.deepEqual(f.counts.leaves, []); assert.equal(f.popup.hidden, true);
  assert.equal((await session.execute(leaf.id)).status, 'handed-off'); assert.deepEqual(f.counts.leaves, ['nested-2']); f.clean();
});
test('adapter disabled submenu ancestors prevent enumeration and later leaf execution', async t => {
  const f = adapterFixture(t); f.addSubmenu(); f.doc.querySelector('.ant-dropdown-menu-submenu').setAttribute('aria-disabled', 'true');
  const session = await f.prepare(); const parent = session.tree.find(item => item.label === 'Advanced'); assert.equal(parent.disabled, true); assert.deepEqual(parent.children, []); assert.equal(f.counts.submenu, 0);
  session.close(); f.clean();
});
test('adapter recursion budget disables deeper traversal and bounds host clicks', async t => {
  const f = adapterFixture(t, { adapter: { maxDepth: 1 } }), child = f.addSubmenu(); f.addSubmenu(child, 'Deeper', 2);
  const session = await f.prepare(); assert.ok(session); const nested = session.tree.find(item => item.label === 'Advanced').children.find(item => item.label === 'Deeper');
  assert.equal(nested.disabled, true); assert.deepEqual(nested.children, []); assert.equal(f.counts.submenu, 2); session.close(); f.clean();
});
test('adapter abort, timeout and stop disconnect observers and clear timers without business actions', async t => {
  for (const kind of ['abort', 'timeout', 'stop']) {
    const f = adapterFixture(t, { noPopup: true }), controller = new f.win.AbortController(), pending = f.prepare({ signal: controller.signal });
    if (kind === 'abort') controller.abort(); if (kind === 'stop') f.adapter.stop();
    assert.equal(await pending, null); assert.deepEqual(f.counts.leaves, []); f.clean();
  }
});
test('adapter abort in the first popup await gap still closes its already proven native popup', async t => {
  const f = adapterFixture(t), controller = new f.win.AbortController(), pending = f.prepare({ signal: controller.signal });
  controller.abort(); assert.equal(await pending, null); assert.equal(f.popup.hidden, true); assert.deepEqual(f.counts.leaves, []); f.clean();
});

test('legacy NIC IMG More prepares and delegates its native leaf exactly once', async t => {
  const f = adapterFixture(t, { legacyImg: true }), session = await f.prepare(); assert.ok(session);
  assert.equal(f.trigger.tagName, 'SPAN'); assert.equal(f.resource.type, 'nic'); assert.equal(f.popup.hidden, true); assert.equal(f.counts.more, 2);
  assert.deepEqual(await session.execute(session.tree[0].id), { status: 'handed-off', surface: 'native-action' });
  assert.equal(f.counts.more, 3); assert.deepEqual(f.counts.leaves, ['edit']); f.clean();
});
test('legacy More IMG semantics use the exact alt rather than its asset path', async t => {
  const f = adapterFixture(t, { legacyImg: true }); f.trigger.querySelector('img').src = './unrelated-asset.svg';
  const session = await f.prepare(); assert.ok(session); session.close(); f.clean();
});
for (const alt of ['', 'more', '1-more-ellipsis-3-16-bold-red', '1-more-ellipsis-3-16-bold-blue-extra']) test(`legacy More rejects an unverified IMG alt ${JSON.stringify(alt)}`, async t => {
  const f = adapterFixture(t, { legacyImg: true }), reasons = []; f.trigger.querySelector('img').alt = alt;
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null); assert.deepEqual(reasons, ['trigger-missing']); assert.equal(f.counts.more, 0); f.clean();
});
for (const attribute of ['aria-label', 'title']) test(`legacy More IMG cannot override a conflicting ${attribute}`, async t => {
  const f = adapterFixture(t, { legacyImg: true }); f.trigger.setAttribute(attribute, 'Delete');
  assert.equal(await f.prepare(), null); assert.equal(f.counts.more, 0); f.clean();
});
test('legacy More retains unique, exact-row and disabled-state requirements', async t => {
  const f = adapterFixture(t, { legacyImg: true }), duplicate = f.trigger.cloneNode(true);
  f.trigger.parentElement.append(duplicate); assert.equal(await f.prepare(), null); duplicate.remove();
  f.trigger.setAttribute('aria-disabled', 'true'); assert.equal(await f.prepare(), null); f.trigger.removeAttribute('aria-disabled');
  const otherRow = f.doc.createElement('tr'); otherRow.dataset.rowKey = 'nic-b'; otherRow.innerHTML = '<td unique="_action_"></td>'; f.row.parentElement.append(otherRow);
  otherRow.firstElementChild.append(f.trigger); assert.equal(await f.prepare(), null);
  assert.equal(f.counts.more, 0); f.clean();
});
test('legacy More rejects an uncertain row identity before any native click', async t => {
  const f = adapterFixture(t, { legacyImg: true, adapter: { identify: () => null } }), reasons = [];
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null); assert.deepEqual(reasons, ['source-changed']); assert.equal(f.counts.more, 0); f.clean();
});
for (const disabled of [false, true]) test(`adapter late IMG More duplicate disabled=${disabled} invalidates fresh uniqueness before any leaf`, async t => {
  const f = adapterFixture(t), reasons = [], session = await f.prepare({ onFailure: code => reasons.push(code) });
  const duplicate = f.doc.createElement('span'); duplicate.className = 'icon-wrapper menu-button ant-dropdown-trigger'; duplicate.innerHTML = '<span class="icon-inner"><img alt="1-more-ellipsis-3-16-bold-blue" src="./irrelevant.svg"></span>';
  if (disabled) duplicate.setAttribute('aria-disabled', 'true'); f.trigger.parentElement.append(duplicate);
  assert.deepEqual(await session.execute(session.tree[0].id), { status: 'unsupported', reason: 'trigger-ambiguous' });
  assert.equal(f.counts.more, 2, 'only prepare open and close occurred'); assert.deepEqual(f.counts.leaves, []); assert.deepEqual(reasons, ['trigger-ambiguous']); f.clean();
});
test('adapter cannot borrow an IMG More from a nested table row without a resource key', async t => {
  const f = adapterFixture(t, { legacyImg: true }), reasons = [], outerCell = f.trigger.parentElement, table = f.doc.createElement('table');
  table.innerHTML = '<tbody><tr><td unique="_action_"></td></tr></tbody>'; table.querySelector('td').append(f.trigger); outerCell.append(table);
  assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null);
  assert.deepEqual(reasons, ['trigger-missing']); assert.equal(f.counts.more, 0); assert.deepEqual(f.counts.leaves, []); f.clean();
});

for (const [cause, change] of [
  ['plugin-disabled', f => f.disable()],
  ['source-changed', f => { f.row.dataset.rowKey = 'host-b'; }],
  ['trigger-missing', f => f.trigger.remove()],
  ['trigger-ambiguous', f => f.trigger.parentElement.append(f.trigger.cloneNode(true))],
  ['entry-disabled', f => { f.trigger.disabled = true; }],
  ['blocked-by-dialog', f => f.doc.body.insertAdjacentHTML('beforeend', '<section class="ant-modal"></section>')],
  ['blocked-by-dialog', f => { f.popup.hidden = false; f.popup.classList.remove('ant-dropdown-hidden'); }],
]) test(`adapter prepare reports only structured ${cause} and leaves no observers or timers`, async t => {
  const f = adapterFixture(t), reasons = []; change(f);
  assert.equal(await f.prepare({ onFailure: reason => reasons.push(reason) }), null);
  assert.deepEqual(reasons, [cause]); assert.deepEqual(f.counts.leaves, []); f.clean();
});
test('adapter distinguishes no popup timeout from visible but unproven ownership', async t => {
  for (const [options, cause] of [[{ noPopup: true }, 'popup-timeout'], [{ far: true }, 'popup-unproven']]) {
    const f = adapterFixture(t, { ...options, adapter: { timeoutMs: 100 } }), reasons = [];
    assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null);
    assert.deepEqual(reasons, [cause]); assert.deepEqual(f.counts.leaves, []); f.clean();
  }
});
test('adapter distinguishes proven empty and ambiguous native menus', async t => {
  for (const [ambiguous, cause] of [[false, 'menu-empty'], [true, 'menu-ambiguous']]) {
    const f = adapterFixture(t), reasons = [];
    f.popup.innerHTML = ambiguous ? '<ul role="menu"><li role="menuitem">A</li></ul><ul role="menu"><li role="menuitem">B</li></ul>' : '<ul role="menu"></ul>';
    assert.equal(await f.prepare({ onFailure: code => reasons.push(code) }), null);
    assert.deepEqual(reasons, [cause]); assert.deepEqual(f.counts.leaves, []); f.clean();
    assert.equal(f.popup.hidden, true, 'a proven empty or ambiguous menu still closes its own trigger');
  }
});
test('adapter execute returns entry-disabled without attributing native disabled state to authorization', async t => {
  const f = adapterFixture(t), reasons = [], session = await f.prepare({ onFailure: code => reasons.push(code) });
  const action = session.tree.find(item => item.label === 'Disabled'); assert.equal(action.reasonCode, 'entry-disabled');
  assert.deepEqual(await session.execute(action.id), { status: 'unsupported', reason: 'entry-disabled' });
  assert.deepEqual(reasons, ['entry-disabled']); assert.deepEqual(f.counts.leaves, []); session.close(); f.clean();
});
for (const [cause, change] of [
  ['menu-changed', f => { f.popup.querySelector('[data-leaf="edit"]').textContent = 'Renamed'; }],
  ['menu-ambiguous', f => { const node = f.popup.querySelector('[data-leaf="edit"]'); node.parentElement.append(node.cloneNode(true)); }],
  ['entry-disabled', f => f.popup.querySelector('[data-leaf="edit"]').setAttribute('aria-disabled', 'true')],
]) test(`adapter fresh execute reports ${cause} and cleans its reopened native popup`, async t => {
  const f = adapterFixture(t), reasons = [], session = await f.prepare({ onFailure: code => reasons.push(code) }), id = session.tree[0].id; change(f);
  assert.deepEqual(await session.execute(id), { status: 'unsupported', reason: cause });
  assert.deepEqual(reasons, [cause]); assert.equal(f.popup.hidden, true); assert.deepEqual(f.counts.leaves, []); f.clean();
});
test('adapter reports a depth limit for both bounded preparation and a disabled truncated submenu', async t => {
  const f = adapterFixture(t, { adapter: { maxDepth: 1 } }), reasons = [], child = f.addSubmenu(); f.addSubmenu(child, 'Deeper', 2);
  const session = await f.prepare({ onFailure: code => reasons.push(code) });
  const deeper = session.tree.find(item => item.label === 'Advanced').children.find(item => item.label === 'Deeper');
  assert.equal(deeper.reasonCode, 'depth-limit');
  assert.deepEqual(await session.execute(deeper.id), { status: 'unsupported', reason: 'depth-limit' });
  assert.deepEqual(reasons, ['depth-limit']); session.close(); f.clean();
  const limited = adapterFixture(t, { adapter: { maxItems: 1 } }), otherReasons = [];
  assert.equal(await limited.prepare({ onFailure: code => otherReasons.push(code) }), null); assert.deepEqual(otherReasons, ['depth-limit']); limited.clean();
});
test('adapter reports cancellation once even when aborted and explicitly closed in the same await gap', async t => {
  const f = adapterFixture(t), reasons = [], controller = new f.win.AbortController();
  const pending = f.prepare({ signal: controller.signal, onFailure: code => reasons.push(code) }); controller.abort(); f.adapter.stop();
  assert.equal(await pending, null); assert.deepEqual(reasons, ['cancelled']); assert.equal(f.popup.hidden, true); f.clean();
});
test('adapter reports unexpected only as an enum and swallows diagnostic callback exceptions', async t => {
  const reasons = [];
  const safe = adapterFixture(t, { adapter: { isEnabled() { throw new Error('Private host details'); } } });
  assert.equal(await safe.prepare({ onFailure: code => { reasons.push(code); throw new Error('Callback failure'); } }), null);
  assert.deepEqual(reasons, ['unexpected']); safe.clean();
});
test('a throwing failure callback cannot prevent closing a proven native popup', async t => {
  const f = adapterFixture(t), reasons = [], session = await f.prepare({ onFailure: code => { reasons.push(code); throw new Error('Diagnostic callback failed'); } });
  f.popup.querySelector('[data-leaf="edit"]').textContent = 'Changed';
  assert.deepEqual(await session.execute(session.tree[0].id), { status: 'unsupported', reason: 'menu-changed' });
  assert.deepEqual(reasons, ['menu-changed']); assert.equal(f.popup.hidden, true); f.clean();
});
test('adapter failure callbacks belong only to their local prepare session', async t => {
  const f = adapterFixture(t), firstReasons = [], secondReasons = [], parent = f.trigger.parentElement;
  f.trigger.remove(); assert.equal(await f.prepare({ onFailure: code => firstReasons.push(code) }), null);
  parent.append(f.trigger); const session = await f.prepare({ onFailure: code => secondReasons.push(code) });
  const disabled = session.tree.find(item => item.disabled);
  assert.deepEqual(await session.execute(disabled.id), { status: 'unsupported', reason: 'entry-disabled' });
  assert.deepEqual(firstReasons, ['trigger-missing']); assert.deepEqual(secondReasons, ['entry-disabled']); session.close(); f.clean();
});
for (const [cause, change] of [
  ['plugin-disabled', f => f.disable()],
  ['source-changed', f => f.win.history.replaceState({}, '', '#/hosts/host-b')],
]) test(`adapter execute distinguishes a late ${cause} from menu changes`, async t => {
  const f = adapterFixture(t), reasons = [], session = await f.prepare({ onFailure: code => reasons.push(code) }); change(f);
  assert.deepEqual(await session.execute(session.tree[0].id), { status: 'unsupported', reason: cause });
  assert.deepEqual(reasons, [cause]); assert.deepEqual(f.counts.leaves, []); f.clean();
});

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

function legacyHelperImage(f, id = 'vm-a') {
  const trigger = f.rows.get(id).querySelector('.menu-button');
  trigger.textContent = '';
  trigger.innerHTML = '<span class="icon-inner"><img alt="1-more-ellipsis-3-16-bold-blue" src="./static/media/1-more-ellipsis-3-16-bold-blue.a71c9e251203b0f61c7d.svg" width="16px" height="16px"></span>';
  return trigger;
}
test('legacy helper opens the exact native IMG More without selecting a row or business leaf', () => {
  const f = fixture(); try {
    const trigger = legacyHelperImage(f); trigger.querySelector('img').src = './other-file.svg';
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), true);
    assert.deepEqual(f.counts.trigger, ['vm-a']); assert.equal(f.visible(f.popups.get('vm-a')), true); assert.equal(f.counts.row, 0); assert.deepEqual(f.counts.native, []);
  } finally { f.dispose(); }
});
for (const alt of ['', 'More', '1-more-ellipsis-3-16-bold-red', '1-more-ellipsis-3-16-bold-blue-extra']) test(`legacy helper rejects unverified IMG alt ${JSON.stringify(alt)}`, () => {
  const f = fixture(); try {
    legacyHelperImage(f).querySelector('img').alt = alt;
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.equal(nativeRowMenuReason(f.resource('vm-a'), f.win), 'trigger-missing'); assert.deepEqual(f.counts.trigger, []);
  } finally { f.dispose(); }
});
for (const attribute of ['aria-label', 'title']) test(`legacy helper IMG cannot override a conflicting ${attribute}`, () => {
  const f = fixture(); try {
    legacyHelperImage(f).setAttribute(attribute, 'Delete');
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.deepEqual(f.counts.trigger, []);
  } finally { f.dispose(); }
});
for (const attribute of ['disabled', 'aria-disabled', 'inert']) test(`legacy helper IMG preserves disabled rejection and diagnosis for ${attribute}`, () => {
  const f = fixture(); try {
    const trigger = legacyHelperImage(f); trigger.setAttribute(attribute, attribute === 'aria-disabled' ? 'true' : '');
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.equal(nativeRowMenuReason(f.resource('vm-a'), f.win), 'entry-disabled'); assert.deepEqual(f.counts.trigger, []);
  } finally { f.dispose(); }
});
for (const disabledDuplicate of [false, true]) test(`legacy helper IMG rejects duplicate triggers including disabled=${disabledDuplicate}`, () => {
  const f = fixture(); try {
    const trigger = legacyHelperImage(f), duplicate = trigger.cloneNode(true); if (disabledDuplicate) duplicate.setAttribute('aria-disabled', 'true'); trigger.parentElement.append(duplicate);
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.equal(nativeRowMenuReason(f.resource('vm-a'), f.win), 'trigger-ambiguous'); assert.deepEqual(f.counts.trigger, []);
  } finally { f.dispose(); }
});
test('legacy helper cannot borrow the sole IMG More from an inner resource row', () => {
  const f = fixture({ second: true }); try {
    const outer = f.rows.get('vm-a'), inner = f.rows.get('vm-b');
    outer.querySelector('.ant-dropdown-trigger').remove(); legacyHelperImage(f, 'vm-b');
    const table = f.doc.createElement('table'), body = f.doc.createElement('tbody'); table.append(body); body.append(inner); outer.querySelector('td[unique="_action_"]').append(table);
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false);
    assert.equal(nativeRowMenuReason(f.resource('vm-a'), f.win), 'trigger-missing');
    assert.deepEqual(f.counts.trigger, []); assert.equal(f.counts.row, 0);
    assert.equal(openNativeRowMenu(f.resource('vm-b'), f.win), true); assert.deepEqual(f.counts.trigger, ['vm-b']);
  } finally { f.dispose(); }
});
for (const column of ['name', 'path']) test(`legacy helper requires its own row ${column} cell rather than a nested table cell`, () => {
  const f = fixture(); try {
    const outer = f.rows.get('vm-a'), source = outer.querySelector('td[unique="name"]'); source.remove(); legacyHelperImage(f);
    const nested = f.doc.createElement('table'); nested.innerHTML = `<tbody><tr data-row-key="vm-a"><td unique="${column}">Nested resource</td></tr></tbody>`;
    // The inner row is deliberately unkeyed: even an element in a plain nested
    // table must not become the outer resource's identifying name/path cell.
    nested.querySelector('tr').removeAttribute('data-row-key'); outer.querySelector('td').prepend(nested);
    assert.equal(openNativeRowMenu({ type: 'vm', id: 'vm-a' }, f.win), false);
    assert.equal(nativeRowMenuReason({ type: 'vm', id: 'vm-a' }, f.win), 'source-changed'); assert.deepEqual(f.counts.trigger, []);
  } finally { f.dispose(); }
});
for (const className of ['is-disabled', 'ant-btn-loading']) test(`legacy helper IMG ${className} is diagnosed as disabled and never clicked`, () => {
  const f = fixture(); try {
    const trigger = legacyHelperImage(f); trigger.classList.add(className);
    assert.equal(openNativeRowMenu(f.resource('vm-a'), f.win), false); assert.equal(nativeRowMenuReason(f.resource('vm-a'), f.win), 'entry-disabled'); assert.deepEqual(f.counts.trigger, []); assert.equal(f.counts.row, 0);
  } finally { f.dispose(); }
});

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
