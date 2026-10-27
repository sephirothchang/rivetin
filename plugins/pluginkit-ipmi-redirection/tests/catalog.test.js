import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import catalog from '../data/hcl-catalog.json' with { type: 'json' };
import { BMC_VENDORS } from '../src/vendor-registry.js';
import { DEFAULTS, sanitizePreferences } from '../src/preferences.js';

test('catalog preserves all HCL record identities, model names and source hash without deduping models', async () => {
  const raw = await readFile(new URL('../research/smartx-servers-raw.json', import.meta.url));
  const source = JSON.parse(raw);
  assert.equal(catalog.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(catalog.recordCount, 158); assert.equal(catalog.brandCount, 29);
  assert.deepEqual(catalog.records.map(value => [value.id, value.brand, value.model]), source.data.map(value => [value.id, value.brand.name, value.name]));
  assert.equal(new Set(catalog.records.map(value => value.id)).size, 158);
  for (const record of catalog.records) assert.equal(BMC_VENDORS.find(value => value.id === record.vendorId)?.brand, record.brand);
});
test('protocol documentation and hardware validation are separate capabilities', () => {
  assert.equal(BMC_VENDORS.filter(value => value.api === 'redfish-session').length, 10);
  assert.equal(BMC_VENDORS.filter(value => value.brand).length, 29);
  assert.equal(new Set(BMC_VENDORS.map(value => value.id)).size, BMC_VENDORS.length);
  for (const vendor of BMC_VENDORS.filter(value => value.api === 'redfish-session')) {
    assert.equal(new URL(vendor.document).protocol, 'https:');
    assert.equal(vendor.simulatedAutoLogin, false); assert.equal(vendor.webLogin, 'direct');
  }
});
test('generic is the default while existing explicit choices survive migration', () => {
  assert.equal(DEFAULTS.defaultVendor, 'generic'); assert.equal(sanitizePreferences(null).defaultVendor, 'generic');
  assert.equal(sanitizePreferences({ defaultVendor: 'ami-megarac' }).defaultVendor, 'ami-megarac');
});
