import path from 'node:path';
import { readFile, stat, unlink } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomic, storage } from './storage.js';
import { assertId } from '../shared/identity.js';

const DAY = 86400000, OPERATION = 'disk.smart.read', MAX_SMART = 512 * 1024;
export const SMART_HISTORY_LIMITS = Object.freeze({ maxDisks: 10000, maxGenerations: 20000, maxBytes: 2 * 1024 ** 3, maxRecordsPerDisk: 730 });
export const SMART_HISTORY_CODES = Object.freeze(['SMART_UNAVAILABLE', 'SMART_UNSUPPORTED', 'SMART_COLLECTION_FAILED', 'SMART_INVALID_DATA', 'SMART_DEVICE_CHANGED',
  'SMART_IDENTITY_MISMATCH', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID',
  'SSH_CHANNEL_DISABLED', 'SSH_APPROVAL_REQUIRED', 'SSH_APPROVAL_REVOKED', 'SSH_DEVICE_UNAVAILABLE', 'SSH_DEVICE_IDENTITY_MISMATCH', 'SSH_EXECUTION_FAILED',
  'SSH_EXECUTION_TIMEOUT', 'SSH_EXECUTION_CANCELLED', 'SSH_REMOTE_COMMAND_FAILED', 'SSH_RESULT_INVALID', 'SSH_TARGET_UNAVAILABLE', 'SSH_TRANSPORT_UNAVAILABLE']);
const codeSet = new Set(SMART_HISTORY_CODES), object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const generationId = value => hex(value) || typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('SMART_HISTORY_INVALID_DATA'); };
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const numeric = value => Number.isSafeInteger(value) && value >= 0;
const digits = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const attributeNames = new Map([[5, 'Reallocated_Sector_Ct'], [9, 'Power_On_Hours'], [12, 'Power_Cycle_Count'], [194, 'Temperature_Celsius'], [196, 'Reallocated_Event_Count'], [197, 'Current_Pending_Sector'], [198, 'Offline_Uncorrectable'], [187, 'Reported_Uncorrect'], [199, 'UDMA_CRC_Error_Count']]);
function counts(value, fields) {
  if (!exact(value, fields.flatMap(key => [key, key + '_s']))) fail();
  for (const [key, count] of Object.entries(value)) if (!(key.endsWith('_s') ? digits(count) : numeric(count))) fail();
}
function bools(value, fields) { if (!exact(value, fields) || Object.values(value).some(item => typeof item !== 'boolean')) fail(); }

