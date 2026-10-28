import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout } from '../src/layout.js';
import { createMockTopology } from '../src/mock.js';

test('layout remains independent, bounded, stable across parent changes and removes stale identities', () => {
  const topology = createMockTopology(), original = structuredClone(topology), layout = createLayout();
  layout.sync(topology); layout.set('network:net-production', 900, 700);
  const net = topology.switches.find(sw => sw.id === 'workload').networks.pop();
  topology.switches.find(sw => sw.id === 'migration').networks.push(net); layout.sync(topology);
  assert.deepEqual(layout.get('network:net-production'), { x: 900, y: 700 });
  layout.set('network:net-production', -500, 90000);
  assert.deepEqual(layout.get('network:net-production'), { x: 12, y: 6570 });
  assert.equal(original.switches.find(sw => sw.id === 'workload').networks[0].id, net.id);
  layout.sync(original); layout.reset(); layout.sync(original);
  assert.notDeepEqual(layout.get('network:net-production'), { x: 12, y: 6570 });
  layout.sync({ switches: [] }); assert.equal(layout.get('network:net-production'), null);
});
