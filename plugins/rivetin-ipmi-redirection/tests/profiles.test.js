import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBmcProfile } from '../src/bmc-profiles.js';
import { sanitizePreferences } from '../src/preferences.js';
import { loadTowerInventory } from '../src/inventory.js';

const configured = () => sanitizePreferences({ defaultVendor: 'dell-idrac', bmcExceptions: [
  { id: 'cluster-rule', scope: 'cluster', targetId: 'cluster-a', vendor: 'lenovo-xclarity' },
  { id: 'host-rule', scope: 'host', targetId: 'host-b', vendor: 'ami-megarac' },
] });
test('host exception wins over cluster exception, then global default', () => {
  const p = configured();
  assert.equal(resolveBmcProfile(p, { hostId: 'host-b', clusterId: 'cluster-a', contextKnown: true }).vendor.id, 'ami-megarac');
  assert.equal(resolveBmcProfile(p, { hostId: 'host-a', clusterId: 'cluster-a', contextKnown: true }).vendor.id, 'lenovo-xclarity');
  assert.equal(resolveBmcProfile(p, { hostId: 'host-c', clusterId: 'cluster-other', contextKnown: true }).vendor.id, 'dell-idrac');
  assert.equal(resolveBmcProfile(p, { hostId: 'host-b' }).source, 'host');
});
test('unknown cluster membership cannot silently apply the global automatic-login adapter', () => {
  const result = resolveBmcProfile(configured(), { hostId: 'host-a' });
  assert.equal(result.ready, false); assert.equal(result.source, 'unknown');
});
test('profile sanitization rejects arbitrary vendors, credentials, duplicates and invalid targets', () => {
  const result = sanitizePreferences({ defaultVendor: 'arbitrary-script', bmcExceptions: [
    { id: 'one', scope: 'host', targetId: 'host-a', vendor: 'hpe-ilo', password: 'DO_NOT_STORE' },
    { id: 'two', scope: 'host', targetId: 'host-a', vendor: 'inspur-bmc' },
    { id: 'three', scope: 'host', targetId: 'https://untrusted.example', vendor: 'ami-megarac' },
  ] });
  assert.equal(result.defaultVendor, 'generic'); assert.equal(result.bmcExceptions.length, 1);
  assert.equal(result.bmcExceptions[0].vendor, 'hpe-ilo'); assert.ok(!JSON.stringify(result).includes('DO_NOT_STORE'));
});
test('inventory provider performs a bounded read-only metadata query with no credential fields', async () => {
  let request;
  const result = await loadTowerInventory({ query: async options => { request = options; return { data: { hosts: [], clusters: [] } }; } });
  assert.equal(request.query.definitions[0].operation, 'query');
  assert.ok(!JSON.stringify(request.query).match(/password|credential|token/i));
  assert.deepEqual(result, { hosts: [], clusters: [] });
});
