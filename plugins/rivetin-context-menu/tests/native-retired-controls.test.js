import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeActionProvider } from '../src/native/provider.js';

const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const resource = { type: 'vm', id: 'vm-a', name: 'Same VM name' };
const href = id => '#/vms/' + id + '?view=%22detail%22';

function fixture(t) {
  const dom = new JSDOM('<table><tbody><tr data-row-key="vm-a"><td unique="name">Same VM name</td><td unique="_action_"></td></tr><tr data-row-key="vm-b"><td unique="name">Other VM</td><td unique="_action_"></td></tr></tbody></table>', {
    url: 'https://tower.example.invalid/' + href('vm-a'),
  });
  const win = dom.window, doc = win.document, listeners = new Set();
  win.HTMLElement.prototype.getClientRects = () => [{ width: 180, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 310, height: 450, right: 320, bottom: 460 });
  const counts = { more: 0, business: 0, editor: 0, cleanupOther: 0, http: 0, submit: 0 };
  win.fetch = () => { counts.http++; throw new Error('NO_LIVE_TRANSPORT'); };
  function pane() {
    const node = doc.createElement('aside'); node.className = 'drawer-content-inner'; node.dataset.resourceId = resource.id;
    node.innerHTML = '<div class="title-wrapper"><span class="header-title">Same VM name</span></div><div class="detail-tabs"><button class="tab-item active" aria-selected="true">详情</button></div><div class="toolbar"></div><h3>基本信息<span class="extra-action"><button class="edit-icon">编辑</button></span></h3>';
    doc.querySelector('.drawer-content-inner')?.remove(); doc.body.append(node); return node;
  }
  let currentPane = pane();
  const provider = createNativeActionProvider({ win, timeoutMs: 100, history: { listen(fn) { listeners.add(fn); return () => listeners.delete(fn); } } });
  t.after(() => { provider.stop(); win.close(); });
  function route(id) { win.history.replaceState({}, '', href(id)); for (const fn of [...listeners]) fn(); }
  function popup(opener, item = null) {
    opener.classList.add('ant-dropdown-open');
    const node = doc.createElement('div'); node.className = 'ant-dropdown';
    node.innerHTML = '<ul role="menu"></ul>'; if (item) node.firstChild.append(item); doc.body.append(node); return node;
  }
  function editor() {
    const node = doc.createElement('button'); node.className = 'ant-dropdown-trigger';
    node.innerHTML = '<svg data-testid="EditPen16BlueIcon"></svg>编辑'; currentPane.querySelector('.toolbar').append(node); return node;
  }
  function request(actionId, source = currentPane.querySelector('.header-title')) {
    assert.equal(provider.bindSource(source), true, 'fixture must bind a fresh, exact A source');
    const data = provider.read(resource); assert.equal(data.native.canNavigate, true);
    return { resource, actionId, snapshot: data.snapshot };
  }
  return { win, doc, provider, counts, route, popup, editor, request,
    replace() { currentPane = pane(); return currentPane; },
    get pane() { return currentPane; },
  };
}

test('an ABA-retired row More trigger cannot regain trust by moving into a new exact A row', async t => {
  const f = fixture(t), oldMore = f.doc.createElement('button');
  oldMore.className = 'menu-button ant-dropdown-trigger'; oldMore.title = 'More'; oldMore.textContent = 'More'; f.pane.append(oldMore);
  oldMore.onclick = () => { f.counts.more++; f.popup(oldMore); };
  f.route('vm-b'); f.route('vm-a');
  f.doc.querySelector('tr[data-row-key="vm-a"] td[unique="_action_"]').append(oldMore);
  f.replace();
  const side = encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' }));
  f.win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22&sidebar=' + side);
  const source = f.doc.querySelector('tr[data-row-key="vm-a"] td[unique="name"]');
  const result = await f.provider.open(f.request('vm.power.menu', source));
  assert.equal(f.counts.more, 0, 'retired trigger must be checked before click, not after popup creation');
  assert.equal(result.status, 'unsupported'); assert.equal(f.doc.querySelector('.ant-dropdown'), null);
  assert.equal(f.counts.business + f.counts.http + f.counts.submit, 0);
});

test('popup cleanup does not click an opener after it moves from A into a different VM row', async t => {
  const f = fixture(t), opener = f.editor();
  opener.onclick = () => {
    f.counts.editor++; f.popup(opener);
    f.win.queueMicrotask(() => {
      f.doc.querySelector('tr[data-row-key="vm-b"] td[unique="_action_"]').append(opener);
      opener.onclick = () => f.counts.cleanupOther++;
    });
  };
  const result = await f.provider.open(f.request('vm.availability.ha'));
  assert.equal(f.counts.editor, 1, 'the fixture must first open the proven native A menu');
  assert.equal(f.counts.cleanupOther, 0, 'cleanup must revalidate opener ownership before its compensation click');
  assert.equal(result.status, 'unsupported'); assert.equal(f.doc.querySelector('.ant-modal'), null);
  assert.equal(f.counts.business + f.counts.http + f.counts.submit, 0);
});

