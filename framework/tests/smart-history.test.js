import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSmartHistory, validateHistorySmart } from '../server/smart-history.js';

const DAY = 86400000, time = Date.parse('2026-10-28T12:00:00.000Z');
const identity = { pluginId: 'rivetin-smart-example', diskId: 'disk-example', hostId: 'host-example', generation: 'a'.repeat(64) };
const smart = () => ({ smartctl: { exit_status: 0 }, smart_status: { passed: true }, temperature: { current: 35 },
  nvme_smart_health_information_log: { percentage_used: 9, data_units_written_s: '1234567890123456789012345678901234567890' } });
const sample = (offset = 0, patch = {}) => ({ ...identity, operation: 'disk.smart.read', operationId: `job_${offset}`, collectedAt: new Date(time - offset * DAY).toISOString(), status: 'ok', smart: smart(), ...patch });
const query = patch => ({ ...identity, ...patch });
async function fixture(t, options = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'smart-history-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const state = { now: time }, opts = { now: () => state.now, ...options };
  return { root, state, opts, store: createSmartHistory(root, opts) };
}
async function index(f) { return JSON.parse(await readFile(path.join(f.root, 'smart-history/index.json'), 'utf8')); }
async function recordFile(f) { return path.join(f.root, 'smart-history/records', Object.keys((await index(f)).entries)[0] + '.json'); }

test('SMART history persists exact counters, latest and per-day idempotence across restart', async t => {
  const f = await fixture(t); const first = await f.store.append(sample());
  assert.equal(first.inserted, true); assert.equal(first.record.smart.nvme_smart_health_information_log.data_units_written_s, smart().nvme_smart_health_information_log.data_units_written_s);
  assert.equal((await f.store.append(sample())).inserted, false);
  const restarted = createSmartHistory(f.root, f.opts);
  assert.deepEqual((await restarted.latest(query())).record, first.record);
  assert.equal((await restarted.page(query())).items.length, 1);
  assert.ok((await readdir(path.join(f.root, 'smart-history/records'))).every(name => /^[a-f0-9]{64}\.json$/.test(name)));
});

test('failed daily sample can become success and retains a fixed gap code; success never becomes failure', async t => {
  const f = await fixture(t), failed = sample(0, { status: 'unavailable', code: 'SSH_EXECUTION_TIMEOUT' }); delete failed.smart;
  await f.store.append(failed);
  const recovered = await f.store.append(sample(0, { operationId: 'recovered', collectedAt: new Date(time + 1000).toISOString() }));
  assert.equal(recovered.replaced, true); assert.equal(recovered.record.gapCode, 'SSH_EXECUTION_TIMEOUT');
  const retained = await f.store.append({ ...failed, operationId: 'later_failure', collectedAt: new Date(time + 2000).toISOString() });
  assert.equal(retained.retainedSuccess, true); assert.equal(retained.record.operationId, 'recovered');
  assert.equal((await f.store.append(sample(0, { operationId: 'recovered', collectedAt: new Date(time + 1000).toISOString() }))).inserted, false);
});

test('operation IDs cannot be reused for a different document or date and gaps cannot be supplied by a caller', async t => {
  const f = await fixture(t); await f.store.append(sample());
  await assert.rejects(f.store.append(sample(1, { operationId: 'job_0' })), /SMART_HISTORY_OPERATION_CONFLICT/);
  await assert.rejects(f.store.append(sample(0, { smart: { temperature: { current: 90 } } })), /SMART_HISTORY_OPERATION_CONFLICT/);
  await assert.rejects(f.store.append(sample(1, { gapCode: 'SSH_EXECUTION_TIMEOUT' })), /SMART_HISTORY_INVALID_DATA/);
});

test('disk generations, hosts and plugins have separate latest records and pages', async t => {
  const f = await fixture(t);
  for (const patch of [{}, { generation: 'b'.repeat(64) }, { hostId: 'second_host' }, { pluginId: 'rivetin-another-plugin' }]) await f.store.append(sample(0, patch));
  const data = await index(f); assert.equal(Object.keys(data.entries).length, 4);
  for (const patch of [{}, { generation: 'b'.repeat(64) }, { hostId: 'second_host' }, { pluginId: 'rivetin-another-plugin' }]) assert.deepEqual((await f.store.latest(query(patch))).record, sample(0, patch));
  assert.equal((await f.store.latest(query({ generation: 'c'.repeat(64) }))).record, null);
});

test('strict identity, statuses, operation and timestamps are validated before storage', async t => {
  const f = await fixture(t);
  for (const patch of [{ pluginId: 'pluginkit-old' }, { diskId: '../escape' }, { hostId: 'x'.repeat(129) }, { generation: 'random' }, { operation: 'host.identity' }, { operationId: 'x;id' }, { status: 'healthy' }, { collectedAt: '2026-02-31T12:00:00.000Z' }, { collectedAt: '2026-10-28' }, { extra: 'EXAMPLE_NOT_ALLOWED' }]) await assert.rejects(f.store.append(sample(0, patch)));
  await assert.rejects(f.store.append(sample(0, { collectedAt: new Date(time + 60001).toISOString() })), /SMART_HISTORY_FUTURE_SAMPLE/);
  await f.store.append(sample(0, { generation: '123e4567-e89b-42d3-a456-426614174000' }));
  assert.equal(Object.keys((await index(f)).entries).length, 1);
});

