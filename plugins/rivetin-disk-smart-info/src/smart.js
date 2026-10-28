// Interpret documented JSON fields, without treating vendor raw values as universal units.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const short = value => typeof value === 'string' ? value.slice(0, 160) : '';
export function decimal(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && /^\d{1,40}$/.test(value)) return BigInt(value).toString();
  return null;
}
const exact = (parent, key) => decimal(parent?.[`${key}_s`]) ?? decimal(parent?.[key]);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const rank = { unknown: -1, normal: 0, yellow: 1, red: 2, darkred: 3 };
export const highestRisk = values => values.reduce((a, b) => rank[b] > rank[a] ? b : a, 'unknown');
const counters = new Map([
  ['Reallocated_Sector_Ct', 5], ['Reallocated_Event_Count', 196], ['Current_Pending_Sector', 197],
  ['Offline_Uncorrectable', 198], ['Reported_Uncorrect', 187], ['UDMA_CRC_Error_Count', 199],
]);
export function normalizeSmart(raw) {
  if (!object(raw)) throw new Error('INVALID_SMART_DOCUMENT');
  const exit = raw.smartctl?.exit_status;
  if (exit !== undefined && (!Number.isInteger(exit) || exit < 0 || exit > 255 || (exit & 7))) throw new Error('SMART_COLLECTION_FAILED');
  if (raw.smart_support?.available === false || raw.smart_support?.enabled === false) throw new Error('SMART_UNAVAILABLE');
  const metrics = [];
  function add(id, name, value, unit = '', extra = {}) {
    metrics.push({ id, name, value, unit, direction: null, risk: value === null ? 'unknown' : 'normal', reason: 'informational', ...extra });
  }
  if (typeof raw.smart_status?.passed === 'boolean' || (exit & 8)) {
    const passed = raw.smart_status?.passed === true && !(exit & 8);
    add('health', 'health', passed ? '1' : '0', '', { risk: passed ? 'normal' : 'darkred', reason: passed ? 'informational' : 'failed' });
  }
  if (exit & 16) add('ata_threshold_status', 'ata_threshold_status', '1', '', { risk: 'darkred', reason: 'threshold' });
  else if (exit & 32) add('ata_threshold_status', 'ata_threshold_status', '1', '', { risk: 'red', reason: 'historical' });
  if (exit & 128) add('self_test_errors', 'self_test_errors', '1', '', { risk: 'yellow', reason: 'historical' });
  if (finite(raw.temperature?.current) !== null) add('temperature', 'temperature', String(raw.temperature.current), '°C');
  if (raw.power_on_time?.hours !== undefined || raw.power_on_time?.hours_s !== undefined) add('power_on_hours', 'power_on_hours', exact(raw.power_on_time, 'hours'), 'h');
  if (raw.power_cycle_count !== undefined || raw.power_cycle_count_s !== undefined) add('power_cycles', 'power_cycles', exact(raw, 'power_cycle_count'));
  const nvme = raw.nvme_smart_health_information_log;
  if (object(nvme)) {
    for (const key of ['critical_warning', 'available_spare', 'percentage_used', 'media_errors', 'num_err_log_entries', 'unsafe_shutdowns', 'data_units_read', 'data_units_written', 'power_on_hours', 'power_cycles']) {
      if (nvme[key] === undefined && nvme[`${key}_s`] === undefined) continue;
      if (metrics.some(metric => metric.id === key)) continue;
      const value = exact(nvme, key), n = value === null ? null : BigInt(value);
      const extra = {};
      if (key === 'critical_warning' && n !== null) Object.assign(extra, { risk: n === 0n ? 'normal' : 'darkred', reason: n === 0n ? 'informational' : 'critical' });
      if (key === 'percentage_used' && n !== null) Object.assign(extra, { direction: 'up', risk: n >= 100n ? 'darkred' : n >= 90n ? 'red' : n >= 80n ? 'yellow' : 'normal', reason: n >= 80n ? 'endurance' : 'informational' });
      if (key === 'available_spare' && n !== null) {
        const threshold = exact(nvme, 'available_spare_threshold');
        Object.assign(extra, { direction: 'down', threshold, risk: threshold !== null && n < BigInt(threshold) ? 'darkred' : 'normal', reason: threshold !== null && n < BigInt(threshold) ? 'threshold' : 'informational' });
      }
      if (key === 'media_errors' && n !== null) Object.assign(extra, { direction: 'up', risk: n > 0n ? 'red' : 'normal', reason: n > 0n ? 'counter' : 'informational', counter: true });
      add(key, key, value, ['percentage_used', 'available_spare'].includes(key) ? '%' : key === 'power_on_hours' ? 'h' : '', extra);
    }
    if (!metrics.some(metric => metric.id === 'temperature') && finite(nvme.temperature) !== null) add('temperature', 'temperature', String(nvme.temperature), '°C');
  }
  const table = raw.ata_smart_attributes?.table;
  if (table !== undefined && (!Array.isArray(table) || table.length > 256)) throw new Error('INVALID_ATA_TABLE');
  const seen = new Set();
  for (const attribute of table || []) {
    if (!object(attribute) || !Number.isInteger(attribute.id) || attribute.id < 1 || attribute.id > 255 || seen.has(attribute.id)) throw new Error('INVALID_ATA_ATTRIBUTE');
    seen.add(attribute.id);
    const name = short(attribute.name) || `Attribute_${attribute.id}`, current = finite(attribute.value), threshold = finite(attribute.thresh);
    const value = exact(attribute.raw, 'value');
    const knownCounter = counters.get(name) === attribute.id;
    const failed = current !== null && threshold !== null && threshold > 0 && current <= threshold;
    const wasFailed = typeof attribute.when_failed === 'string' && !['', '-'].includes(attribute.when_failed.trim());
    let risk = value === null && current === null ? 'unknown' : 'normal', reason = 'vendor';
    if (failed || attribute.when_failed === 'now') { risk = 'darkred'; reason = 'threshold'; }
    else if (wasFailed) { risk = 'red'; reason = 'historical'; }
    else if (knownCounter && value !== null && BigInt(value) > 0n) { risk = name === 'UDMA_CRC_Error_Count' ? 'yellow' : 'red'; reason = 'counter'; }
    add(`ata:${attribute.id}`, name, value, '', { normalized: current, worst: finite(attribute.worst), threshold, rawText: short(attribute.raw?.string), direction: knownCounter ? 'up' : null, counter: knownCounter, risk, reason });
  }
  if (raw.scsi_grown_defect_list !== undefined || raw.scsi_grown_defect_list_s !== undefined) {
    const value = exact(raw, 'scsi_grown_defect_list');
    add('scsi_grown_defect_list', 'scsi_grown_defect_list', value, '', { direction: 'up', counter: true, risk: value === null ? 'unknown' : BigInt(value) > 0n ? 'red' : 'normal', reason: value !== null && BigInt(value) > 0n ? 'counter' : 'informational' });
  }
  for (const kind of ['read', 'write', 'verify']) {
    const parent = raw.scsi_error_counter_log?.[kind];
    if (!parent || (parent.total_uncorrected_errors === undefined && parent.total_uncorrected_errors_s === undefined)) continue;
    const value = exact(parent, 'total_uncorrected_errors');
    add(`scsi_${kind}_errors`, `scsi_${kind}_errors`, value, '', { direction: 'up', counter: true, risk: value === null ? 'unknown' : BigInt(value) > 0n ? 'red' : 'normal', reason: value !== null && BigInt(value) > 0n ? 'counter' : 'informational' });
  }
  if (!metrics.length) throw new Error('SMART_UNAVAILABLE');
  return { protocol: nvme ? 'NVMe' : table ? 'ATA' : ['ATA', 'NVMe', 'SCSI'].includes(raw.device?.protocol) ? raw.device.protocol : 'Unknown', metrics, exitStatus: exit ?? null };
}
export function compareMetrics(current, previous) {
  const before = new Map((previous || []).map(metric => [metric.id, metric]));
  return current.map(metric => {
    const prior = before.get(metric.id);
    let delta = null, deterioration = null, deteriorationKind = null, trend = 'no-baseline', risk = metric.risk, reason = metric.reason;
    if (prior && metric.name === prior.name && metric.value !== null && prior.value !== null && /^\d+$/.test(metric.value) && /^\d+$/.test(prior.value)) {
      const change = BigInt(metric.value) - BigInt(prior.value); delta = change.toString(); trend = change === 0n ? 'unchanged' : 'changed';
      if (metric.direction === 'up' && change < 0n) trend = 'counter-reset';
      else if (metric.direction && (metric.direction === 'up' ? change > 0n : change < 0n)) {
        deterioration = (change < 0n ? -change : change).toString(); trend = 'deteriorated';
        risk = highestRisk([risk, metric.counter && metric.risk === 'red' ? 'darkred' : 'yellow']);
        if (metric.risk !== 'darkred') reason = 'increased';
      }
    }
    if (prior?.name === metric.name && metric.normalized !== null && metric.normalized !== undefined && prior.normalized !== null && prior.normalized !== undefined && metric.normalized < prior.normalized) {
      trend = 'deteriorated'; deterioration = String(prior.normalized - metric.normalized); deteriorationKind = 'normalized'; risk = highestRisk([risk, 'yellow']);
      if (metric.risk !== 'darkred') reason = 'normalized';
    }
    return { ...metric, delta, deterioration, deteriorationKind, trend, risk, reason };
  });
}
