import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { identifyResource } from '../src/resources.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const roots = [['vms', 'vm'], ['hosts', 'host'], ['vm-volumes', 'vmVolume'], ['disks', 'disk']];

function fixture(t, hash, { id = 'resource-a', inPane = false } = {}) {
  // The observed global list has separate header/body tables and plain name
  // cells. A resource anchor must not hide a failure of route identification.
  const table = `<div class="ant-table-wrapper"><div class="ant-table-container"><div class="ant-table-header"><table><thead><tr><th>名称</th><th>状态</th></tr></thead></table></div><div class="ant-table-body"><table><tbody><tr data-row-key="${id}"><td unique="name"><span id="target">Example resource</span></td><td unique="status">RUNNING</td></tr></tbody></table></div></div></div>`;
  const dom = new JSDOM(inPane ? `<aside class="drawer-content-inner">${table}</aside>` : table, { url: 'https://tower.example.invalid/' + hash });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  t.after(() => dom.window.close());
  return { win: dom.window, source: dom.window.document.getElementById('target') };
}

for (const [root, type] of roots) for (const slash of ['', '/']) for (const query of ['', '?sort=%22name%22', '?view=%22detail%22']) {
  test(`plain ${root}${slash}${query} list row retains its exact resource type and ID`, t => {
    const f = fixture(t, `#/${root}${slash}${query}`), resource = identifyResource(f.source, f.win);
    assert.equal(resource?.type, type); assert.equal(resource.id, 'resource-a');
    assert.equal(resource.select, f.source.closest('td')); assert.equal(resource.href, null);
  });
}

for (const [root] of roots) for (const path of [`/${root}//`, `/${root}/resource-a/`, `/prefix/${root}/`, `/${root}-future/`]) {
  test(`unknown or extended path ${path} does not acquire a global-list identity`, t => {
    const f = fixture(t, '#' + path);
    assert.equal(identifyResource(f.source, f.win), null);
  });
}

for (const [root] of roots) for (const id of ['', 'wrong/id', 'wrong id']) {
  test(`${root}/ does not admit malformed row identity ${JSON.stringify(id)}`, t => {
    const f = fixture(t, `#/${root}/`, { id });
    assert.equal(identifyResource(f.source, f.win), null);
  });
}

for (const [view, type] of [['vms', 'vm'], ['hosts', 'host'], ['vmVolumes', 'vmVolume'], ['disks', 'disk']]) {
  test(`existing cluster view=${view} semantics are preserved`, t => {
    const f = fixture(t, '#/clusters/cluster-a?view=' + encodeURIComponent(JSON.stringify(view)));
    assert.equal(identifyResource(f.source, f.win)?.type, type);
  });
}

test('a child table inside the VM pane cannot inherit the global VM-list route', t => {
  const side = encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' }));
  const f = fixture(t, '#/vms/?sidebar=' + side, { id: 'other-resource', inPane: true });
  assert.equal(identifyResource(f.source, f.win), null);
});