// The caller strips raw output first. This second boundary accepts only documented,
// bounded SMART fields; arbitrary vendor strings and identity/secret fields never persist.
export function validateHistorySmart(value) {
  let nodes = 0;
  function plain(item, depth = 0) {
    if (++nodes > 10000 || depth > 8 || item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
        typeof item === 'number' && !Number.isFinite(item) || typeof item === 'string' && item.length > 128) fail();
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && !object(item)) fail();
      for (const child of Object.values(item)) plain(child, depth + 1);
    }
  }
  plain(value);
  const keys = ['smartctl', 'smart_support', 'smart_status', 'device', 'temperature', 'power_on_time', 'power_cycle_count', 'power_cycle_count_s',
    'nvme_smart_health_information_log', 'ata_smart_attributes', 'scsi_grown_defect_list', 'scsi_grown_defect_list_s', 'scsi_error_counter_log'];
  if (!exact(value, keys) || !Object.keys(value).length) fail();
  if (value.smartctl !== undefined && (!exact(value.smartctl, ['exit_status']) || !Number.isInteger(value.smartctl.exit_status) || value.smartctl.exit_status < 0 || value.smartctl.exit_status > 255 || (value.smartctl.exit_status & 7))) fail();
  if (value.smart_support !== undefined) bools(value.smart_support, ['available', 'enabled']);
  if (value.smart_status !== undefined) bools(value.smart_status, ['passed']);
  if (value.device !== undefined && (!exact(value.device, ['protocol']) || !['ATA', 'NVMe', 'SCSI'].includes(value.device.protocol))) fail();
  const temperature = item => typeof item === 'number' && Number.isFinite(item) && item >= -100 && item <= 300;
  if (value.temperature !== undefined && (!exact(value.temperature, ['current']) || !temperature(value.temperature.current))) fail();
  if (value.power_on_time !== undefined) counts(value.power_on_time, ['hours']);
  for (const key of ['power_cycle_count', 'scsi_grown_defect_list']) {
    if (value[key] !== undefined && !numeric(value[key])) fail();
    if (value[key + '_s'] !== undefined && !digits(value[key + '_s'])) fail();
  }
  const nvme = value.nvme_smart_health_information_log;
  if (nvme !== undefined) {
    if (!object(nvme)) fail();
    const { temperature: temp, ...rest } = nvme;
    counts(rest, ['critical_warning', 'available_spare', 'available_spare_threshold', 'percentage_used', 'media_errors', 'num_err_log_entries', 'unsafe_shutdowns', 'data_units_read', 'data_units_written', 'power_on_hours', 'power_cycles']);
    if (temp !== undefined && !temperature(temp)) fail();
  }
  if (value.ata_smart_attributes !== undefined) {
    if (!exact(value.ata_smart_attributes, ['table'])) fail();
    const table = value.ata_smart_attributes.table, seen = new Set();
    if (!Array.isArray(table) || table.length > 256) fail();
    for (const row of table) {
      if (!exact(row, ['id', 'name', 'value', 'worst', 'thresh', 'when_failed', 'raw']) || !Number.isInteger(row.id) || row.id < 1 || row.id > 255 || seen.has(row.id)) fail();
      seen.add(row.id);
      if (row.name !== undefined && row.name !== (attributeNames.get(row.id) || `Attribute_${row.id}`)) fail();
      for (const key of ['value', 'worst', 'thresh']) if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 255)) fail();
      if (row.when_failed !== undefined && !['now', 'past', '', '-'].includes(row.when_failed)) fail();
      if (row.raw !== undefined && (!exact(row.raw, ['value_s']) || !digits(row.raw.value_s))) fail();
    }
  }
  if (value.scsi_error_counter_log !== undefined) {
    if (!exact(value.scsi_error_counter_log, ['read', 'write', 'verify'])) fail();
    for (const item of Object.values(value.scsi_error_counter_log)) if (!exact(item, ['total_uncorrected_errors_s']) || !digits(item.total_uncorrected_errors_s)) fail();
  }
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { fail(); }
  if (bytes > MAX_SMART) fail();
  return structuredClone(value);
}

function scope(value) {
  if (!exact(value, ['pluginId', 'diskId', 'hostId', 'generation']) || !identifier(value.diskId) || !identifier(value.hostId) || !generationId(value.generation)) fail();
  assertId(value.pluginId);
  return { pluginId: value.pluginId, diskId: value.diskId, hostId: value.hostId, generation: value.generation };
}
function validateRecord(value) {
  if (!exact(value, ['pluginId', 'diskId', 'hostId', 'generation', 'operation', 'operationId', 'collectedAt', 'status', 'code', 'smart', 'gapCode'])) fail();
  const identity = scope({ pluginId: value.pluginId, diskId: value.diskId, hostId: value.hostId, generation: value.generation });
  if (value.operation !== OPERATION || !identifier(value.operationId) || !timestamp(value.collectedAt) || !['ok', 'unavailable', 'unsupported'].includes(value.status)) fail();
  if (value.gapCode !== undefined && !codeSet.has(value.gapCode)) fail();
  if (value.status === 'ok') {
    if (value.code !== undefined) fail();
    return { ...identity, operation: OPERATION, operationId: value.operationId, collectedAt: value.collectedAt, status: value.status, smart: validateHistorySmart(value.smart), ...(value.gapCode ? { gapCode: value.gapCode } : {}) };
  }
  if (value.smart !== undefined || !codeSet.has(value.code)) fail();
  return { ...identity, operation: OPERATION, operationId: value.operationId, collectedAt: value.collectedAt, status: value.status, code: value.code, ...(value.gapCode ? { gapCode: value.gapCode } : {}) };
}

