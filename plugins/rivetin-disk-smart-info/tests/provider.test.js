import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDiskData, validateSnapshot, validTime, validateIdentity, readHistoryPage, withBaseline } from '../src/provider.js';
import { createMockProvider, sample, disks, mockIdentity } from '../demo/fixtures.js';
const now = Date.parse('2026-10-28T00:00:00Z'), signal = () => new AbortController().signal;
test('provider validates disk/host/device identity and selects nearest earlier sample', async () => {
  const result = await loadDiskData(createMockProvider({ now }), disks[0].diskId, signal(), now);
  assert.equal(result.latest.status, 'ok'); assert.equal(result.previous.collectedAt, '2026-10-27T00:00:00.000Z');
  assert.equal(result.latest.metrics.find(item => item.id === 'media_errors').deterioration, '1');
});
test('disk replacement or wrong host cannot join historical series', async () => {
  for (const key of ['diskId', 'hostId', 'deviceId', 'generation']) {
    const provider = createMockProvider({ now }), read = provider.readHistory;
    provider.readHistory = async args => { const page = await read(args); page.items[0].identity = { ...page.identity, [key]: 'different-object' }; return page; };
    await assert.rejects(loadDiskData(provider, disks[0].diskId, signal(), now), /INVALID_SMART_RESPONSE/);
  }
});
test('first sample, unsupported device, stale data and unavailable provider are explicit', async () => {
  const provider = createMockProvider({ now }), read = provider.readHistory;
  provider.readHistory = async args => ({ ...await read(args), items: [], nextCursor: null });
  const first = await loadDiskData(provider, disks[0].diskId, signal(), now);
  assert.equal(first.previous, null); assert.ok(first.latest.metrics.every(item => item.delta === null));
  assert.equal((await loadDiskData(provider, disks[2].diskId, signal(), now)).latest.risk, 'unknown');
  assert.equal(validateSnapshot(sample(disks[0], 3, now), mockIdentity(disks[0]), now).status, 'stale');
  await assert.rejects(loadDiskData(null, disks[0].diskId, signal(), now), /PROVIDER_UNAVAILABLE/);
});
test('history failure preserves latest values with no invented deterioration', async () => {
  const provider = createMockProvider({ now }); provider.readHistory = async () => { throw new TypeError('offline'); };
  const result = await loadDiskData(provider, disks[0].diskId, signal(), now);
  assert.equal(result.historyUnavailable, true); assert.equal(result.previous, null);
});
test('future, invalid calendar, excessive and duplicate history data are rejected', async () => {
  assert.equal(validTime('2026-02-31T00:00:00Z'), false);
  assert.throws(() => validateSnapshot(sample(disks[0], -1, now), mockIdentity(disks[0]), now), /INVALID_SMART_RESPONSE/);
  const provider = createMockProvider({ now }), read = provider.readHistory;
  provider.readHistory = async args => { const page = await read(args); page.items = [page.items[0], page.items[0]]; return page; };
  await assert.rejects(loadDiskData(provider, disks[0].diskId, signal(), now), /DUPLICATE_HISTORY_TIMESTAMP/);
  provider.readHistory = async args => ({ ...await read(args), items: Array(31).fill(sample(disks[0], 1, now)) });
  await assert.rejects(loadDiskData(provider, disks[0].diskId, signal(), now), /INVALID_HISTORY_RESPONSE/);
});
test('an aborted identity read cannot start subsequent SMART requests', async () => {
  const abort = new AbortController(), provider = createMockProvider({ now }); let calls = 0;
  provider.resolveDisk = async () => { abort.abort(); return mockIdentity(disks[0]); }; provider.readLatest = async () => { calls++; };
  await assert.rejects(loadDiskData(provider, disks[0].diskId, abort.signal, now), /CANCELLED/); assert.equal(calls, 0);
});
test('unordered bounded history page ignores same/later samples and advertises older pages', async () => {
  const provider = createMockProvider({ now });
  provider.readHistory = async ({ identity }) => ({ schemaVersion: 1, source: 'mock', identity,
    items: [sample(identity, 4, now), sample(identity, 0, now), sample(identity, 2, now), sample(identity, 1, now)], nextCursor: 'opaque-next-page' });
  const result = await loadDiskData(provider, disks[0].diskId, signal(), now);
  assert.equal(result.previous.collectedAt, sample(disks[0], 1, now).collectedAt); assert.equal(result.hasMore, true);
});
test('missing identity keys, missing timestamp and unknown source are rejected', async () => {
  for (const key of ['diskId', 'hostId', 'deviceId', 'generation']) {
    const provider = createMockProvider({ now }); provider.resolveDisk = async () => { const identity = mockIdentity(disks[0]); delete identity[key]; return identity; };
    await assert.rejects(loadDiskData(provider, disks[0].diskId, signal(), now), /IDENTITY_UNVERIFIED/);
  }
  assert.throws(() => validateSnapshot({ ...sample(disks[0], 0, now), collectedAt: undefined }, mockIdentity(disks[0]), now), /INVALID_SMART_RESPONSE/);
  assert.throws(() => validateSnapshot({ ...sample(disks[0], 0, now), source: 'unverified' }, mockIdentity(disks[0]), now), /INVALID_SMART_RESPONSE/);
});

