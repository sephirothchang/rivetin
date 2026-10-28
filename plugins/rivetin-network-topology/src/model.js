export const CONFIRM_WINDOW_MS = 90_000;
export const MAX_VDS = 20;
export const MAX_NETWORKS = 80;
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw new Error(code); };
const knownRoles = new Set(['management', 'storage', 'workload', 'migration', 'backup']);
const validName = name => typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 64 && !/[<>\u0000-\u001f\u007f]/.test(name);
const allNetworks = topology => topology.switches.flatMap(sw => sw.networks || []);
const union = values => [...new Set(values)];
export const protectedSwitch = sw => sw.roles.some(role => ['management', 'storage'].includes(role));
export const lockedSwitch = sw => protectedSwitch(sw) || sw.uplinkEditable === false;

export function validateInventory(topology) {
  if (!topology || topology.complete !== true || !Number.isSafeInteger(topology.revision) ||
      !Array.isArray(topology.switches) || !topology.switches.length || !Array.isArray(topology.hosts) || !topology.hosts.length || !Array.isArray(topology.nics)) fail('INCOMPLETE_TOPOLOGY');
  const unique = items => items.every(item => typeof item.id === 'string' && item.id.length > 0) && new Set(items.map(item => item.id)).size === items.length;
  if (![topology.switches, topology.hosts, topology.nics].every(unique)) fail('INVALID_IDENTITY');
  const vlans = values => Array.isArray(values) && values.length > 0 && values.every(v => Number.isInteger(v) && v >= 1 && v <= 4094);
  for (const sw of topology.switches) {
    if (!Array.isArray(sw.roles) || !sw.roles.length || sw.roles.some(role => !knownRoles.has(role)) ||
        !Number.isInteger(sw.mtu) || sw.mtu < 1500 || !vlans(sw.vlans)) fail('UNKNOWN_NETWORK_ROLE');
    if (sw.networks && (!Array.isArray(sw.networks) || sw.networks.some(net => !knownRoles.has(net.role) ||
        (['management', 'storage'].includes(net.role) && !sw.roles.includes(net.role))))) fail('UNKNOWN_NETWORK_ROLE');
  }
  if (!unique(allNetworks(topology))) fail('INVALID_IDENTITY');
  for (const nic of topology.nics) {
    if (!topology.hosts.some(host => host.id === nic.hostId) ||
        (nic.switchId !== null && !topology.switches.some(sw => sw.id === nic.switchId)) ||
        !Number.isInteger(nic.mtu) || nic.mtu < 1500 || !Number.isFinite(nic.speed) || nic.speed <= 0 ||
        !['A', 'B'].includes(nic.fabric) || !['up', 'down'].includes(nic.link) || !vlans(nic.vlans)) fail('INCOMPLETE_TOPOLOGY');
  }
  for (const host of topology.hosts) {
    if (!topology.nics.some(nic => nic.hostId === host.id)) fail('INCOMPLETE_TOPOLOGY');
    for (const sw of topology.switches.filter(protectedSwitch)) {
      if (!topology.nics.some(nic => nic.hostId === host.id && nic.switchId === sw.id)) fail('INCOMPLETE_TOPOLOGY');
    }
  }
}

