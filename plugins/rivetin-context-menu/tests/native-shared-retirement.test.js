import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeActionProvider } from '../src/native/provider.js';
import { createNativeRowMenuAdapter } from '../src/native/row-menu.js';
import { identifyResource } from '../src/resources.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
// Preserve the independent review regressions at the production entry boundaries.
const resource = {type:'vm',id:'vm-a',name:'Same name'};
const href = id => '#/clusters/cluster-a?view=%22vms%22&sidebar='+encodeURIComponent(JSON.stringify({type:'vm',id,view:'detail'}));
function fixture(t) {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td unique="name">Same name</td><td unique="_action_"><button class="menu-button ant-dropdown-trigger" title="More">More</button></td></tr></table>', {url:'https://tower.example.invalid/'+href('vm-a')});
  const win=dom.window, doc=win.document, callbacks=new Set(), counters={wrongMore:0,wrongLeaf:0,editor:0,disabledOpener:0,network:0};
  win.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden],.ant-dropdown-hidden')?[]:[this.getBoundingClientRect()];};
  win.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:220,bottom:120,width:200,height:100});
  win.fetch=()=>{counters.network++; throw Error('NO_TRANSPORT');};
  function pane() {
    doc.querySelector('.drawer-content-inner')?.remove();
    const p=doc.createElement('aside'); p.className='drawer-content-inner frame';p.dataset.resourceId='vm-a';
    p.innerHTML='<div class="title-wrapper"><span class="header-title">Same name</span></div><div class="detail-tabs"><button class="tab-item active">详情</button></div><div class="toolbar"></div><h3>基本信息<span class="extra-action"><button class="edit-icon">编辑</button></span></h3>';
    p.querySelector('.edit-icon').onclick=()=>{counters.editor++;const m=doc.createElement('div');m.className='ant-modal';m.innerHTML='<h2 class="ant-modal-title">编辑虚拟机</h2>';doc.body.append(m);};
    doc.body.append(p);return p;
  }
  pane();
  const row=doc.querySelector('tr'), source=doc.querySelector('td[unique="name"]'), trigger=doc.querySelector('.menu-button');
  const popup=doc.createElement('div');popup.className='ant-dropdown';popup.hidden=true;popup.id='row-popup';popup.innerHTML='<ul role="menu"><li role="menuitem">Edit</li></ul>';doc.body.append(popup);
  trigger.setAttribute('aria-controls',popup.id);
  function bindHandlers(owner) {
    trigger.onclick=()=>{if(owner==='b')counters.wrongMore++;popup.dataset.mockOwner=owner;popup.hidden=!popup.hidden;trigger.classList.toggle('ant-dropdown-open',!popup.hidden);};
    popup.querySelector('li').onclick=()=>{if(owner==='b')counters.wrongLeaf++;};
  }
  bindHandlers('a');
  const provider=createNativeActionProvider({win,timeoutMs:80,history:{listen(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}}});
  t.after(()=>{provider.stop();win.close();});
  function route(id){win.history.replaceState({},'',href(id));for(const cb of [...callbacks])cb();}
  function aba(){row.dataset.rowKey='vm-b';route('vm-b');bindHandlers('b');row.dataset.rowKey='vm-a';route('vm-a');pane();}
  function request(actionId, node=source){assert.equal(provider.bindSource(node),true);return {resource,actionId,data:provider.read(resource)};}
  return {win,doc,provider,counters,row,source,trigger,popup,aba,request,pane,bindHandlers};
}
test('retained list More after observed A-B-A must not open the old B handler',async t=>{
  const f=fixture(t);f.aba();
  const result=await f.provider.open(f.request('vm.power.menu'));
  assert.equal(f.counters.wrongMore,0,'old row More callback must be retired before click');
});
test('row adapter must not reuse retained popup leaf retired by active native provider',async t=>{
  const f=fixture(t);
  f.win.history.replaceState({},'','/#/hosts/host-b?view=%22detail%22');f.win.dispatchEvent(new f.win.Event('popstate'));f.bindHandlers('b');
  f.row.dataset.rowKey='host-a';f.win.history.replaceState({},'','/#/hosts');f.win.dispatchEvent(new f.win.Event('popstate'));
  assert.equal(identifyResource(f.source,f.win).type,'host');
  const adapter=createNativeRowMenuAdapter({win:f.win,identify:identifyResource,timeoutMs:80});t.after(()=>adapter.stop());
  const session=await adapter.prepare(identifyResource(f.source,f.win));
  const result=session?await session.execute(session.tree[0].id):null;
  assert.equal(f.counters.wrongLeaf,0,'a popup leaf retired by A-B-A must not execute');
});
test('ant-dropdown-disabled native toolbar opener must be rejected before click',async t=>{
  const f=fixture(t),opener=f.doc.createElement('span');opener.className='more-icon ant-dropdown-trigger ant-dropdown-disabled';opener.innerHTML='<svg data-testid="MoreEllipsis316BoldBlueIcon"></svg>更多';
  opener.onclick=()=>f.counters.disabledOpener++;f.doc.querySelector('.toolbar').append(opener);
  const result=await f.provider.open(f.request('vm.recycle.move',f.doc.querySelector('.header-title')));
  assert.equal(f.counters.disabledOpener,0,'disabled native opener must never receive synthetic click');
});
test('ant-btn-disabled native editor must be rejected before click',async t=>{
  const f=fixture(t);f.doc.querySelector('.edit-icon').classList.add('ant-btn-disabled');
  const result=await f.provider.open(f.request('vm.hardware.cpu',f.doc.querySelector('.header-title')));
  assert.equal(f.counters.editor,0,'disabled native editor must never receive synthetic click');
});
test('positive control: fresh exact editor opens once without transport',async t=>{
  const f=fixture(t);const result=await f.provider.open(f.request('vm.hardware.cpu',f.doc.querySelector('.header-title')));
  assert.equal(result.status,'opened');assert.equal(f.counters.editor,1);assert.equal(f.counters.network,0);
});

