import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockTopology } from '../src/mock.js';
import { assess, assignHostUplinks, CONFIRM_WINDOW_MS, createMockSession, MAX_NETWORKS, MAX_VDS, moveNic, validateInventory } from '../src/model.js';

test('network parent changes retain immutable facts, preflight VLANs and restore at the exact deadline', () => {
  let now = 0; const base = createMockTopology(), session = createMockSession(base, () => now);
  session.reparent('net-production', 'migration');
  assert.deepEqual(session.review().relations, [{ id: 'net-production', name: 'production-network', from: 'workload', to: 'migration' }]);
  assert.equal(session.review().operationCount, 1);
  assert.ok(session.review().risks.some(r => r.code === 'NETWORK_REPARENT'));
  assert.deepEqual(session.view().draft.nics, base.nics);
  assert.ok(session.view().draft.switches.find(sw => sw.id === 'migration').vlans.includes(110));
  session.reparent('net-production', 'workload');
  assert.equal(session.review().operationCount, 0);
  assert.deepEqual(session.view().draft.switches.find(sw => sw.id === 'migration').vlans, [210]);
  session.reparent('net-production', 'migration'); session.apply(true);
  assert.throws(() => session.reparent('net-production', 'workload'), /SESSION_LOCKED/);
  assert.throws(() => session.deleteCreated('vds', 'anything'), /SESSION_LOCKED/);
  now = 90_000; assert.throws(() => session.confirm(), /NO_PENDING/); assert.deepEqual(session.view().current, base);
  const invalid = structuredClone(base); invalid.nics.find(nic => nic.id === 'host-a-eth6').vlans = [210];
  const restricted = createMockSession(invalid); restricted.reparent('net-production', 'migration');
  assert.ok(restricted.review().risks.some(r => r.code === 'VLAN_MISMATCH')); assert.throws(() => restricted.apply(true), /RISK_BLOCKED/);
});

test('system parents and all existing networks resist relocation/deletion/forged metadata changes', () => {
  const session = createMockSession(createMockTopology()), base = session.view().draft;
  for (const id of ['net-management', 'net-default', 'net-storage', 'net-internal']) assert.throws(() => session.reparent(id, 'workload'), /PROTECTED_NETWORK/);
  for (const target of ['system', 'storage', 'internal']) assert.throws(() => session.reparent('net-production', target), /PROTECTED_NETWORK/);
  for (const [kind, id] of [['vds', 'workload'], ['vds', 'system'], ['network', 'net-production'], ['network', 'net-storage']]) assert.throws(() => session.deleteCreated(kind, id), /EXISTING_OBJECT/);
  const forged = structuredClone(base); forged.switches.find(sw => sw.id === 'workload').networks[0].vlan = 999;
  assert.throws(() => assess(base, forged), /IMMUTABLE_TOPOLOGY/); assert.deepEqual(session.view().draft, base);
});

test('deleting new VDS cancels its new children and uplinks, but refuses to cascade an existing network', () => {
  const base = createMockTopology(), session = createMockSession(base), created = session.createNetwork();
  session.move('host-a-eth8', created.switchId); session.reparent('net-production', created.switchId);
  const before = session.view().draft;
  assert.throws(() => session.deleteCreated('vds', created.switchId), /DELETE_REFERENCED_NETWORK/);
  assert.deepEqual(session.view().draft, before);
  session.reparent('net-production', 'workload'); session.deleteCreated('vds', created.switchId);
  assert.deepEqual(session.view().draft, base); assert.equal(session.review().operationCount, 0);
  const net = session.createNetwork('workload'); session.reparent(net.id, 'migration');
  assert.equal(session.review().creations.filter(c => c.kind === 'network').length, 1);
  assert.equal(session.review().relations.length, 0);
  session.deleteCreated('network', net.id); assert.deepEqual(session.view().draft, base);
  const vds = session.createVds(); session.apply(true); session.confirm();
  assert.throws(() => session.deleteCreated('vds', vds), /EXISTING_OBJECT/);
});

test('management, storage, shared default VM network and local bridge remain protected', () => {
  const base = createMockTopology();
  for (const id of ['host-a-eth0', 'host-a-eth1', 'host-a-eth2', 'host-a-eth3']) {
    for (const target of ['workload', 'migration', null]) assert.throws(() => moveNic(base, id, target), /PROTECTED_NETWORK/);
  }
  for (const target of ['system', 'storage', 'internal']) assert.throws(() => moveNic(base, 'host-a-eth4', target), /PROTECTED_NETWORK/);
  assert.throws(() => assignHostUplinks(base, 'host-a', 'workload', ['host-a-eth0']), /PROTECTED_NETWORK/);
  assert.deepEqual(base, createMockTopology());
});