// Existing network identity/facts are immutable; only editable parent associations may change.
// Validate against the transaction baseline, never against a partially modified draft.
export function validateCandidate(before, after) {
  validateInventory(before);
  if (!after || !same({ ...before, nics: after.nics, switches: after.switches }, after) || !same(before.hosts, after.hosts) ||
      after.complete !== true || after.revision !== before.revision || !Array.isArray(after.nics) || after.nics.length !== before.nics.length) fail('IMMUTABLE_TOPOLOGY');
  validateInventory(after);
  if (after.switches.length > MAX_VDS || allNetworks(after).length > MAX_NETWORKS) fail('CAPACITY_EXCEEDED');
  if (after.switches.length < before.switches.length) fail('IMMUTABLE_TOPOLOGY');
  const originalsById = new Map(allNetworks(before).map(net => [net.id, net]));
  for (const net of originalsById.values()) {
    if (!same(net, allNetworks(after).find(item => item.id === net.id))) fail('IMMUTABLE_TOPOLOGY');
  }
  for (const [index, original] of before.switches.entries()) {
    const sw = after.switches[index];
    if (lockedSwitch(original)) { if (!same(original, sw)) fail('PROTECTED_NETWORK'); continue; }
    const networks = sw.networks || [], originals = original.networks || [];
    if (!same({ ...original, networks: sw.networks, vlans: sw.vlans }, sw)) fail('IMMUTABLE_TOPOLOGY');
    const additions = networks.filter(net => !originals.some(item => item.id === net.id));
    if (!same(sw.vlans, union([...original.vlans, ...additions.map(net => net.vlan)]))) fail('IMMUTABLE_TOPOLOGY');
  }
  const newSwitches = after.switches.slice(before.switches.length);
  for (const sw of newSwitches) {
    if (Object.keys(sw).sort().join() !== 'bridge,id,mtu,name,networks,roles,vlans' || !/^created-vds-[1-9]\d*$/.test(sw.id) ||
        sw.bridge !== `ovsbr-demo-${sw.id.slice(12)}` || !validName(sw.name) || !same(sw.roles, ['workload']) ||
        ![1500, 9000].includes(sw.mtu) || !Array.isArray(sw.networks) || !same(sw.vlans, union([110, ...sw.networks.map(net => net.vlan)]))) fail('INVALID_CREATION');
  }
  const previousNames = new Set(before.switches.map(sw => sw.name.toLowerCase()));
  for (const sw of newSwitches) { if (previousNames.has(sw.name.toLowerCase())) fail('DUPLICATE_NAME'); previousNames.add(sw.name.toLowerCase()); }
  const previousNetworkNames = new Set(allNetworks(before).map(net => net.name.toLowerCase()));
  for (const net of allNetworks(after).filter(net => !originalsById.has(net.id))) {
    if (Object.keys(net).sort().join() !== 'id,name,role,vlan' || !/^created-network-[1-9]\d*$/.test(net.id) ||
        !validName(net.name) || net.role !== 'workload' || !Number.isInteger(net.vlan) || net.vlan < 1 || net.vlan > 4094) fail('INVALID_CREATION');
    if (previousNetworkNames.has(net.name.toLowerCase())) fail('DUPLICATE_NAME');
    previousNetworkNames.add(net.name.toLowerCase());
  }
  const protectedIds = new Set(before.switches.filter(lockedSwitch).map(sw => sw.id));
  const seen = new Set();
  for (const nic of after.nics) {
    const original = before.nics.find(item => item.id === nic.id);
    if (!original || seen.has(nic.id)) fail('INVALID_IDENTITY');
    seen.add(nic.id);
    if (!same({ ...original, switchId: nic.switchId }, nic)) fail('IMMUTABLE_NIC_FACTS');
    if (nic.switchId !== null && !after.switches.some(sw => sw.id === nic.switchId)) fail('UNKNOWN_SWITCH');
    if ((protectedIds.has(original.switchId) || protectedIds.has(nic.switchId)) && original.switchId !== nic.switchId) fail('PROTECTED_NETWORK');
  }
}

