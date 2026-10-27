import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { identifyResource, nativeActions } from '../src/resources.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
function fixture(markup, view, sidebar) {
  const params = new URLSearchParams({ view: JSON.stringify(view) });
  if (sidebar) params.set('sidebar', JSON.stringify(sidebar));
  const dom = new JSDOM(markup, { url: `https://tower.example.invalid/#/hosts/host-a?${params}` });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  return dom;
}
for (const [view, column, type, name] of [['disks', 'path', 'disk', '/dev/sde'], ['vmVolumes', 'name', 'vmVolume', 'Data volume']]) test(`Tower ${view} uses its own row column and ID`, () => {
  const dom = fixture(`<table><tr data-row-key="resource-a"><td unique="${column}"><span id="target">${name}</span></td><td unique="host"><button id="relation">Host A</button></td></tr></table>`, view);
  try { const resource = identifyResource(dom.window.document.querySelector('#target'), dom.window); assert.equal(resource.type, type); assert.equal(resource.id, 'resource-a'); assert.equal(resource.name, name); assert.equal(identifyResource(dom.window.document.querySelector('#relation'), dom.window), null); } finally { dom.window.close(); }
});
test('a resource link inside another resource row retains its own identity', () => {
  const dom = fixture('<table><tr data-row-key="disk-a"><td unique="path">/dev/sde</td><td unique="host"><a id="target" href="#/hosts/host-b?view=%22detail%22">Host B</a></td></tr></table>', 'disks');
  try { const resource = identifyResource(dom.window.document.querySelector('#target'), dom.window); assert.equal(resource.type, 'host'); assert.equal(resource.id, 'host-b'); } finally { dom.window.close(); }
});
test('identical disk device names on different hosts never borrow another disk toolbar', () => {
  const dom = fixture('<table><tr data-row-key="disk-a"><td unique="path" id="target">/dev/sde</td></tr><tr data-row-key="disk-b"><td unique="path">/dev/sde</td></tr></table><aside class="frame"><div class="title-wrapper"><span class="header-title">/dev/sde</span></div><div class="toolbar"><button>卸载</button></div></aside>', 'disks', { type: 'disk', view: 'detail', id: 'disk-b' });
  try { const resource = identifyResource(dom.window.document.querySelector('#target'), dom.window); assert.deepEqual(nativeActions(resource, dom.window), []); } finally { dom.window.close(); }
});
test('virtual volume clone/export/delete remain native controls and deletion is visually marked', () => {
  const dom = fixture('<table><tr data-row-key="volume-a"><td unique="name" id="target">Data volume</td></tr></table><aside class="frame"><div class="title-wrapper"><span class="header-title">Data volume</span></div><div class="toolbar"><button>克隆</button><button>导出</button><button>删除</button></div></aside>', 'vmVolumes', { type: 'vmVolume', view: 'detail', id: 'volume-a' });
  try { const resource = identifyResource(dom.window.document.querySelector('#target'), dom.window), actions = nativeActions(resource, dom.window); assert.deepEqual(actions.map(action => action.label), ['克隆', '导出', '删除']); assert.equal(actions[2].danger, true); } finally { dom.window.close(); }
});
test('host main-page title and span-based more trigger have a strict header boundary', () => {
  const dom = fixture('<span><span class="title-wrapper"><span title="主机 Host A"><span class="title-text" id="target">Host A</span></span></span><span class="actions-wrapper"><button>编辑主机名</button><span class="more-icon ant-dropdown-trigger" id="more"><svg data-testid="MoreEllipsis316BoldSecondaryIcon"></svg></span></span></span><section><div class="title-wrapper"><span class="card-title-text" id="other">CPU</span></div><button>Unrelated</button></section>', 'detail');
  try { const resource = identifyResource(dom.window.document.querySelector('#target'), dom.window); assert.equal(resource.type, 'host'); assert.equal(resource.id, 'host-a'); const actions = nativeActions(resource, dom.window); assert.deepEqual(actions.map(action => action.label), ['编辑主机名', '更多操作…']); assert.equal(actions[1].button.id, 'more'); assert.equal(identifyResource(dom.window.document.querySelector('#other'), dom.window), null); } finally { dom.window.close(); }
});
