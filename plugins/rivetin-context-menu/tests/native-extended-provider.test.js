import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeActionProvider } from '../src/native/provider.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
function fixture(t) {
  const dom = new JSDOM('<aside class="drawer-content-inner frame" data-resource-id="vm-demo"><div class="title-wrapper"><span class="header-title">Demo VM</span></div><div class="toolbar"><button class="ant-dropdown-trigger" id="edit"><svg data-testid="EditPen16BlueIcon"></svg>编辑</button><button id="clone"><svg data-testid="Clone16GradientBlueIcon"></svg>克隆</button><button id="console"><svg data-testid="OpenTerminal16WhiteIcon"></svg>打开终端</button></div></aside>', { url: 'https://tower.example.invalid/#/vms/vm-demo?view=%22detail%22' });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 });
  let entries = 0, submissions = 0, clones = 0, consoles = 0;
  doc.querySelector('#edit').onclick = e => {
    const trigger = e.currentTarget, existing = doc.querySelector('.ant-dropdown');
    if (existing) { existing.remove(); trigger.classList.remove('ant-dropdown-open'); return; }
    trigger.classList.add('ant-dropdown-open');
    const menu = doc.createElement('div'); menu.className = 'ant-dropdown'; menu.innerHTML = '<ul role="menu"><li role="menuitem"><svg data-testid="EditPen24GradientBlueIcon"></svg>编辑高可用</li></ul>';
    menu.querySelector('li').onclick = () => {
      entries++; menu.remove(); trigger.classList.remove('ant-dropdown-open');
      const modal = doc.createElement('div'); modal.className = 'ant-modal'; modal.innerHTML = '<h2 class="ant-modal-title">编辑虚拟机高可用</h2><button>保存</button>';
      modal.querySelector('button').onclick = () => submissions++; doc.body.append(modal);
    }; doc.body.append(menu);
  };
  doc.querySelector('#clone').onclick = () => clones++; doc.querySelector('#console').onclick = () => consoles++;
  win.fetch = () => { throw new Error('NO_API_CALL'); };
  const provider = createNativeActionProvider({ win, timeoutMs: 500 });
  const resource = { type: 'vm', id: 'vm-demo' };
  function open(id) { assert.equal(provider.bindSource(doc.querySelector('.header-title')), true); return provider.open({ resource, actionId: id, data: provider.read(resource) }); }
  t.after(() => { provider.stop(); win.close(); });
  return { win, doc, provider, open, counts: () => ({ entries, submissions, clones, consoles }) };
}
test('HA shortcut proves its edit portal and opens the exact native dialog without submitting', async t => {
  const f = fixture(t); assert.deepEqual(await f.open('vm.availability.ha'), { status: 'opened', surface: 'dialog' });
  assert.deepEqual(f.counts(), { entries: 1, submissions: 0, clones: 0, consoles: 0 });
  assert.equal(f.doc.querySelector('.ant-dropdown'), null);
});
test('native direct action is explicitly a handoff, never a completed business result', async t => {
  const f = fixture(t); assert.deepEqual(await f.open('vm.clone'), { status: 'handed-off', surface: 'native-action' });
  assert.equal(f.counts().clones, 1); assert.equal(f.counts().submissions, 0);
});
test('console fails closed when browser activation has expired', async t => {
  const f = fixture(t); Object.defineProperty(f.win.navigator, 'userActivation', { value: { isActive: false } });
  assert.equal((await f.open('vm.console.open')).status, 'unsupported'); assert.equal(f.counts().consoles, 0);
});
test('an unrelated existing popup prevents both editor enumeration and leaf selection', async t => {
  const f = fixture(t); f.doc.body.insertAdjacentHTML('beforeend', '<div class="ant-dropdown">Other object</div>');
  assert.equal((await f.open('vm.availability.ha')).status, 'unsupported'); assert.equal(f.counts().entries, 0);
});