for (const className of ['ant-btn-disabled', 'ant-dropdown-disabled']) {
  for (const inherited of [false, true]) test(`native editor rejects ${inherited ? 'inherited ' : ''}${className}`, async t => {
    const f = fixture(t), editor = f.doc.querySelector('.edit-icon');
    (inherited ? editor.parentElement : editor).classList.add(className);
    const result = await f.provider.open(f.request('vm.hardware.cpu', f.doc.querySelector('.header-title')));
    assert.equal(result.reason, 'entry-disabled'); assert.equal(f.counters.editor, 0);
    assert.equal(f.counters.network, 0);
  });
  test(`disabled Details tab ${className} is never selected`, async t => {
    const f = fixture(t), tab = f.doc.querySelector('.tab-item'); let selected = 0;
    tab.classList.remove('active'); tab.classList.add(className); tab.onclick = () => selected++;
    const result = await f.provider.open(f.request('vm.hardware.cpu', f.doc.querySelector('.header-title')));
    assert.equal(result.reason, 'entry-disabled'); assert.equal(selected + f.counters.editor, 0);
  });
  test(`popup cleanup never clicks an opener that acquired ${className}`, async t => {
    const f = fixture(t), opener = f.doc.createElement('span');
    opener.className = 'more-icon ant-dropdown-trigger';
    opener.innerHTML = '<svg data-testid="MoreEllipsis316BoldBlueIcon"></svg>更多';
    opener.onclick = () => {
      f.counters.disabledOpener++;
      opener.classList.add('ant-dropdown-open', className);
      const popup = f.doc.createElement('div'); popup.className = 'ant-dropdown';
      popup.innerHTML = '<ul role="menu"><li role="menuitem">Other action</li></ul>'; f.doc.body.append(popup);
    };
    f.doc.querySelector('.toolbar').append(opener);
    const result = await f.provider.open(f.request('vm.recycle.move', f.doc.querySelector('.header-title')));
    assert.equal(result.status, 'unsupported'); assert.equal(f.counters.disabledOpener, 1);
    assert.equal(f.counters.network, 0);
  });
}