test('raw identity, strings, secrets, unsafe numbers and unknown nested fields are never persisted', async t => {
  const f = await fixture(t);
  const payloads = [{ ...smart(), password: 'EXAMPLE_FORBIDDEN' }, { ...smart(), serial_number: 'EXAMPLE_SERIAL' }, { device: { protocol: 'ATA', path: '/dev/sda' } },
    { smartctl: { exit_status: 2 } }, { temperature: { current: Infinity } }, { power_cycle_count: 9007199254740992 }, { power_cycle_count_s: '1e20' },
    { nvme_smart_health_information_log: { token: 'EXAMPLE_FORBIDDEN' } }, { ata_smart_attributes: { table: [{ id: 5, name: 'Arbitrary_User_String', raw: { value_s: '1' } }] } },
    { ata_smart_attributes: { table: [{ id: 5, raw: { string: 'EXAMPLE_FORBIDDEN' } }] } }, { ata_smart_attributes: null }, { temperature: undefined },
    { scsi_error_counter_log: { read: { total_uncorrected_errors_s: '1', password: 'EXAMPLE_FORBIDDEN' } } }];
  for (const payload of payloads) await assert.rejects(f.store.append(sample(0, { smart: payload })), /SMART_HISTORY_INVALID_DATA/);
  assert.deepEqual(await readdir(f.root), []);
  const safe = { ata_smart_attributes: { table: [{ id: 5, name: 'Reallocated_Sector_Ct', value: 99, worst: 99, thresh: 10, when_failed: '-', raw: { value_s: '0' } }] } };
  safe.ata_smart_attributes.table.push({ id: 9, name: 'Power_On_Hours', raw: { value_s: '1000' } }, { id: 12, name: 'Power_Cycle_Count', raw: { value_s: '3' } }, { id: 194, name: 'Temperature_Celsius', raw: { value_s: '35' } });
  assert.deepEqual(validateHistorySmart(safe), safe);
});

test('unavailable and unsupported records carry only fixed safe codes and never SMART output', async t => {
  const f = await fixture(t), failed = sample(0, { status: 'unsupported', code: 'SMART_UNSUPPORTED' }); delete failed.smart;
  await f.store.append(failed); assert.equal((await f.store.latest(query())).record.status, 'unsupported');
  await assert.rejects(f.store.append({ ...failed, code: 'EXAMPLE_PASSWORD_FROM_REMOTE' }), /SMART_HISTORY_INVALID_DATA/);
  await assert.rejects(f.store.append({ ...failed, smart: smart() }), /SMART_HISTORY_INVALID_DATA/);
  await assert.rejects(f.store.append({ ...failed, code: undefined }), /SMART_HISTORY_INVALID_DATA/);
});

test('independent service instances serialize concurrent appends without dropping daily records', async t => {
  const f = await fixture(t), other = createSmartHistory(f.root, f.opts);
  await Promise.all(Array.from({ length: 12 }, (_, offset) => (offset % 2 ? other : f.store).append(sample(offset))));
  assert.equal((await f.store.page(query())).items.length, 12);
});

test('independent Node processes share the same file lock and atomic history', async t => {
  const f = await fixture(t), moduleUrl = new URL('../server/smart-history.js', import.meta.url).href;
  const code = `import {createSmartHistory} from ${JSON.stringify(moduleUrl)}; const [root,input,now]=process.argv.slice(1); await createSmartHistory(root,{now:()=>Number(now)}).append(JSON.parse(input));`;
  await Promise.all([1, 2, 3].map(offset => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, f.root, JSON.stringify(sample(offset)), String(time)])));
  assert.equal((await f.store.page(query())).items.length, 3);
});

test('pagination is bounded and cursor binds the disk, plugin, generation and stable revision', async t => {
  const f = await fixture(t); for (let day = 0; day < 34; day++) await f.store.append(sample(day));
  const first = await f.store.page(query({ limit: 30 })); assert.equal(first.items.length, 30); assert.ok(first.nextCursor);
  const second = await f.store.page(query({ limit: 30, cursor: first.nextCursor })); assert.equal(second.items.length, 4); assert.equal(second.nextCursor, null); assert.equal(second.snapshotAt, first.snapshotAt);
  for (const patch of [{ diskId: 'other_disk' }, { generation: 'b'.repeat(64) }, { pluginId: 'rivetin-other-plugin' }]) await assert.rejects(f.store.page(query({ ...patch, cursor: first.nextCursor })), /SMART_HISTORY_CURSOR_INVALID/);
  await assert.rejects(f.store.page(query({ limit: 31 })), /SMART_HISTORY_PAGE_LIMIT_INVALID/);
  await assert.rejects(f.store.page(query({ cursor: first.nextCursor + 'x' })), /SMART_HISTORY_CURSOR_INVALID/);
  await f.store.append(sample(34)); await assert.rejects(f.store.page(query({ cursor: first.nextCursor })), /SMART_HISTORY_CURSOR_STALE/);
});

