import { validateHistorySmart } from './smart-history.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counters = ['critical_warning', 'available_spare', 'available_spare_threshold', 'percentage_used', 'media_errors', 'num_err_log_entries', 'unsafe_shutdowns', 'data_units_read', 'data_units_written', 'power_on_hours', 'power_cycles'];
const ataNames = { 5: 'Reallocated_Sector_Ct', 9: 'Power_On_Hours', 12: 'Power_Cycle_Count', 187: 'Reported_Uncorrect', 194: 'Temperature_Celsius', 196: 'Reallocated_Event_Count', 197: 'Current_Pending_Sector', 198: 'Offline_Uncorrectable', 199: 'UDMA_CRC_Error_Count' };
const count = (parent, key) => {
  const precise = parent?.[key + '_s'], value = parent?.[key];
  if (typeof precise === 'string' && /^\d{1,40}$/.test(precise)) return precise;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
};
const temperature = value => Number.isFinite(value) && value >= -100 && value <= 300;
const normalized = value => Number.isFinite(value) && value >= 0 && value <= 255;

// This capability publishes only a numeric SMART subset, never raw command text.
export function sanitizeSmartOutput(input, exitCode = 0, { expectedSerial } = {}) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 1024 * 1024 || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || exitCode & 7) throw new Error('SMART_OUTPUT_INVALID');
  let raw;
  try { raw = JSON.parse(input); } catch { throw new Error('SMART_OUTPUT_INVALID'); }
  if (!object(raw)) throw new Error('SMART_OUTPUT_INVALID');
  if (expectedSerial !== undefined && (typeof expectedSerial !== 'string' || !expectedSerial.length || raw.serial_number !== expectedSerial)) throw new Error('SMART_IDENTITY_MISMATCH');
  const reportedExit = raw.smartctl?.exit_status ?? exitCode;
  if (!Number.isInteger(reportedExit) || reportedExit < 0 || reportedExit > 255 || reportedExit & 7 || reportedExit !== exitCode) throw new Error('SMART_OUTPUT_INVALID');
  const safe = { smartctl: { exit_status: reportedExit } };
  if (object(raw.smart_support)) {
    const support = Object.fromEntries(['available', 'enabled'].filter(key => typeof raw.smart_support[key] === 'boolean').map(key => [key, raw.smart_support[key]]));
    if (Object.keys(support).length) safe.smart_support = support;
  }
  if (typeof raw.smart_status?.passed === 'boolean') safe.smart_status = { passed: raw.smart_status.passed };
  if (['ATA', 'NVMe', 'SCSI'].includes(raw.device?.protocol)) safe.device = { protocol: raw.device.protocol };
  if (temperature(raw.temperature?.current)) safe.temperature = { current: raw.temperature.current };
  const hours = count(raw.power_on_time, 'hours');
  if (hours !== undefined) safe.power_on_time = { hours_s: hours };
  const powerCycles = count(raw, 'power_cycle_count');
  if (powerCycles !== undefined) safe.power_cycle_count_s = powerCycles;
  if (object(raw.nvme_smart_health_information_log)) {
    const nvme = {};
    for (const key of counters) { const value = count(raw.nvme_smart_health_information_log, key); if (value !== undefined) nvme[key + '_s'] = value; }
    if (temperature(raw.nvme_smart_health_information_log.temperature)) nvme.temperature = raw.nvme_smart_health_information_log.temperature;
    safe.nvme_smart_health_information_log = nvme;
  }
  if (raw.ata_smart_attributes?.table !== undefined) {
    const table = raw.ata_smart_attributes.table, seen = new Set();
    if (!Array.isArray(table) || table.length > 256) throw new Error('SMART_OUTPUT_INVALID');
    safe.ata_smart_attributes = { table: table.map(attribute => {
      if (!object(attribute) || !Number.isInteger(attribute.id) || attribute.id < 1 || attribute.id > 255 || seen.has(attribute.id)) throw new Error('SMART_OUTPUT_INVALID');
      seen.add(attribute.id);
      const clean = { id: attribute.id, name: ataNames[attribute.id] || 'Attribute_' + attribute.id };
      for (const key of ['value', 'worst', 'thresh']) if (normalized(attribute[key])) clean[key] = attribute[key];
      if (['now', 'past', '', '-'].includes(attribute.when_failed)) clean.when_failed = attribute.when_failed;
      const rawValue = count(attribute.raw, 'value');
      if (rawValue !== undefined) clean.raw = { value_s: rawValue };
      return clean;
    }) };
  }
  const defects = count(raw, 'scsi_grown_defect_list');
  if (defects !== undefined) safe.scsi_grown_defect_list_s = defects;
  if (object(raw.scsi_error_counter_log)) {
    const scsi = {};
    for (const key of ['read', 'write', 'verify']) { const value = count(raw.scsi_error_counter_log[key], 'total_uncorrected_errors'); if (value !== undefined) scsi[key] = { total_uncorrected_errors_s: value }; }
    if (Object.keys(scsi).length) safe.scsi_error_counter_log = scsi;
  }
  if (safe.smart_support?.available === false || safe.smart_support?.enabled === false || ![
    safe.smart_status, safe.temperature, safe.power_on_time, safe.power_cycle_count_s, safe.scsi_grown_defect_list_s, safe.scsi_error_counter_log,
    safe.nvme_smart_health_information_log && Object.keys(safe.nvme_smart_health_information_log).length,
    safe.ata_smart_attributes?.table.length,
  ].some(Boolean)) throw new Error('SMART_UNSUPPORTED');
  return validateHistorySmart(safe);
}

export function smartFailureCode(code) {
  if (code === 'SMART_IDENTITY_MISMATCH') return code;
  if (['SSH_EXECUTION_TIMEOUT', 'SSH_BATCH_TIMEOUT'].includes(code)) return 'SMART_EXECUTION_TIMEOUT';
  if (['SSH_EXECUTION_CANCELLED', 'SSH_APPROVAL_REVOKED'].includes(code)) return 'SMART_EXECUTION_CANCELLED';
  if (code === 'SSH_DEVICE_IDENTITY_MISMATCH') return 'SMART_IDENTITY_MISMATCH';
  if (code === 'SMART_UNSUPPORTED') return code;
  if (['SSH_RESULT_INVALID', 'SMART_OUTPUT_INVALID'].includes(code)) return 'SMART_OUTPUT_INVALID';
  return 'SMART_COLLECTION_FAILED';
}