test('v1 identity requires opaque generation, matching device alias and no device path', () => {
  const identity = mockIdentity(disks[0]);
  assert.equal(validateIdentity(identity, identity.diskId).generation, identity.generation);
  for (const change of [{ generation: 'G'.repeat(64) }, { generation: undefined }, { deviceId: 'profile-device' }, { path: '/dev/sdb' }]) {
    assert.throws(() => validateIdentity({ ...identity, ...change }, identity.diskId), /IDENTITY_UNVERIFIED/);
  }
});

test('failed latest keeps attempt time, has history, and failed days never become baselines', async () => {
  const provider = createMockProvider({ now, state: () => 'failed' });
  const result = await loadDiskData(provider, disks[0].diskId, signal(), now);
  assert.equal(result.latest.collectedAt, new Date(now).toISOString());
  assert.equal(result.latest.code, 'SMART_COLLECTION_FAILED'); assert.equal(result.latest.risk, 'unknown');
  assert.equal(result.previous, null); assert.equal(result.history.length, 30);
  assert.equal(result.history[1].status, 'unavailable');
  const selected = withBaseline(result.history[0], result.history);
  assert.equal(selected.previous.collectedAt, sample(disks[0], 3, now).collectedAt);
  assert.equal(withBaseline(result.history[1], result.history).previous, null);
  assert.deepEqual(result.latest.metrics, []);
});

test('no sample is explicit and failure output never includes an injected smart document or arbitrary text', () => {
  const identity = mockIdentity(disks[0]);
  const value = validateSnapshot({ schemaVersion: 1, source: 'host-smartctl', identity, status: 'unavailable', collectedAt: null, code: 'SMART_NO_SAMPLE', smart: sample(identity).smart }, identity, now);
  assert.equal(value.code, 'SMART_NO_SAMPLE'); assert.equal(value.collectedAt, null); assert.equal(value.smart, undefined);
  const failure = validateSnapshot({ ...value, code: 'arbitrary server text' }, identity, now);
  assert.equal(failure.code, 'SMART_COLLECTION_FAILED');
  assert.throws(() => validateSnapshot({ ...value, collectedAt: 'bad-time' }, identity, now), /INVALID_SMART_RESPONSE/);
});

test('formal host provider with no sample still reads an empty history without inventing a collection time', async () => {
  const identity = mockIdentity(disks[0]); let historyReads = 0;
  const provider = {
    async resolveDisk({ diskId, signal }) { assert.equal(diskId, identity.diskId); assert.equal(signal.aborted, false); return identity; },
    async readLatest({ identity: resolved }) { assert.deepEqual(resolved, identity); return { schemaVersion: 1, source: 'host-smartctl', identity, status: 'unavailable', code: 'SMART_NO_SAMPLE', collectedAt: null }; },
    async readHistory({ identity: resolved, limit, cursor, signal }) {
      historyReads++; assert.deepEqual(resolved, identity); assert.equal(limit, 30); assert.equal(cursor, null); assert.equal(signal.aborted, false);
      return { schemaVersion: 1, source: 'host-smartctl', identity, items: [], nextCursor: null };
    },
  };
  const result = await loadDiskData(provider, identity.diskId, signal(), now);
  assert.equal(historyReads, 1); assert.equal(result.latest.collectedAt, null); assert.equal(result.latest.code, 'SMART_NO_SAMPLE');
  assert.equal(result.latest.risk, 'unknown'); assert.deepEqual(result.latest.metrics, []); assert.deepEqual(result.history, []); assert.equal(result.previous, null); assert.equal(result.hasMore, false);
});

test('a no-sample placeholder cannot masquerade as a failed historical collection', async () => {
  const provider = createMockProvider({ now });
  provider.readHistory = async ({ identity }) => ({ schemaVersion: 1, source: 'mock', identity, nextCursor: null,
    items: [{ schemaVersion: 1, source: 'mock', identity, status: 'unavailable', code: 'SMART_NO_SAMPLE', collectedAt: null }] });
  await assert.rejects(loadDiskData(provider, disks[0].diskId, signal(), now), /INVALID_HISTORY_RESPONSE/);
});