export function assess(before, after) {
  validateCandidate(before, after);
  const changes = after.nics.flatMap(nic => {
    const old = before.nics.find(item => item.id === nic.id);
    return old.switchId === nic.switchId ? [] : [{ nicId: nic.id, hostId: nic.hostId, from: old.switchId, to: nic.switchId }];
  });
  const risks = [];
  const creations = [];
  const relations = [];
  for (const sw of after.switches) {
    const original = before.switches.find(item => item.id === sw.id);
    if (!original) creations.push({ kind: 'vds', id: sw.id, name: sw.name });
    for (const net of sw.networks || []) {
      const parent = before.switches.find(item => item.networks?.some(old => old.id === net.id));
      if (!parent) creations.push({ kind: 'network', id: net.id, name: net.name, switchId: sw.id, vlan: net.vlan });
      else if (parent.id !== sw.id) relations.push({ id: net.id, name: net.name, from: parent.id, to: sw.id });
    }
  }
  const add = (level, code, hostId = null, switchId = null) => risks.push({ level, code, hostId, switchId });
  if (changes.length) add('warning', 'INTERRUPTION');
  if (relations.length) add('warning', 'NETWORK_REPARENT');
  if (creations.length) add('warning', 'CREATE_OBJECTS');
  for (const creation of [...creations, ...relations.map(item => ({ kind: 'network', switchId: item.to, vlan: allNetworks(after).find(net => net.id === item.id).vlan }))]) {
    const switchId = creation.kind === 'vds' ? creation.id : creation.switchId;
    if (!after.nics.some(nic => nic.switchId === switchId && nic.link === 'up') && !risks.some(risk => risk.code === 'UNBOUND_VDS' && risk.switchId === switchId)) add('warning', 'UNBOUND_VDS', null, switchId);
    if (creation.kind === 'network' && after.switches.find(sw => sw.id === switchId).networks.filter(net => net.vlan === creation.vlan).length > 1) add('warning', 'VLAN_REUSE', null, switchId);
  }
  for (const sw of after.switches.filter(sw => !lockedSwitch(sw))) for (const host of before.hosts) {
    const hostNics = after.nics.filter(n => n.hostId === host.id && n.switchId === sw.id);
    const networkAdded = creations.some(c => c.kind === 'network' && c.switchId === sw.id) || relations.some(c => c.to === sw.id);
    if (!changes.some(c => c.hostId === host.id && [c.from, c.to].includes(sw.id)) && !(networkAdded && hostNics.length)) continue;
    const old = before.nics.filter(n => n.hostId === host.id && n.switchId === sw.id && n.link === 'up');
    const active = after.nics.filter(n => n.hostId === host.id && n.switchId === sw.id && n.link === 'up');
    if (!active.length) add('blocker', 'NO_UPLINK', host.id, sw.id);
    if (active.length === 1) add('warning', 'SINGLE_UPLINK', host.id, sw.id);
    // active-backup has one forwarding member; summing links would overstate capacity.
    if (Math.max(0, ...old.map(n => n.speed)) > Math.max(0, ...active.map(n => n.speed))) add('warning', 'BANDWIDTH_DROP', host.id, sw.id);
    if (active.length > 1 && new Set(active.map(n => n.fabric)).size < 2) add('warning', 'SINGLE_FABRIC', host.id, sw.id);
    if (active.some(n => n.mtu < sw.mtu)) add('blocker', 'MTU_MISMATCH', host.id, sw.id);
    if (active.some(n => sw.vlans.some(vlan => !n.vlans.includes(vlan)))) add('blocker', 'VLAN_MISMATCH', host.id, sw.id);
  }
  return { changes, creations, relations, operationCount: changes.length + creations.length + relations.length, risks, blocked: risks.some(r => r.level === 'blocker') };
}

function recomputeVlans(baseline, topology) {
  for (const sw of topology.switches.filter(sw => !lockedSwitch(sw))) {
    const original = baseline.switches.find(item => item.id === sw.id);
    const incoming = sw.networks.filter(net => !original?.networks?.some(item => item.id === net.id));
    sw.vlans = union([...(original?.vlans || [110]), ...incoming.map(net => net.vlan)]);
  }
  return topology;
}

function reparentNetwork(baseline, topology, id, switchId) {
  const next = copy(topology), source = next.switches.find(sw => sw.networks?.some(net => net.id === id));
  const target = next.switches.find(sw => sw.id === switchId);
  if (!source || !target) fail('INVALID_IDENTITY');
  if (lockedSwitch(source) || lockedSwitch(target)) fail('PROTECTED_NETWORK');
  if (source.id !== target.id) {
    const net = source.networks.find(net => net.id === id);
    source.networks = source.networks.filter(net => net.id !== id); target.networks.push(net);
  }
  recomputeVlans(baseline, next); validateCandidate(baseline, next); return next;
}