function freshHostMenu(f, { retiredLeaf = false } = {}) {
  const oldLeaf = f.popup.querySelector('li');
  f.win.history.replaceState({}, '', '/#/hosts/host-b?view=%22detail%22');
  f.win.dispatchEvent(new f.win.Event('popstate'));
  f.bindHandlers('b');
  f.win.history.replaceState({}, '', '/#/hosts'); f.win.dispatchEvent(new f.win.Event('popstate'));
  const row = f.doc.createElement('tr'); row.dataset.rowKey = 'host-a';
  row.innerHTML = '<td unique="name">Fresh host</td><td unique="_action_"><button class="menu-button ant-dropdown-trigger" title="More">More</button></td>';
  f.row.replaceWith(row);
  const trigger = row.querySelector('button'), popup = f.doc.createElement('div');
  popup.className = 'ant-dropdown'; popup.hidden = true; popup.id = 'fresh-host-popup';
  popup.innerHTML = '<ul role="menu"><li role="menuitem">Edit</li></ul>';
  if (retiredLeaf) popup.firstChild.replaceChildren(oldLeaf);
  let leafClicks = 0;
  if (!retiredLeaf) popup.querySelector('li').onclick = () => leafClicks++;
  trigger.setAttribute('aria-controls', popup.id);
  trigger.onclick = () => { popup.hidden = !popup.hidden; trigger.classList.toggle('ant-dropdown-open', !popup.hidden); };
  f.doc.body.append(popup);
  return { resource: identifyResource(row.querySelector('td'), f.win), popup, get leafClicks() { return leafClicks; } };
}

test('genuinely fresh host row and popup remain usable across prepare, close and reopen', async t => {
  const f = fixture(t), host = freshHostMenu(f);
  const adapter = createNativeRowMenuAdapter({ win: f.win, timeoutMs: 80 }); t.after(() => adapter.stop());
  const session = await adapter.prepare(host.resource);
  assert.ok(session); assert.equal(host.popup.hidden, true); assert.equal(host.leafClicks, 0);
  assert.equal((await session.execute(session.tree[0].id)).status, 'handed-off');
  assert.equal(host.leafClicks, 1); assert.equal(f.counters.wrongLeaf + f.counters.wrongMore + f.counters.network, 0);
});

test('a retired leaf moved into a fresh host popup cannot regain trust', async t => {
  const f = fixture(t), host = freshHostMenu(f, { retiredLeaf: true }), reasons = [];
  const adapter = createNativeRowMenuAdapter({ win: f.win, timeoutMs: 80 }); t.after(() => adapter.stop());
  const session = await adapter.prepare(host.resource, { onFailure: reason => reasons.push(reason) });
  assert.equal(session, null); assert.deepEqual(reasons, ['source-retired']);
  assert.equal(f.counters.wrongLeaf + f.counters.wrongMore + f.counters.network, 0);
});

test('a safe owned selection preserves the exact list row More when host creates a fresh A pane',async t=>{
  const dom=new JSDOM('<table><tr data-row-key="vm-a"><td unique="name">VM A</td><td unique="_action_"><button class="menu-button ant-dropdown-trigger" title="More">More</button></td></tr></table>',{url:'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22'});
  const win=dom.window,doc=win.document,callbacks=new Set(),counts={navigate:0,more:0};
  win.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];};
  win.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:220,bottom:120,width:200,height:100});
  const source=doc.querySelector('td[unique="name"]'),trigger=doc.querySelector('button');
  source.onclick=()=>{
    counts.navigate++;win.history.replaceState({},'','/#/clusters/cluster-a?view=%22vms%22&sidebar='+encodeURIComponent(JSON.stringify({type:'vm',id:'vm-a',view:'detail'})));
    const pane=doc.createElement('aside');pane.className='drawer-content-inner frame';pane.dataset.resourceId='vm-a';pane.innerHTML='<div class="title-wrapper"><span class="header-title">VM A</span></div><div class="detail-tabs"><button class="tab-item active">详情</button></div>';doc.body.append(pane);
    for(const cb of callbacks)cb();
  };
  trigger.onclick=()=>{counts.more++;trigger.classList.add('ant-dropdown-open');const popup=doc.createElement('div');popup.className='ant-dropdown';popup.innerHTML='<ul role="menu"><li role="menuitem">Edit</li></ul>';doc.body.append(popup);};
  const provider=createNativeActionProvider({win,timeoutMs:80,history:{listen(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}}});t.after(()=>{provider.stop();win.close();});
  const resource={type:'vm',id:'vm-a',name:'VM A'};assert.equal(provider.bindSource(source),true);
  const result=await provider.open({resource,actionId:'vm.power.menu',data:provider.read(resource)});
  assert.equal(counts.navigate,1);assert.equal(counts.more,1);assert.equal(result.status,'handed-off');
});