test('untrusted role claims, metadata edits and missing inventory fail closed', () => {
  for (const mutate of [
    data => { data.complete = false; }, data => { data.switches[0].roles = ['workload']; },
    data => { data.switches[1].roles = ['workload']; }, data => { data.switches[4].networks[0].role = 'unknown'; },
    data => { data.switches[0].roles = []; }, data => { delete data.nics[4].vlans; },
    data => { data.nics[4].hostId = 'unknown'; }, data => { data.nics[1].id = data.nics[0].id; }
  ]) { const data = createMockTopology(); mutate(data); assert.throws(() => createMockSession(data)); }
  assert.throws(() => validateInventory({}), /INCOMPLETE_TOPOLOGY/);
  const base = createMockTopology();
  for (const mutate of [
    data => { data.nics[0].switchId = 'workload'; }, data => { data.nics[0].mtu = 1500; },
    data => { data.switches[1].roles = ['workload']; }, data => { data.hosts[0].name = 'other'; },
    data => { data.peers[0].name = 'other'; }, data => { data.nics.pop(); }, data => { data.revision++; }
  ]) { const draft = structuredClone(base); mutate(draft); assert.throws(() => assess(base, draft)); }
});

test('VDS uplink assignment is atomic and scoped to exactly one host, with no bulk swap API', () => {
  const base = createMockTopology(), draft = assignHostUplinks(base, 'host-a', 'workload', ['host-a-eth4', 'host-a-eth8']);
  assert.deepEqual(assess(base, draft).changes.map(c => c.nicId).sort(), ['host-a-eth5', 'host-a-eth8']);
  assert.deepEqual(base.nics.filter(n => n.hostId !== 'host-a'), draft.nics.filter(n => n.hostId !== 'host-a'));
  assert.deepEqual(base.nics.filter(n => ['system', 'storage'].includes(n.switchId)), draft.nics.filter(n => ['system', 'storage'].includes(n.switchId)));
  assert.equal(createMockSession(base).swap, undefined);
  assert.throws(() => assignHostUplinks(base, 'host-a', 'workload', ['host-b-eth8']), /CROSS_HOST_NIC/);
  assert.throws(() => assignHostUplinks(base, 'host-a', 'workload', ['host-a-eth8', 'host-a-eth8']), /CROSS_HOST_NIC/);
  assert.throws(() => assignHostUplinks(base, 'unknown', 'workload', []), /INVALID_IDENTITY/);
});

test('active-backup capacity does not sum active and standby; link/fabric risks remain distinct', () => {
  const base = createMockTopology();
  const single = moveNic(base, 'host-a-eth4', null), plan = assess(base, single);
  assert.ok(plan.risks.some(r => r.code === 'SINGLE_UPLINK'));
  assert.ok(!plan.risks.some(r => r.code === 'BANDWIDTH_DROP'));
  const slower = assignHostUplinks(base, 'host-a', 'workload', ['host-a-eth8']);
  assert.ok(assess(base, slower).risks.some(r => r.code === 'BANDWIDTH_DROP'));
  const sameFabric = assignHostUplinks(base, 'host-a', 'workload', ['host-a-eth4', 'host-a-eth8']);
  assert.ok(assess(base, sameFabric).risks.some(r => r.code === 'SINGLE_FABRIC'));
});

test('no active uplink, MTU and VLAN mismatches block applying but drafts can be repaired', () => {
  const base = createMockTopology(), empty = assignHostUplinks(base, 'host-a', 'workload', []);
  assert.ok(assess(base, empty).risks.some(r => r.code === 'NO_UPLINK'));
  assert.doesNotThrow(() => moveNic(empty, 'host-a-eth4', 'workload'));
  assert.ok(assess(base, moveNic(base, 'host-a-eth9', 'workload')).risks.some(r => r.code === 'MTU_MISMATCH'));
  const restricted = createMockTopology(); restricted.nics[8].vlans = [210];
  assert.ok(assess(restricted, moveNic(restricted, 'host-a-eth8', 'workload')).risks.some(r => r.code === 'VLAN_MISMATCH'));
  const down = createMockTopology(); down.nics[4].link = 'down'; down.nics[5].link = 'down'; down.nics[8].link = 'down';
  assert.ok(assess(down, moveNic(down, 'host-a-eth8', 'workload')).risks.some(r => r.code === 'NO_UPLINK'));
});