test('recovered daily samples retain only approved gap codes and remain valid successful baselines', async () => {
  const identity = mockIdentity(disks[0]);
  const codes = ['SMART_COLLECTION_FAILED', 'SMART_UNAVAILABLE', 'SMART_UNSUPPORTED', 'SMART_INVALID_DATA', 'SMART_DEVICE_CHANGED', 'SMART_IDENTITY_MISMATCH', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID'];
  for (const gapCode of codes) {
    const value = validateSnapshot({ ...sample(identity, 0, now), gapCode, gapCollectedAt: 'arbitrary text' }, identity, now);
    assert.equal(value.status, 'ok'); assert.equal(value.gapCode, gapCode); assert.equal(value.gapCollectedAt, undefined);
  }
  for (const gapCode of ['SMART_NO_SAMPLE', 'SSH_EXECUTION_TIMEOUT', 'arbitrary text', null]) {
    assert.throws(() => validateSnapshot({ ...sample(identity, 0, now), gapCode }, identity, now), /INVALID_SMART_RESPONSE/);
  }
  assert.throws(() => validateSnapshot({ ...sample(identity, 1, now), status: 'unavailable', gapCode: 'SMART_COLLECTION_FAILED' }, identity, now), /INVALID_SMART_RESPONSE/);
  const provider = createMockProvider({ now }), original = provider.readHistory;
  provider.readHistory = async args => { const page = await original(args); page.items[0].gapCode = 'SMART_EXECUTION_TIMEOUT'; return page; };
  const result = await loadDiskData(provider, identity.diskId, signal(), now);
  assert.equal(result.previous.gapCode, 'SMART_EXECUTION_TIMEOUT'); assert.equal(result.latest.metrics.find(metric => metric.id === 'percentage_used').deterioration, '1');
});

test('history pages are read on demand with fixed size and bounded complete series', async () => {
  const provider = createMockProvider({ now }), original = provider.readHistory, calls = [];
  provider.readHistory = args => { calls.push({ limit: args.limit, cursor: args.cursor, identity: args.identity }); return original(args); };
  let result = await loadDiskData(provider, disks[0].diskId, signal(), now);
  assert.equal(calls.length, 1); assert.equal(result.history.length, 30);
  result = await readHistoryPage(provider, result, result.nextCursor, signal(), now);
  assert.equal(result.history.length, 60);
  result = await readHistoryPage(provider, result, result.nextCursor, signal(), now);
  assert.equal(result.history.length, 65); assert.equal(result.hasMore, false);
  assert.deepEqual(calls.map(call => [call.limit, call.cursor]), [[30, null], [30, '30'], [30, '60']]);
  assert.ok(calls.every(call => call.identity.path === '' && call.identity.generation === disks[0].generation));
});

test('changed cursor, generation, authorization and duplicate days fail closed', async () => {
  const provider = createMockProvider({ now });
  const result = await loadDiskData(provider, disks[0].diskId, signal(), now);
  const unchanged = structuredClone(result);
  provider.readHistory = async () => { throw Object.assign(new Error('fixed'), { code: 'SMART_HISTORY_CURSOR_STALE' }); };
  await assert.rejects(readHistoryPage(provider, result, result.nextCursor, signal(), now), { code: 'SMART_HISTORY_CURSOR_STALE' });
  assert.deepEqual(result, unchanged);
  for (const error of [new Error('SMART_GENERATION_CHANGED'), new Error('SMART_DISK_UNBOUND'), new Error('AUTHENTICATION_REQUIRED'), new Error('UNKNOWN_ACCESS_FAILURE'), Object.assign(new Error('denied'), { status: 403 })]) {
    provider.readHistory = async () => { throw error; };
    await assert.rejects(loadDiskData(provider, disks[0].diskId, signal(), now));
  }
  const bad = createMockProvider({ now });
  bad.readHistory = async ({ identity }) => ({ schemaVersion: 1, source: 'mock', identity, nextCursor: null, items: [sample(identity, 1, now), sample(identity, 1, now + 1000)] });
  await assert.rejects(loadDiskData(bad, disks[0].diskId, signal(), now), /DUPLICATE_HISTORY_TIMESTAMP/);
});

test('malformed pagination cannot loop, mix generations or grow beyond 365 records', async () => {
  const provider = createMockProvider({ now }); const result = await loadDiskData(provider, disks[0].diskId, signal(), now);
  const original = provider.readHistory;
  for (const change of [page => ({ ...page, nextCursor: result.nextCursor }), page => ({ ...page, items: [] }), page => ({ ...page, identity: { ...page.identity, generation: '4'.repeat(64) } }), page => ({ ...page, items: [sample(result.identity, 0, now)] })]) {
    provider.readHistory = async args => change(await original(args));
    await assert.rejects(readHistoryPage(provider, result, result.nextCursor, signal(), now), /INVALID_HISTORY/);
  }
  provider.readHistory = async ({ identity }) => ({ schemaVersion: 1, source: 'mock', identity, nextCursor: null, items: [sample(identity, 366, now)] });
  const full = { ...result, history: Array.from({ length: 365 }, (_, index) => validateSnapshot(sample(result.identity, index, now), result.identity, now)) };
  await assert.rejects(readHistoryPage(provider, full, 'older', signal(), now), /INVALID_HISTORY_RESPONSE/);
});
