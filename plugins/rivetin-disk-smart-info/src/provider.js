import { normalizeSmart, compareMetrics, highestRisk } from './smart.js';
import { isVirtualDiskModel, createVirtualDemo } from './virtual-demo.js';
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function validateIdentity(value, diskId) {
  if (!value || !validId(value.diskId) || value.diskId !== diskId || !validId(value.hostId) ||
      !/^[a-f0-9]{64}$/.test(value.generation) || value.deviceId !== value.generation || value.path !== '') throw new Error('DISK_IDENTITY_UNVERIFIED');
  return { diskId: value.diskId, hostId: value.hostId, deviceId: value.deviceId, generation: value.generation,
    path: '', model: typeof value.model === 'string' ? value.model.slice(0, 160) : '' };
}
export const sameIdentity = (a, b) => Boolean(a && b && ['diskId', 'hostId', 'deviceId', 'generation'].every(key => a[key] === b[key]));
export const validTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const sources = new Set(['mock', 'host-smartctl']);
const gapCodes = new Set(['SMART_COLLECTION_FAILED', 'SMART_UNAVAILABLE', 'SMART_UNSUPPORTED', 'SMART_INVALID_DATA', 'SMART_DEVICE_CHANGED',
  'SMART_IDENTITY_MISMATCH', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID']);
const failures = new Set(['SMART_NO_SAMPLE', 'SMART_DISK_UNBOUND', 'SMART_COLLECTION_FAILED', 'SMART_UNAVAILABLE', 'SMART_UNSUPPORTED',
  'SMART_INVALID_DATA', 'SMART_DEVICE_CHANGED', 'SMART_IDENTITY_MISMATCH', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID']);
const readFailures = new Set(['SMART_GENERATION_CHANGED', 'SMART_HISTORY_CURSOR_STALE', 'SMART_BINDING_CHANGED',
  'SMART_DISK_FORBIDDEN', 'AUTHENTICATION_REQUIRED', 'SMART_PLUGIN_DISABLED', ...failures]);
export const errorCode = error => [error?.code, error?.message].find(value => readFailures.has(value)) || 'SMART_READ_FAILED';
const cancelled = signal => { if (signal.aborted) throw new Error('REQUEST_CANCELLED'); };
const successful = sample => ['ok', 'stale'].includes(sample.status);
export function validateSnapshot(value, identity, now = Date.now()) {
  if (!value || value.schemaVersion !== 1 || !sources.has(value.source) || !sameIdentity(value.identity, identity) ||
      !['ok', 'stale', 'unavailable', 'unsupported'].includes(value.status)) throw new Error('INVALID_SMART_RESPONSE');
  if (value.gapCode !== undefined && (!successful(value) || !gapCodes.has(value.gapCode))) throw new Error('INVALID_SMART_RESPONSE');
  const timeValid = validTime(value.collectedAt) && Date.parse(value.collectedAt) <= now + 300000;
  if (!successful(value)) {
    if (value.collectedAt !== null && !timeValid) throw new Error('INVALID_SMART_RESPONSE');
    return { schemaVersion: 1, source: value.source, status: value.status, identity, collectedAt: value.collectedAt,
      code: failures.has(value.code) ? value.code : 'SMART_COLLECTION_FAILED', metrics: [], risk: 'unknown' };
  }
  if (!timeValid || !value.smart || JSON.stringify(value.smart).length > 524288) throw new Error('INVALID_SMART_RESPONSE');
  const normalized = normalizeSmart(value.smart);
  const status = value.status === 'stale' || now - Date.parse(value.collectedAt) > 36 * 3600000 ? 'stale' : 'ok';
  return { schemaVersion: 1, source: value.source, status, identity, collectedAt: value.collectedAt,
    ...(value.gapCode === undefined ? {} : { gapCode: value.gapCode }), ...normalized, risk: highestRisk(normalized.metrics.map(metric => metric.risk)) };
}
export function withBaseline(sample, history) {
  const previous = successful(sample) ? history.find(item => successful(item) && sameIdentity(item.identity, sample.identity) && Date.parse(item.collectedAt) < Date.parse(sample.collectedAt)) || null : null;
  const metrics = compareMetrics(sample.metrics, previous?.metrics);
  return { sample: { ...sample, metrics, risk: highestRisk(metrics.map(metric => metric.risk)) }, previous };
}
export async function readHistoryPage(provider, result, cursor, signal, now = Date.now()) {
  if (result.virtualDemo) throw new Error('VIRTUAL_DEMO_HAS_NO_HISTORY');
  cancelled(signal);
  const page = await provider.readHistory({ identity: result.identity, limit: 30, cursor, signal });
  cancelled(signal);
  if (!page || page.schemaVersion !== 1 || page.source !== result.latest.source || !sameIdentity(page.identity, result.identity) ||
      !Array.isArray(page.items) || page.items.length > 30 || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 4096)) ||
      (page.nextCursor !== null && (page.nextCursor === cursor || page.items.length === 0))) throw new Error('INVALID_HISTORY_RESPONSE');
  const existing = cursor ? result.history : [], seen = new Set(existing.map(item => item.collectedAt.slice(0, 10)));
  const items = page.items.map(item => {
    const sample = validateSnapshot(item, result.identity, now);
    if (sample.source !== page.source) throw new Error('HISTORY_SOURCE_MISMATCH');
    if (!sample.collectedAt) throw new Error('INVALID_HISTORY_RESPONSE');
    const day = sample.collectedAt.slice(0, 10);
    if (seen.has(day)) throw new Error('DUPLICATE_HISTORY_TIMESTAMP');
    seen.add(day); return sample;
  });
  if (cursor && items.some(item => Date.parse(item.collectedAt) >= Date.parse(existing.at(-1)?.collectedAt))) throw new Error('INVALID_HISTORY_ORDER');
  const history = [...existing, ...items].sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
  if (history.length > 365 || (history.length === 365 && page.nextCursor !== null)) throw new Error('INVALID_HISTORY_RESPONSE');
  const { sample: latest, previous } = withBaseline(result.latest, history);
  return { ...result, latest, previous, history, historyUnavailable: false, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null };
}
export async function loadDiskData(provider, diskId, signal, now = Date.now()) {
  if (!provider || !['resolveDisk', 'readLatest', 'readHistory'].every(key => typeof provider[key] === 'function')) throw new Error('SMART_PROVIDER_UNAVAILABLE');
  if (typeof provider.readInventory === 'function') {
    const value = await provider.readInventory({ diskId, signal }); cancelled(signal);
    if (value?.schemaVersion !== 1 || !validId(value.disk?.diskId) || value.disk.diskId !== diskId || typeof value.disk.model !== 'string' || value.disk.model.length > 160) throw new Error('DISK_IDENTITY_UNVERIFIED');
    if (isVirtualDiskModel(value.disk.model)) return createVirtualDemo(value.disk, now);
  }
  const identity = validateIdentity(await provider.resolveDisk({ diskId, signal }), diskId);
  cancelled(signal);
  if (isVirtualDiskModel(identity.model)) return createVirtualDemo({ diskId, model: identity.model }, now);
  const latest = validateSnapshot(await provider.readLatest({ identity, signal }), identity, now);
  cancelled(signal);
  const result = { identity, latest: withBaseline(latest, []).sample, history: [], previous: null, historyUnavailable: false, hasMore: false, nextCursor: null };
  // Do not expose cached data after authorization or generation changes.
  let page;
  try { page = await provider.readHistory({ identity, limit: 30, cursor: null, signal }); }
  catch (error) {
    cancelled(signal);
    const transient = error?.name === 'TypeError' || [408, 429].includes(error?.status) || error?.status >= 500;
    if (!transient || ['SMART_GENERATION_CHANGED', 'SMART_HISTORY_CURSOR_STALE', 'SMART_DISK_UNBOUND'].includes(errorCode(error))) throw error;
    return { ...result, historyUnavailable: true };
  }
  return readHistoryPage({ readHistory: async () => page }, result, null, signal, now);
}
