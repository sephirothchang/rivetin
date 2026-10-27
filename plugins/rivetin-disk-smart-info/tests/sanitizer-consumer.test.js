import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSmartOutput } from '../../../framework/server/smart-data.js';
import { validateSnapshot } from '../src/provider.js';
import { disks, mockIdentity } from '../demo/fixtures.js';

test('consumer reads actual shared sanitizer output with exact counters and health alerts', () => {
  const identity = mockIdentity(disks[0]), time = Date.parse('2026-10-28T00:00:00Z');
  const raw = { smartctl: { exit_status: 8 }, smart_status: { passed: false }, serial_number: 'SYNTHETIC-DO-NOT-PUBLISH',
    device: { name: '/dev/example', protocol: 'SCSI' }, power_on_time: { hours_s: '9007199254740993' }, power_cycle_count_s: '9007199254740994',
    scsi_grown_defect_list_s: '2', scsi_error_counter_log: { read: { total_uncorrected_errors_s: '9007199254740995' } },
    ata_smart_attributes: { table: [{ id: 5, name: 'arbitrary vendor text', value: 90, thresh: 5, raw: { value_s: '9007199254740996', string: 'untrusted vendor text' } }] } };
  const smart = sanitizeSmartOutput(JSON.stringify(raw), 8);
  assert.equal(smart.serial_number, undefined); assert.equal(smart.device.name, undefined);
  assert.equal(smart.ata_smart_attributes.table[0].name, 'Reallocated_Sector_Ct');
  assert.deepEqual(smart.ata_smart_attributes.table[0].raw, { value_s: '9007199254740996' });
  const result = validateSnapshot({ schemaVersion: 1, source: 'host-smartctl', identity, status: 'ok', collectedAt: new Date(time).toISOString(), smart }, identity, time);
  for (const [id, value] of [['power_on_hours', '9007199254740993'], ['power_cycles', '9007199254740994'], ['scsi_read_errors', '9007199254740995'], ['ata:5', '9007199254740996']]) assert.equal(result.metrics.find(item => item.id === id).value, value);
  assert.equal(result.risk, 'darkred'); assert.equal(result.metrics.find(item => item.id === 'health').value, '0');
});
