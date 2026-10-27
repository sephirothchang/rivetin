import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSmartOutput, smartFailureCode } from '../server/smart-data.js';

test('SMART sanitization preserves exact counters and health flags but removes all identities and opaque text', () => {
  const value = sanitizeSmartOutput(JSON.stringify({ serial_number: 'EXAMPLE_SERIAL', model_name: 'EXAMPLE_MODEL', password: 'EXAMPLE_FORBIDDEN',
    smartctl: { exit_status: 8, messages: ['EXAMPLE_FORBIDDEN'] }, smart_status: { passed: false }, temperature: { current: 40 },
    nvme_smart_health_information_log: { media_errors_s: '1234567890123456789012345678901234567890', power_cycles: 3, arbitrary: 'EXAMPLE_FORBIDDEN' } }), 8, { expectedSerial: 'EXAMPLE_SERIAL' });
  assert.deepEqual(value, { smartctl: { exit_status: 8 }, smart_status: { passed: false }, temperature: { current: 40 }, nvme_smart_health_information_log: { media_errors_s: '1234567890123456789012345678901234567890', power_cycles_s: '3' } });
  assert.ok(!JSON.stringify(value).includes('EXAMPLE_'));
});

test('ATA vendor names and raw strings become fixed field names and numeric strings only', () => {
  const value = sanitizeSmartOutput(JSON.stringify({ smartctl: { exit_status: 0 }, ata_smart_attributes: { table: [
    { id: 5, name: 'EXAMPLE_FORBIDDEN', value: 90, worst: 89, thresh: 10, when_failed: 'now', raw: { value_s: '12345678901234567890', string: 'EXAMPLE_FORBIDDEN' } },
    { id: 1, name: 'EXAMPLE_FORBIDDEN', value: 200, raw: { value: 4 } }, { id: 9, name: 'Power_On_Hours', raw: { value: 1234 } },
  ] } }));
  assert.deepEqual(value.ata_smart_attributes.table.map(row => row.name), ['Reallocated_Sector_Ct', 'Attribute_1', 'Power_On_Hours']);
  assert.equal(value.ata_smart_attributes.table[0].raw.value_s, '12345678901234567890'); assert.ok(!JSON.stringify(value).includes('EXAMPLE_'));
});

test('unsafe numeric values are omitted while exact decimal companions retain their precision', () => {
  const value = sanitizeSmartOutput(JSON.stringify({ smart_status: { passed: true }, power_cycle_count: 9007199254740992, power_on_time: { hours_s: '9999999999999999999999999' },
    nvme_smart_health_information_log: { media_errors: 9007199254740992, data_units_written_s: '8888888888888888888888888' } }));
  assert.equal(value.power_cycle_count_s, undefined); assert.equal(value.nvme_smart_health_information_log.media_errors_s, undefined);
  assert.equal(value.power_on_time.hours_s, '9999999999999999999999999');
});

test('unsupported, malformed, oversized, unsafe status and mismatched physical identity fail safely', () => {
  for (const input of ['{', 'null', '[]', JSON.stringify({ temperature: { current: 50 }, smartctl: { exit_status: 2 } }), JSON.stringify({ ata_smart_attributes: { table: [{ id: 5 }, { id: 5 }] } }), 'x'.repeat(1024 * 1024 + 1)]) assert.throws(() => sanitizeSmartOutput(input), /SMART_OUTPUT_INVALID/);
  for (const raw of [{}, { device: { protocol: 'ATA' } }, { ata_smart_attributes: { table: [] } }, { nvme_smart_health_information_log: { ignored: 1 } }, { smart_support: { available: false }, temperature: { current: 35 } }]) assert.throws(() => sanitizeSmartOutput(JSON.stringify(raw)), /SMART_UNSUPPORTED/);
  assert.throws(() => sanitizeSmartOutput(JSON.stringify({ serial_number: 'OTHER_DEVICE', smart_status: { passed: true } }), 0, { expectedSerial: 'EXPECTED_DEVICE' }), /SMART_IDENTITY_MISMATCH/);
  assert.throws(() => sanitizeSmartOutput(JSON.stringify({ smartctl: { exit_status: 8 }, smart_status: { passed: false } }), 0), /SMART_OUTPUT_INVALID/);
});

test('SCSI fields remain bounded numeric subsets and failure messages never survive as codes', () => {
  const value = sanitizeSmartOutput(JSON.stringify({ device: { protocol: 'SCSI', path: '/dev/sda' }, scsi_grown_defect_list: 2, scsi_error_counter_log: { read: { total_uncorrected_errors_s: '3', token: 'EXAMPLE_FORBIDDEN' } } }));
  assert.deepEqual(value.scsi_error_counter_log, { read: { total_uncorrected_errors_s: '3' } }); assert.equal(value.device.path, undefined);
  assert.equal(smartFailureCode('SSH_EXECUTION_TIMEOUT'), 'SMART_EXECUTION_TIMEOUT'); assert.equal(smartFailureCode('SSH_APPROVAL_REVOKED'), 'SMART_EXECUTION_CANCELLED');
  assert.equal(smartFailureCode('SSH_DEVICE_IDENTITY_MISMATCH'), 'SMART_IDENTITY_MISMATCH'); assert.equal(smartFailureCode('SMART_IDENTITY_MISMATCH'), 'SMART_IDENTITY_MISMATCH');
  assert.equal(smartFailureCode('EXAMPLE_REMOTE_PASSWORD_IS_NOT_A_CODE'), 'SMART_COLLECTION_FAILED');
});
