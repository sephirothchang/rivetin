import { snapshotIsStale } from './snapshot.js';

const fail = () => { throw new Error('TOPOLOGY_DRAFT_NOT_ALLOWED'); };
const workload = purpose => ['workload', 'migration'].includes(purpose);
export function draftableSwitch(snapshot, id) {
  const sw = snapshot.switches.find(item => item.id === id);
  return !!sw && workload(sw.purpose) && sw.networks.every(net => workload(net.purpose));
}
// Intent list only. This module has no apply, network transport or rollback method.
export function createWorkspaceDraft(snapshot, now = () => Date.now()) {
  const networkTargets = new Map(), nicTargets = new Map();
  function allowed(fromId, toId) {
    if (!snapshot.complete || snapshotIsStale(snapshot, now()) || !draftableSwitch(snapshot, toId) || !draftableSwitch(snapshot, fromId)) fail();
  }
  return {
    reparent(networkId, targetId) {
      const parent = snapshot.switches.find(sw => sw.networks.some(net => net.id === networkId));
      if (!parent) fail(); allowed(parent.id, targetId);
      if (parent.id === targetId) networkTargets.delete(networkId); else networkTargets.set(networkId, targetId);
    },
    bindNic(nicId, targetId) {
      const nic = snapshot.nics.find(item => item.id === nicId);
      if (!nic) fail(); allowed(nic.switchId, targetId);
      if (nic.switchId === targetId) nicTargets.delete(nicId); else nicTargets.set(nicId, targetId);
    },
    changes() {
      return [
        ...[...networkTargets].map(([id, to]) => ({ kind: 'network', id, from: snapshot.switches.find(sw => sw.networks.some(net => net.id === id)).id, to })),
        ...[...nicTargets].map(([id, to]) => { const nic = snapshot.nics.find(item => item.id === id); return { kind: 'nic', id, hostId: nic.hostId, from: nic.switchId, to }; })
      ];
    },
    clear() { networkTargets.clear(); nicTargets.clear(); }
  };
}
