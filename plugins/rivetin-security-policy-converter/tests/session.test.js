import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
const ready = () => { const session = createSession(); session.activate(); session.sample(); session.run(); return session; };

test('review and results are invalidated by every input and mapping change', () => {
  for (const patch of [{ clusterId: 'new-cluster' }, { inventoryText: '[]' }, { trafficText: '' }, { externalText: '' }, { columnMap: { srcIp: 1 } }]) {
    const session = ready(); session.review(true); assert.ok(session.export()); session.set(patch);
    assert.equal(session.view().result, null); assert.equal(session.view().reviewed, false); assert.throws(() => session.export());
  }
});
test('saved label key change invalidates candidates; identical settings do not', () => {
  const session = ready(); session.review(true); session.configure('application'); assert.ok(session.export());
  session.configure('service'); assert.equal(session.view().result, null); assert.throws(() => session.export());
});
test('stop and clear erase inputs and acknowledgement; disabled session cannot regenerate/export', () => {
  const session = ready(); session.review(true); session.stop(); session.sample(); session.run(); session.review(true);
  assert.equal(session.view().inventoryText, ''); assert.equal(session.view().result, null); assert.throws(() => session.export(), /PLUGIN_INACTIVE/);
  session.activate(); assert.equal(session.view().trafficText, ''); session.sample(); session.run(); session.review(true); session.clear(); assert.equal(session.view().result, null);
});
test('stale file reads cannot restore inputs after edits, a new import, or stop', () => {
  const session = ready(); const first = session.beginRead(); const second = session.beginRead();
  session.finishRead(first, 'trafficText', 'stale'); assert.notEqual(session.view().trafficText, 'stale');
  session.finishRead(second, 'trafficText', 'latest'); assert.equal(session.view().trafficText, 'latest');
  const third = session.beginRead(); session.set({ clusterId: 'changed' }); session.finishRead(third, 'inventoryText', 'stale'); assert.notEqual(session.view().inventoryText, 'stale');
  const fourth = session.beginRead(); session.stop(); session.activate(); session.finishRead(fourth, 'inventoryText', 'stale'); assert.equal(session.view().inventoryText, '');
});
test('input file replacement resets column mapping and bad input clears previous successful result', () => {
  const session = ready(); session.set({ columnMap: { srcIp: 2 } }); const ticket = session.beginRead(); session.finishRead(ticket, 'trafficText', 'bad');
  assert.deepEqual(session.view().columnMap, {}); session.run(); assert.equal(session.view().result, null); assert.equal(session.view().error, 'CSV_EMPTY');
});