test('review does not apply; acknowledgement and current preflight required', () => {
  const session = createMockSession(createMockTopology());
  assert.throws(() => session.apply(true), /NO_CHANGES/);
  session.move('host-a-eth8', 'migration'); session.review();
  assert.deepEqual(session.view().current, createMockTopology());
  assert.throws(() => session.apply(false), /ACK_REQUIRED/);
  session.move('host-a-eth9', 'workload'); assert.throws(() => session.apply(true), /RISK_BLOCKED/);
  session.discard(); assert.equal(session.review().changes.length, 0);
});

test('exact 90 second deadline rejects late confirmation even when timer callbacks were suspended', () => {
  let now = 1000; const session = createMockSession(createMockTopology(), () => now);
  session.move('host-a-eth8', 'migration'); session.apply(true);
  assert.equal(session.view().deadline, 1000 + CONFIRM_WINDOW_MS); assert.equal(session.view().remaining, 90);
  now += 89_999; assert.equal(session.view().state, 'pending'); assert.equal(session.view().remaining, 1);
  now++; assert.throws(() => session.confirm(), /NO_PENDING_TRANSACTION/);
  assert.deepEqual(session.view().current, createMockTopology()); assert.equal(session.view().outcome, 'timeout');
});

test('confirmed baseline persists and is restored by the next expired transaction', () => {
  let now = 0; const session = createMockSession(createMockTopology(), () => now);
  session.assign('host-a', 'workload', ['host-a-eth4', 'host-a-eth8']); session.apply(true); now = 89_999; session.confirm();
  const committed = session.view().current; assert.equal(committed.revision, 2);
  session.move('host-b-eth8', 'migration'); session.apply(true); now += 95_000;
  assert.deepEqual(session.view().current, committed); assert.deepEqual(session.view().draft, committed);
});

test('pending locks editing, repeat apply, assignments and discard; manual cancel restores snapshot', () => {
  const session = createMockSession(createMockTopology()); session.move('host-a-eth8', 'migration'); session.apply(true);
  for (const call of [() => session.move('host-a-eth9', 'migration'), () => session.assign('host-a', 'workload', []), () => session.apply(true), () => session.discard()]) assert.throws(call, /SESSION_LOCKED/);
  session.cancel(); assert.deepEqual(session.view().current, createMockTopology());
  assert.throws(() => session.cancel(), /NO_PENDING_TRANSACTION/);
});

test('stop clears draft or restores pending and returns detached snapshots', () => {
  const inventory = createMockTopology(), session = createMockSession(inventory);
  inventory.switches[0].roles = ['workload']; session.view().draft.nics[0].switchId = 'workload';
  assert.throws(() => session.move('host-a-eth0', 'workload'), /PROTECTED_NETWORK/);
  session.move('host-a-eth8', 'migration'); session.apply(true); session.dispose(); session.dispose();
  assert.equal(session.view().state, 'stopped'); assert.deepEqual(session.view().current, createMockTopology());
  assert.deepEqual(session.view().draft, createMockTopology()); assert.throws(() => session.move('host-a-eth8', 'migration'), /SESSION_LOCKED/);
});

test('creating VDS and virtual network produces additive drafts with unique identities and a complete diff', () => {
  const session = createMockSession(createMockTopology());
  const vdsId = session.createVds(), network = session.createNetwork(vdsId);
  assert.equal(network.switchId, vdsId); assert.equal(session.view().current.switches.length, 5);
  assert.equal(session.view().draft.switches.length, 6); assert.equal(session.review().changes.length, 0);
  assert.equal(session.review().operationCount, 2);
  assert.deepEqual(session.review().creations.map(c => c.kind), ['vds', 'network']);
  assert.ok(session.review().risks.some(r => r.code === 'UNBOUND_VDS'));
  const second = session.createNetwork(); assert.notEqual(second.switchId, vdsId); assert.notEqual(second.id, network.id);
  assert.deepEqual(session.view().current, createMockTopology());
});

test('network creation on existing editable VDS preserves inventory and checks the new VLAN on every linked host', () => {
  const session = createMockSession(createMockTopology()), network = session.createNetwork('workload');
  assert.equal(session.view().draft.switches.length, 5);
  assert.equal(session.review().operationCount, 1); assert.equal(session.review().creations[0].vlan, 120);
  assert.deepEqual(session.view().draft.nics, createMockTopology().nics);
  session.configureCreated('network', network.id, { name: 'isolated-business', vlan: 400 });
  assert.equal(session.review().risks.filter(r => r.code === 'VLAN_MISMATCH').length, 3);
  assert.throws(() => session.apply(true), /RISK_BLOCKED/);
  session.configureCreated('network', network.id, { name: 'isolated-business', vlan: 120 });
  assert.equal(session.review().blocked, false);
});

