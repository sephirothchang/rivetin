import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSmart, compareMetrics, decimal } from '../src/smart.js';
import { sample, disks } from '../demo/fixtures.js';
const metric = (raw, id) => normalizeSmart(raw).metrics.find(item => item.id === id);
test('NVMe endurance policy boundaries and missing values remain distinguishable', () => {
  for (const [value, risk] of [[0, 'normal'], [79, 'normal'], [80, 'yellow'], [89, 'yellow'], [90, 'red'], [99, 'red'], [100, 'darkred'], [150, 'darkred'], [null, 'unknown']]) {
    assert.equal(metric({ nvme_smart_health_information_log: { percentage_used: value } }, 'percentage_used').risk, risk);
  }
});
test('critical warning, health failure and device threshold override a passing health flag', () => {
  assert.equal(metric({ smart_status: { passed: false } }, 'health').risk, 'darkred');
  assert.equal(metric({ smartctl: { exit_status: 8 }, smart_status: { passed: true } }, 'health').risk, 'darkred');
  assert.equal(metric({ smartctl: { exit_status: 16 } }, 'ata_threshold_status').risk, 'darkred');
  assert.equal(metric({ smartctl: { exit_status: 32 } }, 'ata_threshold_status').risk, 'red');
  assert.equal(metric({ nvme_smart_health_information_log: { critical_warning: 4 } }, 'critical_warning').risk, 'darkred');
  assert.equal(metric({ nvme_smart_health_information_log: { available_spare: 9, available_spare_threshold: 10 } }, 'available_spare').risk, 'darkred');
});
test('JSON unsafe integers use exact decimal string, never rounded number', () => {
  const previous = normalizeSmart({ nvme_smart_health_information_log: { media_errors: 9007199254740992, media_errors_s: '9007199254740993' } });
  const current = normalizeSmart({ nvme_smart_health_information_log: { media_errors_s: '9007199254740997' } });
  assert.equal(compareMetrics(current.metrics, previous.metrics)[0].deterioration, '4');
  assert.equal(decimal(9007199254740992), null); assert.equal(decimal('1e8'), null); assert.equal(decimal('-2'), null);
});
test('ATA risk requires recognized name and ID, not arbitrary vendor raw number', () => {
  const raw = sample(disks[1]).smart;
  assert.equal(metric(raw, 'ata:5').risk, 'red');
  assert.equal(metric(raw, 'ata:1').risk, 'normal');
  raw.ata_smart_attributes.table[0].name = 'Vendor_Opaque';
  assert.equal(metric(raw, 'ata:5').risk, 'normal');
  raw.ata_smart_attributes.table[0].value = 8;
  assert.equal(metric(raw, 'ata:5').risk, 'darkred');
});
test('delta, wear deterioration and reset are distinct', () => {
  const current = normalizeSmart(sample(disks[0], 0).smart).metrics;
  const previous = normalizeSmart(sample(disks[0], 1).smart).metrics;
  const result = compareMetrics(current, previous);
  assert.equal(result.find(item => item.id === 'percentage_used').deterioration, '1');
  assert.equal(result.find(item => item.id === 'media_errors').risk, 'darkred');
  const reset = compareMetrics(previous, current).find(item => item.id === 'media_errors');
  assert.equal(reset.trend, 'counter-reset'); assert.equal(reset.deterioration, null);
  assert.equal(compareMetrics(current, [])[0].delta, null);
});
test('ATA normalized decline is reported in normalized points, not vendor raw units', () => {
  const raw = sample(disks[1]).smart, previous = normalizeSmart(raw).metrics;
  raw.ata_smart_attributes.table[3].value = 85;
  const changed = compareMetrics(normalizeSmart(raw).metrics, previous).find(item => item.id === 'ata:1');
  assert.equal(changed.deterioration, '3'); assert.equal(changed.reason, 'normalized'); assert.equal(changed.risk, 'yellow');
});
test('SCSI uncorrected errors and defect counters have explicit risk', () => {
  const raw = { device: { protocol: 'SCSI' }, scsi_grown_defect_list: 2, scsi_error_counter_log: { read: { total_uncorrected_errors: 1 }, write: { total_uncorrected_errors: 0 } } };
  const value = normalizeSmart(raw); assert.equal(value.protocol, 'SCSI');
  assert.equal(value.metrics.find(item => item.id === 'scsi_read_errors').risk, 'red');
  assert.equal(value.metrics.find(item => item.id === 'scsi_write_errors').risk, 'normal');
});
test('command failure, unsupported, malformed and duplicate attributes fail closed', () => {
  for (const code of [1, 2, 4, 9]) assert.throws(() => normalizeSmart({ smartctl: { exit_status: code }, smart_status: { passed: true } }), /COLLECTION_FAILED/);
  assert.throws(() => normalizeSmart({ smart_support: { available: false }, smart_status: { passed: true } }), /UNAVAILABLE/);
  assert.throws(() => normalizeSmart({}), /UNAVAILABLE/);
  const raw = sample(disks[1]).smart; raw.ata_smart_attributes.table.push(raw.ata_smart_attributes.table[0]);
  assert.throws(() => normalizeSmart(raw), /INVALID_ATA_ATTRIBUTE/);
});
test('sanitized s-only counters preserve exact values across ATA, NVMe and SCSI', () => {
  const raw = { device: { protocol: 'SCSI' }, power_on_time: { hours_s: '9007199254740993' }, power_cycle_count_s: '9007199254740994',
    scsi_grown_defect_list_s: '2', scsi_error_counter_log: { read: { total_uncorrected_errors_s: '9007199254740995' } } };
  const result = normalizeSmart(raw);
  for (const [id, value] of [['power_on_hours', '9007199254740993'], ['power_cycles', '9007199254740994'], ['scsi_grown_defect_list', '2'], ['scsi_read_errors', '9007199254740995']]) assert.equal(result.metrics.find(item => item.id === id).value, value);
  const ata = normalizeSmart({ ata_smart_attributes: { table: [{ id: 5, name: 'Reallocated_Sector_Ct', value: 100, thresh: 1, raw: { value_s: '9007199254740996' } }] } });
  assert.equal(ata.metrics[0].value, '9007199254740996'); assert.equal(ata.metrics[0].risk, 'red');
  const nvme = normalizeSmart({ nvme_smart_health_information_log: { media_errors_s: '9007199254740997' } });
  assert.equal(nvme.metrics[0].value, '9007199254740997');
});