test('cursor expiration fails closed without fabricating a new snapshot', async t => {
  const f = await fixture(t); await f.store.append(sample(0)); await f.store.append(sample(1));
  const first = await f.store.page(query({ limit: 1 })); f.state.now += 600001;
  await assert.rejects(f.store.page(query({ cursor: first.nextCursor })), /SMART_HISTORY_CURSOR_EXPIRED/);
});

test('UTC retention keeps 365 days, rejects expired samples and never calls an old sample current', async t => {
  const f = await fixture(t); await f.store.append(sample(364));
  await assert.rejects(f.store.append(sample(365)), /SMART_HISTORY_EXPIRED_SAMPLE/);
  assert.equal((await f.store.latest(query())).record.collectedAt, sample(364).collectedAt);
  f.state.now += DAY; assert.equal((await f.store.latest(query())).record, null); assert.deepEqual((await f.store.page(query())).items, []);
  await f.store.append(sample(0, { operationId: 'fresh' })); assert.equal((await f.store.page(query())).items.length, 1);
});

test('disk, generation, retained-record and total-byte limits fail without rewriting retained records', async t => {
  for (const [limits, next] of [[{ maxDisks: 1 }, { diskId: 'second_disk' }], [{ maxGenerations: 1 }, { generation: 'b'.repeat(64) }], [{ maxRecordsPerDisk: 1 }, { generation: 'b'.repeat(64) }]]) {
    const f = await fixture(t, { limits }); await f.store.append(sample()); const before = await readFile(await recordFile(f), 'utf8');
    await assert.rejects(f.store.append(sample(1, next)), /SMART_HISTORY_CAPACITY_EXCEEDED/); assert.equal(await readFile(await recordFile(f), 'utf8'), before);
  }
  const f = await fixture(t, { limits: { maxBytes: 10 } }); await assert.rejects(f.store.append(sample()), /SMART_HISTORY_CAPACITY_EXCEEDED/);
  assert.throws(() => createSmartHistory(f.root, { limits: { maxDisks: 10001 } }), /SMART_HISTORY_LIMIT_INVALID/);
});

test('corrupt record bytes, invalid catalog and malformed transaction journal fail closed', async t => {
  const f = await fixture(t); await f.store.append(sample()); const file = await recordFile(f), original = await readFile(file);
  await writeFile(file, '{}'); await assert.rejects(f.store.latest(query()), /SMART_HISTORY_CORRUPT/); await writeFile(file, original);
  await writeFile(path.join(f.root, 'smart-history/pending.json'), '{"key":"../../escape"}'); await assert.rejects(f.store.latest(query()), /SMART_HISTORY_CORRUPT/);
  await rm(path.join(f.root, 'smart-history/pending.json')); await writeFile(path.join(f.root, 'smart-history/index.json'), '{');
  await assert.rejects(f.store.page(query()), /SMART_HISTORY_CORRUPT/);
});

test('a record committed before its catalog is recovered idempotently after process interruption', async t => {
  const f = await fixture(t); await f.store.append(sample());
  const catalog = await index(f), key = Object.keys(catalog.entries)[0], before = catalog.entries[key], file = await recordFile(f), value = JSON.parse(await readFile(file));
  value.revision = 'b'.repeat(64); value.records.unshift(sample(1)); value.records.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), after = { ...before, bytes: bytes.length, records: 2, oldestDay: sample(1).collectedAt.slice(0, 10), sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(path.join(f.root, 'smart-history/pending.json'), JSON.stringify({ version: 1, key, before: before.sha256, after })); await writeFile(file, bytes);
  assert.equal((await createSmartHistory(f.root, f.opts).page(query())).items.length, 2);
  assert.equal((await index(f)).entries[key].sha256, after.sha256);
  assert.equal((await f.store.latest(query())).record.collectedAt, sample().collectedAt);
});

test('commit guard rejection never leaves a recoverable unauthorized sample', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.append(sample(), { beforeCommit: async () => { throw new Error('SSH_APPROVAL_REVOKED'); } }), /SSH_APPROVAL_REVOKED/);
  assert.equal((await f.store.latest(query())).record, null);
  assert.deepEqual((await readdir(path.join(f.root, 'smart-history'))).filter(name => !name.startsWith('.')), []);
  await f.store.append(sample()); const before = await readFile(await recordFile(f));
  await assert.rejects(f.store.append(sample(1), { beforeCommit: async () => { throw new Error('SSH_EXECUTION_CANCELLED'); } }), /SSH_EXECUTION_CANCELLED/);
  assert.deepEqual(await readFile(await recordFile(f)), before);
  assert.equal((await createSmartHistory(f.root, f.opts).page(query())).items.length, 1);
});