function deleteCreated(baseline, topology, kind, id) {
  const next = copy(topology);
  if (kind === 'vds') {
    const sw = next.switches.find(sw => sw.id === id);
    if (!sw || baseline.switches.some(sw => sw.id === id)) fail('EXISTING_OBJECT');
    if (lockedSwitch(sw)) fail('PROTECTED_NETWORK');
    if (sw.networks.some(net => allNetworks(baseline).some(old => old.id === net.id))) fail('DELETE_REFERENCED_NETWORK');
    next.switches = next.switches.filter(sw => sw.id !== id);
    // Undo draft assignments to the removed VDS; never detach real/baseline uplinks.
    for (const nic of next.nics.filter(nic => nic.switchId === id)) nic.switchId = baseline.nics.find(old => old.id === nic.id).switchId;
  } else if (kind === 'network') {
    const parent = next.switches.find(sw => sw.networks?.some(net => net.id === id));
    if (!parent || allNetworks(baseline).some(net => net.id === id)) fail('EXISTING_OBJECT');
    if (lockedSwitch(parent)) fail('PROTECTED_NETWORK');
    parent.networks = parent.networks.filter(net => net.id !== id);
  } else fail('INVALID_CREATION');
  recomputeVlans(baseline, next); validateCandidate(baseline, next); return next;
}

function nextId(items, prefix) {
  let number = 1; while (items.some(item => item.id === `${prefix}${number}`)) number++;
  return `${prefix}${number}`;
}
function nextName(items, prefix) {
  let number = 1; while (items.some(item => item.name.toLowerCase() === `${prefix}${String(number).padStart(2, '0')}`.toLowerCase())) number++;
  return `${prefix}${String(number).padStart(2, '0')}`;
}
export function createVdsDraft(topology) {
  const next = copy(topology), id = nextId(next.switches, 'created-vds-');
  next.switches.push({ id, name: nextName(next.switches, 'VDS-Custom-'), bridge: `ovsbr-demo-${id.slice(12)}`, roles: ['workload'], mtu: 1500, vlans: [110], networks: [] });
  validateCandidate(topology, next); return { topology: next, id };
}
export function createNetworkDraft(topology, switchId = null) {
  const created = switchId === null ? createVdsDraft(topology) : { topology: copy(topology), id: switchId };
  const next = created.topology, sw = next.switches.find(item => item.id === created.id);
  if (!sw) fail('UNKNOWN_SWITCH');
  if (lockedSwitch(sw)) fail('PROTECTED_NETWORK');
  const networks = allNetworks(next), id = nextId(networks, 'created-network-');
  const used = new Set((sw.networks || []).map(net => net.vlan));
  const connected = next.nics.filter(n => n.switchId === sw.id && n.link === 'up');
  const preferred = union([...sw.vlans, 110, 120, 210]);
  const vlan = preferred.find(value => !used.has(value) && connected.every(nic => nic.vlans.includes(value))) || sw.vlans[0];
  sw.networks = [...(sw.networks || []), { id, name: nextName(networks, 'vm-network-'), role: 'workload', vlan }];
  sw.vlans = union([...sw.vlans, vlan]);
  validateCandidate(topology, next); return { topology: next, id, switchId: sw.id };
}

function configureCreatedDraft(baseline, topology, kind, id, settings) {
  const next = copy(topology);
  if (kind === 'vds') {
    if (baseline.switches.some(sw => sw.id === id) || Object.keys(settings).sort().join() !== 'mtu,name') fail('IMMUTABLE_TOPOLOGY');
    const sw = next.switches.find(item => item.id === id); if (!sw) fail('UNKNOWN_SWITCH');
    Object.assign(sw, settings);
  } else if (kind === 'network') {
    if (allNetworks(baseline).some(net => net.id === id) || Object.keys(settings).sort().join() !== 'name,vlan') fail('IMMUTABLE_TOPOLOGY');
    const sw = next.switches.find(sw => sw.networks?.some(net => net.id === id)); if (!sw) fail('INVALID_IDENTITY');
    Object.assign(sw.networks.find(net => net.id === id), settings);
  } else fail('INVALID_CREATION');
  recomputeVlans(baseline, next); validateCandidate(baseline, next); return next;
}