test('creating on management, storage or local bridges fails atomically; forged creation cannot alter protected metadata', () => {
  const session = createMockSession(createMockTopology());
  for (const id of ['system', 'storage', 'internal']) assert.throws(() => session.createNetwork(id), /PROTECTED_NETWORK/);
  assert.deepEqual(session.view().draft, createMockTopology());
  const forged = structuredClone(session.view().draft);
  forged.switches[0].networks.push({ id: 'created-network-1', name: 'other', role: 'workload', vlan: 10 });
  assert.throws(() => assess(createMockTopology(), forged), /PROTECTED_NETWORK/);
  const vds = session.createVds(), candidate = session.view().draft;
  candidate.switches.find(sw => sw.id === vds).roles = ['management'];
  assert.throws(() => assess(createMockTopology(), candidate));
});

test('created-object settings reject duplicates, invalid VLAN/MTU and existing-object edits without damaging drafts', () => {
  const session = createMockSession(createMockTopology()), vds = session.createVds(), network = session.createNetwork(vds);
  const unchanged = session.view().draft;
  for (const settings of [{ name: 'VDS-Workload', mtu: 1500 }, { name: '<unsafe>', mtu: 1500 }, { name: 'valid', mtu: 9999 }]) assert.throws(() => session.configureCreated('vds', vds, settings));
  for (const settings of [{ name: 'production-network', vlan: 110 }, { name: 'valid', vlan: 0 }, { name: 'valid', vlan: 4095 }]) assert.throws(() => session.configureCreated('network', network.id, settings));
  assert.throws(() => session.configureCreated('vds', 'workload', { name: 'other', mtu: 1500 }), /IMMUTABLE_TOPOLOGY/);
  assert.deepEqual(session.view().draft, unchanged);
  session.configureCreated('vds', vds, { name: '新建业务交换机', mtu: 9000 });
  assert.equal(session.view().draft.switches.find(sw => sw.id === vds).name, '新建业务交换机');
});

test('creation-only transaction requires acknowledgement, expires after 90 seconds, and restores all nested objects', () => {
  let now = 0; const session = createMockSession(createMockTopology(), () => now);
  session.createNetwork(); assert.throws(() => session.apply(false), /ACK_REQUIRED/); session.apply(true);
  assert.equal(session.view().current.switches.length, 6); assert.equal(session.view().pendingPlan.operationCount, 2);
  assert.throws(() => session.createVds(), /SESSION_LOCKED/); assert.throws(() => session.createNetwork('workload'), /SESSION_LOCKED/);
  now = 90_000; assert.throws(() => session.confirm(), /NO_PENDING_TRANSACTION/);
  assert.deepEqual(session.view().current, createMockTopology()); assert.deepEqual(session.view().draft, createMockTopology());
});

test('new VDS can receive a single-host uplink; confirm retains creation, cancel and stop remove unconfirmed creations', () => {
  const session = createMockSession(createMockTopology()), vds = session.createVds();
  session.assign('host-a', vds, ['host-a-eth8']); assert.equal(session.review().operationCount, 2);
  session.apply(true); session.confirm(); const confirmed = session.view().current;
  assert.ok(confirmed.switches.some(sw => sw.id === vds)); assert.equal(confirmed.nics[8].switchId, vds);
  session.createNetwork(); session.apply(true); session.cancel(); assert.deepEqual(session.view().current, confirmed);
  session.createNetwork(); session.apply(true); session.dispose(); assert.deepEqual(session.view().current, confirmed);
});

test('bounded creation rejects an over-capacity parent+network batch with no partial object', () => {
  const session = createMockSession(createMockTopology());
  while (session.view().draft.switches.length < MAX_VDS) session.createVds();
  const before = session.view().draft;
  assert.throws(() => session.createNetwork(), /CAPACITY_EXCEEDED/);
  assert.deepEqual(session.view().draft, before);
});

test('virtual network count is bounded and reused VLANs are explicit risks', () => {
  const session = createMockSession(createMockTopology());
  while (session.view().draft.switches.flatMap(sw => sw.networks || []).length < MAX_NETWORKS) session.createNetwork('workload');
  assert.ok(session.review().risks.some(r => r.code === 'VLAN_REUSE'));
  const before = session.view().draft;
  assert.throws(() => session.createNetwork('workload'), /CAPACITY_EXCEEDED/);
  assert.deepEqual(session.view().draft, before);
});