test('a fresh submenu-title child cannot wash the retired menuitem ancestor that owns its callback', async t => {
  const f = fixture(t), hidden = f.doc.createElement('div'), oldItem = f.doc.createElement('li');
  hidden.className = 'ant-dropdown'; hidden.hidden = true; hidden.innerHTML = '<ul role="menu"></ul>';
  oldItem.setAttribute('role', 'menuitem'); hidden.firstChild.append(oldItem); f.doc.body.append(hidden);
  oldItem.onclick = () => {
    f.counts.business++;
    const modal = f.doc.createElement('section'); modal.className = 'ant-modal';
    modal.innerHTML = '<h2 class="ant-modal-title">编辑虚拟机高可用</h2><button>保存</button>';
    modal.querySelector('button').onclick = () => f.counts.submit++; f.doc.body.append(modal);
  };
  f.route('vm-b'); f.route('vm-a'); hidden.remove(); oldItem.remove();
  oldItem.className = 'ant-dropdown-menu-submenu';
  oldItem.innerHTML = '<div class="ant-dropdown-menu-submenu-title" role="button" aria-haspopup="true"><svg data-testid="EditPen24GradientBlueIcon"></svg>编辑高可用</div>';
  f.replace(); const opener = f.editor();
  opener.onclick = () => {
    if (opener.classList.contains('ant-dropdown-open')) { opener.classList.remove('ant-dropdown-open'); f.doc.querySelector('.ant-dropdown')?.remove(); return; }
    f.counts.editor++; f.popup(opener, oldItem);
  };
  const result = await f.provider.open(f.request('vm.availability.ha'));
  assert.equal(f.counts.editor, 1, 'a genuinely fresh native A opener should remain usable');
  assert.equal(f.counts.business, 0, 'trust must cover the menuitem ancestor, not just its new child');
  assert.equal(result.status, 'unsupported'); assert.equal(f.doc.querySelector('.ant-modal'), null);
  assert.equal(f.counts.http + f.counts.submit, 0);
});

test('queued real hashchange A-B-A events retire retained callbacks even when every listener sees final A', async t => {
  const f = fixture(t), oldEditor = f.pane.querySelector('.edit-icon'), transitions = [];
  oldEditor.onclick = () => { f.counts.business++; };
  f.win.addEventListener('hashchange', event => transitions.push({ old: event.oldURL, next: event.newURL, current: f.win.location.href }));
  f.win.location.hash = href('vm-b'); f.win.location.hash = href('vm-a');
  await new Promise(resolve => f.win.setTimeout(resolve, 30));
  assert.equal(transitions.length, 2, 'real queued hash events must actually run before the fresh bind');
  assert.ok(transitions.every(event => event.current.endsWith(href('vm-a'))));
  const source = f.pane.querySelector('.header-title');
  f.provider.bindSource(source); const data = f.provider.read(resource);
  const result = await f.provider.open({ resource, actionId: 'vm.hardware.cpu', snapshot: data.snapshot });
  assert.equal(f.counts.business, 0, 'sampling only final location must not restore an old callback');
  assert.ok(['unsupported', 'cancelled'].includes(result.status)); assert.equal(f.counts.http + f.counts.submit, 0);
});

test('plugin-owned hash navigation still permits genuinely new exact A pane and editor nodes', async t => {
  const f = fixture(t);
  f.win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22');
  const source = f.doc.querySelector('tr[data-row-key="vm-a"] td[unique="name"]');
  let navigation = 0;
  source.onclick = () => {
    navigation++; f.win.location.hash = href('vm-a');
    const fresh = f.replace();
    fresh.querySelector('.edit-icon').onclick = () => {
      f.counts.editor++;
      const modal = f.doc.createElement('section'); modal.className = 'ant-modal';
      modal.innerHTML = '<h2 class="ant-modal-title">编辑虚拟机</h2>'; f.doc.body.append(modal);
    };
  };
  const result = await f.provider.open(f.request('vm.hardware.cpu', source));
  await new Promise(resolve => f.win.setTimeout(resolve, 30));
  assert.equal(navigation, 1); assert.equal(result.status, 'opened'); assert.equal(f.counts.editor, 1);
  assert.equal(f.counts.business + f.counts.http + f.counts.submit, 0);
});

test('same-resource hash view refresh does not retire an unchanged exact A pane', async t => {
  const f = fixture(t), oldEditor = f.pane.querySelector('.edit-icon');
  oldEditor.onclick = () => {
    f.counts.editor++; const modal = f.doc.createElement('section'); modal.className = 'ant-modal';
    modal.innerHTML = '<h2 class="ant-modal-title">编辑虚拟机</h2>'; f.doc.body.append(modal);
  };
  f.win.location.hash = '#/vms/vm-a?view=%22overview%22';
  await new Promise(resolve => f.win.setTimeout(resolve, 30));
  const result = await f.provider.open(f.request('vm.hardware.cpu'));
  assert.equal(result.status, 'opened'); assert.equal(f.counts.editor, 1);
  assert.equal(f.pane.querySelector('.edit-icon'), oldEditor); assert.equal(f.counts.business + f.counts.http + f.counts.submit, 0);
});