export function moveNic(topology, nicId, switchId) {
  const next = copy(topology), nic = next.nics.find(n => n.id === nicId);
  if (!nic) fail('UNKNOWN_NIC');
  nic.switchId = switchId;
  validateCandidate(topology, next);
  return next;
}

export function assignHostUplinks(topology, hostId, switchId, nicIds) {
  if (!topology.hosts.some(host => host.id === hostId) || !topology.switches.some(sw => sw.id === switchId)) fail('INVALID_IDENTITY');
  if (lockedSwitch(topology.switches.find(sw => sw.id === switchId))) fail('PROTECTED_NETWORK');
  if (!Array.isArray(nicIds) || new Set(nicIds).size !== nicIds.length || nicIds.some(id => !topology.nics.some(nic => nic.id === id && nic.hostId === hostId))) fail('CROSS_HOST_NIC');
  const next = copy(topology);
  for (const nic of next.nics.filter(nic => nic.hostId === hostId)) {
    if (nicIds.includes(nic.id)) nic.switchId = switchId;
    else if (nic.switchId === switchId) nic.switchId = null;
  }
  validateCandidate(topology, next);
  return next;
}

export function createMockSession(inventory, now = () => Date.now()) {
  validateInventory(inventory);
  let current = copy(inventory), draft = copy(inventory), snapshot = null, deadline = null, state = 'editing', outcome = 'initial';
  const rollback = reason => { current = copy(snapshot); draft = copy(snapshot); snapshot = null; deadline = null; state = 'editing'; outcome = reason; };
  const tick = () => { if (state === 'pending' && now() >= deadline) rollback('timeout'); };
  const editable = () => { tick(); if (state !== 'editing') fail('SESSION_LOCKED'); };
  const api = {
    view() { tick(); return copy({ current, draft, state, deadline, outcome, pendingPlan: snapshot ? assess(snapshot, current) : null, remaining: deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now()) / 1000)) }); },
    move(nicId, switchId) { editable(); const next = moveNic(draft, nicId, switchId); validateCandidate(current, next); draft = next; outcome = 'draft'; },
    assign(hostId, switchId, nicIds) { editable(); const next = assignHostUplinks(draft, hostId, switchId, nicIds); validateCandidate(current, next); draft = next; outcome = 'draft'; },
    createVds() { editable(); const result = createVdsDraft(draft); recomputeVlans(current, result.topology); validateCandidate(current, result.topology); draft = result.topology; outcome = 'draft'; return result.id; },
    createNetwork(switchId = null) { editable(); const result = createNetworkDraft(draft, switchId); recomputeVlans(current, result.topology); validateCandidate(current, result.topology); draft = result.topology; outcome = 'draft'; return { id: result.id, switchId: result.switchId }; },
    configureCreated(kind, id, settings) { editable(); draft = configureCreatedDraft(current, draft, kind, id, settings); outcome = 'draft'; },
    reparent(id, switchId) { editable(); draft = reparentNetwork(current, draft, id, switchId); outcome = 'draft'; },
    deleteCreated(kind, id) { editable(); draft = deleteCreated(current, draft, kind, id); outcome = 'draft'; },
    review() { editable(); return assess(current, draft); },
    discard() { editable(); draft = copy(current); outcome = 'discarded'; },
    apply(acknowledged) {
      editable(); const plan = assess(current, draft);
      if (!plan.operationCount) fail('NO_CHANGES');
      if (plan.blocked) fail('RISK_BLOCKED');
      if (acknowledged !== true) fail('ACK_REQUIRED');
      snapshot = copy(current); current = copy(draft); deadline = now() + CONFIRM_WINDOW_MS; state = 'pending'; outcome = 'applied';
    },
    confirm() {
      tick(); if (state !== 'pending') fail('NO_PENDING_TRANSACTION');
      current.revision++; draft = copy(current); snapshot = null; deadline = null; state = 'editing'; outcome = 'confirmed';
    },
    cancel() { tick(); if (state !== 'pending') fail('NO_PENDING_TRANSACTION'); rollback('cancelled'); },
    tick,
    dispose() { tick(); if (state === 'pending') rollback('stopped'); draft = copy(current); state = 'stopped'; }
  };
  return api;
}