export function createSmartHistory(directory, { now = Date.now, limits: requested = {} } = {}) {
  const limits = { ...SMART_HISTORY_LIMITS, ...requested };
  if (typeof now !== 'function' || Object.keys(requested).some(key => !Object.hasOwn(SMART_HISTORY_LIMITS, key)) || Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > SMART_HISTORY_LIMITS[key])) throw new Error('SMART_HISTORY_LIMIT_INVALID');
  const root = path.join(path.resolve(directory), 'smart-history'), lock = storage(root), indexFile = path.join(root, 'index.json'), journalFile = path.join(root, 'pending.json');
  const filename = key => path.join(root, 'records', key + '.json');
  const keyOf = identity => digest(JSON.stringify(identity)), diskKeyOf = ({ pluginId, hostId, diskId }) => digest(JSON.stringify({ pluginId, hostId, diskId }));
  const cutoff = () => dayOf(now() - 364 * DAY);
  const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  async function bounded(file, max, fallback) {
    try { if ((await stat(file)).size > max) throw new Error('SMART_HISTORY_CORRUPT'); return await readFile(file); }
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error('SMART_HISTORY_CORRUPT'); }
  }
  function checkIndex(value) {
    if (!exact(value, ['version', 'entries']) || value.version !== 1 || !object(value.entries) || Object.keys(value.entries).length > SMART_HISTORY_LIMITS.maxGenerations) throw new Error('SMART_HISTORY_CORRUPT');
    for (const [key, row] of Object.entries(value.entries)) {
      if (!hex(key) || !exact(row, ['diskKey', 'bytes', 'sha256', 'records', 'oldestDay', 'newestDay']) || !hex(row.diskKey) || !hex(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 365 * (MAX_SMART + 2048) || !Number.isSafeInteger(row.records) || row.records < 1 || row.records > 365 || !/^\d{4}-\d\d-\d\d$/.test(row.oldestDay) || !/^\d{4}-\d\d-\d\d$/.test(row.newestDay) || row.oldestDay > row.newestDay) throw new Error('SMART_HISTORY_CORRUPT');
    }
    return value;
  }
  async function index() { let value; try { value = JSON.parse((await bounded(indexFile, 8 * 1024 * 1024, Buffer.from('{"version":1,"entries":{}}'))).toString()); } catch { throw new Error('SMART_HISTORY_CORRUPT'); } return checkIndex(value); }
  async function recover() {
    let pending;
    try { pending = JSON.parse((await bounded(journalFile, 4096, Buffer.from('null'))).toString()); } catch { throw new Error('SMART_HISTORY_CORRUPT'); }
    if (pending === null) return;
    if (!exact(pending, ['version', 'key', 'before', 'after']) || pending.version !== 1 || !hex(pending.key) || pending.before !== null && !hex(pending.before)) throw new Error('SMART_HISTORY_CORRUPT');
    checkIndex({ version: 1, entries: { [pending.key]: pending.after } });
    const current = await index(), bytes = await bounded(filename(pending.key), 365 * (MAX_SMART + 2048), Buffer.alloc(0)), actual = bytes.length ? digest(bytes) : null;
    const indexed = current.entries[pending.key]?.sha256 || null;
    if (actual === pending.after.sha256 && [pending.before, pending.after.sha256].includes(indexed)) { current.entries[pending.key] = pending.after; await atomic(indexFile, current); }
    else if (actual !== pending.before || indexed !== pending.before) throw new Error('SMART_HISTORY_CORRUPT');
    await unlink(journalFile);
  }
  async function read(identity, current) {
    const key = keyOf(identity), meta = current.entries[key];
    if (!meta) {
      const orphan = await bounded(filename(key), 365 * (MAX_SMART + 2048), Buffer.alloc(0));
      if (orphan.length) throw new Error('SMART_HISTORY_CORRUPT');
      return { version: 1, identity, revision: null, records: [] };
    }
    const bytes = await bounded(filename(key), 365 * (MAX_SMART + 2048));
    if (bytes.length !== meta.bytes || digest(bytes) !== meta.sha256 || meta.diskKey !== diskKeyOf(identity)) throw new Error('SMART_HISTORY_CORRUPT');
    try {
      const value = JSON.parse(bytes);
      if (!exact(value, ['version', 'identity', 'revision', 'records']) || value.version !== 1 || JSON.stringify(scope(value.identity)) !== JSON.stringify(identity) || !hex(value.revision) || !Array.isArray(value.records) || value.records.length !== meta.records) fail();
      const days = new Set(); let prior = '9999';
      for (const input of value.records) {
        const record = validateRecord(input), day = dayOf(Date.parse(record.collectedAt));
        if (JSON.stringify(scope({ pluginId: record.pluginId, diskId: record.diskId, hostId: record.hostId, generation: record.generation })) !== JSON.stringify(identity) || days.has(day) || record.collectedAt > prior) fail();
        prior = record.collectedAt; days.add(day);
      }
      if ([...days].sort()[0] !== meta.oldestDay || [...days].sort().at(-1) !== meta.newestDay) fail();
      return value;
    } catch { throw new Error('SMART_HISTORY_CORRUPT'); }
  }
  async function cursorKey() {
    const file = path.join(root, 'cursor-key.json'); let value;
    try { value = JSON.parse((await bounded(file, 256, Buffer.from('null'))).toString()); } catch { throw new Error('SMART_HISTORY_CORRUPT'); }
    if (value === null) { value = { key: randomBytes(32).toString('hex') }; await atomic(file, value); }
    if (!exact(value, ['key']) || !hex(value.key)) throw new Error('SMART_HISTORY_CORRUPT');
    return Buffer.from(value.key, 'hex');
  }
  async function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + createHmac('sha256', await cursorKey()).update(body).digest('base64url'); }
  async function parseCursor(cursor, key) {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw new Error('SMART_HISTORY_CURSOR_INVALID');
    const [body, signature] = cursor.split('.'), expected = createHmac('sha256', await cursorKey()).update(body).digest(), given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('SMART_HISTORY_CURSOR_INVALID');
    let payload; try { payload = JSON.parse(Buffer.from(body, 'base64url')); } catch { throw new Error('SMART_HISTORY_CURSOR_INVALID'); }
    if (!exact(payload, ['version', 'key', 'revision', 'offset', 'cutoff', 'snapshotAt', 'expiresAt']) || payload.version !== 1 || payload.key !== key || !hex(payload.revision) || !Number.isInteger(payload.offset) || payload.offset < 1 || payload.offset > 365 || !timestamp(payload.snapshotAt) || !Number.isSafeInteger(payload.expiresAt)) throw new Error('SMART_HISTORY_CURSOR_INVALID');
    if (payload.expiresAt <= now()) throw new Error('SMART_HISTORY_CURSOR_EXPIRED');
    if (payload.cutoff !== cutoff()) throw new Error('SMART_HISTORY_CURSOR_STALE');
    return payload;
  }
  return {
    async append(input, { beforeCommit } = {}) {
      if (beforeCommit !== undefined && typeof beforeCommit !== 'function') throw new Error('SMART_HISTORY_COMMIT_GUARD_REQUIRED');
      if (Object.hasOwn(input || {}, 'gapCode')) fail();
      const record = validateRecord(input), identity = scope({ pluginId: record.pluginId, diskId: record.diskId, hostId: record.hostId, generation: record.generation });
      const collected = Date.parse(record.collectedAt), day = dayOf(collected);
      if (collected > now() + 60000) throw new Error('SMART_HISTORY_FUTURE_SAMPLE');
      if (day < cutoff()) throw new Error('SMART_HISTORY_EXPIRED_SAMPLE');
      return lock.locked(async () => {
        await recover(); const current = await index(), value = await read(identity, current), key = keyOf(identity), diskKey = diskKeyOf(identity);
        const records = value.records.filter(item => dayOf(Date.parse(item.collectedAt)) >= cutoff()), previous = records.find(item => dayOf(Date.parse(item.collectedAt)) === day), sameOperation = records.find(item => item.operationId === record.operationId);
        if (sameOperation) {
          const { gapCode, ...original } = sameOperation;
          if (JSON.stringify(original) !== JSON.stringify(record)) throw new Error('SMART_HISTORY_OPERATION_CONFLICT');
          return { record: structuredClone(sameOperation), inserted: false, replaced: false };
        }
        if (previous && (previous.status === 'ok' || record.status !== 'ok' || previous.collectedAt > record.collectedAt)) return { record: structuredClone(previous), inserted: false, replaced: false, retainedSuccess: previous.status === 'ok' };
        const next = previous ? { ...record, gapCode: previous.code } : record;
        const rows = [next, ...records.filter(item => item !== previous)].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
        const all = Object.entries(current.entries), disks = new Set(all.map(([, row]) => row.diskKey));
        if (!disks.has(diskKey) && disks.size >= limits.maxDisks || !current.entries[key] && all.length >= limits.maxGenerations) throw new Error('SMART_HISTORY_CAPACITY_EXCEEDED');
        const diskRecords = all.filter(([other, row]) => other !== key && row.diskKey === diskKey && row.newestDay >= cutoff()).reduce((sum, [, row]) => sum + row.records, 0) + rows.length;
        if (diskRecords > limits.maxRecordsPerDisk) throw new Error('SMART_HISTORY_CAPACITY_EXCEEDED');
        const content = { version: 1, identity, revision: randomBytes(32).toString('hex'), records: rows }, bytes = encode(content), total = all.reduce((sum, [, row]) => sum + row.bytes, 0) - (current.entries[key]?.bytes || 0) + bytes.length;
        if (rows.length > 365 || total > limits.maxBytes) throw new Error('SMART_HISTORY_CAPACITY_EXCEEDED');
        const meta = { diskKey, bytes: bytes.length, sha256: digest(bytes), records: rows.length, oldestDay: dayOf(Date.parse(rows.at(-1).collectedAt)), newestDay: dayOf(Date.parse(rows[0].collectedAt)) };
        // A revoked collection must fail before leaving a recoverable transaction.
        if (beforeCommit) await beforeCommit();
        await atomic(journalFile, { version: 1, key, before: current.entries[key]?.sha256 || null, after: meta });
        await atomic(filename(key), content); current.entries[key] = meta; await atomic(indexFile, current); await unlink(journalFile);
        return { record: structuredClone(next), inserted: !previous, replaced: Boolean(previous) };
      });
    },
    async latest(query) {
      const identity = scope(query);
      return lock.locked(async () => { await recover(); const value = await read(identity, await index()); return { record: structuredClone(value.records.find(item => dayOf(Date.parse(item.collectedAt)) >= cutoff()) || null) }; });
    },
    async page(query) {
      if (!exact(query, ['pluginId', 'diskId', 'hostId', 'generation', 'limit', 'cursor'])) fail();
      const { limit = 30, cursor, ...ids } = query, identity = scope(ids);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new Error('SMART_HISTORY_PAGE_LIMIT_INVALID');
      return lock.locked(async () => {
        await recover(); const value = await read(identity, await index()), key = keyOf(identity);
        const snapshot = cursor === undefined ? { version: 1, key, revision: value.revision, offset: 0, cutoff: cutoff(), snapshotAt: new Date(now()).toISOString(), expiresAt: now() + 600000 } : await parseCursor(cursor, key);
        if (snapshot.revision !== value.revision) throw new Error('SMART_HISTORY_CURSOR_STALE');
        const rows = value.records.filter(item => dayOf(Date.parse(item.collectedAt)) >= snapshot.cutoff), items = rows.slice(snapshot.offset, snapshot.offset + limit), offset = snapshot.offset + items.length;
        return { items: structuredClone(items), snapshotAt: snapshot.snapshotAt, nextCursor: offset < rows.length ? await sign({ ...snapshot, offset }) : null };
      });
    },
  };
}
