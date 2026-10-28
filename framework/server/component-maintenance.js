import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, readdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storage, atomic } from './storage.js';

export const COMPONENT_MAINTENANCE_LIMITS = Object.freeze({ backups: 50, operations: 1000, metadataBytes: 64 * 1024, journalBytes: 16 * 1024 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const actions = new Set(['repair', 'reset']);
const outcomeIds = new Set(['operation', 'backup', 'disable', 'repair', 'reset', 'inspect', 'audit', 'scope']);
const statuses = new Set(['ok', 'warning', 'failed', 'unknown', 'disabled']);
const outcomeCodes = new Set(['BACKUP_CONFIRMED', 'DISABLE_CONFIRMED', 'REPAIR_CONFIRMED', 'CACHE_RESET_CONFIRMED', 'INSPECTION_CONFIRMED', 'AUDIT_RECORDED', 'CLI_REPAIR_REQUIRED', 'MAINTENANCE_OUTCOME_UNKNOWN', 'MAINTENANCE_BACKUP_FAILED', 'MAINTENANCE_DISABLE_FAILED', 'MAINTENANCE_REPAIR_FAILED', 'MAINTENANCE_RESET_FAILED', 'MAINTENANCE_INSPECTION_FAILED', 'MAINTENANCE_AUDIT_FAILED']);
const publicErrors = new Set(['AUTHENTICATION_REQUIRED', 'ADMIN_REQUIRED', 'STORE_BUSY', 'COMPONENT_MAINTENANCE_REQUEST_INVALID', 'COMPONENT_MAINTENANCE_OPERATION_CONFLICT', 'COMPONENT_MAINTENANCE_BACKUP_LIMIT', 'COMPONENT_MAINTENANCE_OPERATION_LIMIT', 'COMPONENT_MAINTENANCE_METADATA_LIMIT', 'COMPONENT_MAINTENANCE_UNSAFE_PATH', 'COMPONENT_MAINTENANCE_JOURNAL_INVALID', 'COMPONENT_MAINTENANCE_JOURNAL_UNAVAILABLE', 'COMPONENT_MAINTENANCE_UNAVAILABLE']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error(code), { status: code === 'AUTHENTICATION_REQUIRED' ? 401 : code === 'ADMIN_REQUIRED' ? 403 : /(?:LIMIT|CONFLICT|UNSAFE_PATH)$/.test(code) ? 409 : /(?:UNAVAILABLE|JOURNAL_INVALID)$/.test(code) || code === 'STORE_BUSY' ? 503 : 400 });
function plain(value) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && !Object.getOwnPropertyDescriptor(value, key).get && !Object.getOwnPropertyDescriptor(value, key).set);
}
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();
function actorValue(actor) {
  if (!plain(actor) || typeof actor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.id)) throw error('AUTHENTICATION_REQUIRED');
  if (actor.admin !== true) throw error('ADMIN_REQUIRED');
  // Neither credentials nor arbitrary display names enter this module's audit events.
  const source = ['tower', 'cli', 'system', 'demo'].includes(actor.source) ? actor.source : 'system';
  return { id: actor.id, name: actor.id, source, admin: true };
}
function validTime(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function reportValue(report, operationId) {
  if (!exact(report, ['operationId', 'result', 'outcomes', 'requiresReload']) || report.operationId !== operationId || !['success', 'partial'].includes(report.result) || typeof report.requiresReload !== 'boolean' || !Array.isArray(report.outcomes) || report.outcomes.length === 0 || report.outcomes.length > 10 || report.outcomes.some(outcome => !exact(outcome, ['id', 'status', 'code']) || !outcomeIds.has(outcome.id) || !statuses.has(outcome.status) || !outcomeCodes.has(outcome.code))) throw error('COMPONENT_MAINTENANCE_JOURNAL_INVALID');
  if (new Set(report.outcomes.map(item => item.id)).size !== report.outcomes.length || (report.result === 'success') !== report.outcomes.every(item => item.status === 'ok')) throw error('COMPONENT_MAINTENANCE_JOURNAL_INVALID');
  return { operationId, result: report.result, outcomes: report.outcomes.map(item => ({ id: item.id, status: item.status, code: item.code })), requiresReload: report.requiresReload };
}
const unknown = operationId => ({ operationId, result: 'partial', outcomes: [{ id: 'operation', status: 'unknown', code: 'MAINTENANCE_OUTCOME_UNKNOWN' }, { id: 'scope', status: 'warning', code: 'CLI_REPAIR_REQUIRED' }], requiresReload: true });

export function createComponentMaintenance({ dataDirectory, disableAll, repairMetadata, clearCaches, inspect, audit, now = Date.now } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0') || typeof now !== 'function' || [disableAll, repairMetadata, clearCaches, inspect, audit].some(value => value !== undefined && typeof value !== 'function')) throw error('COMPONENT_MAINTENANCE_REQUEST_INVALID');
  const root = path.resolve(dataDirectory), maintenance = path.join(root, 'components-maintenance'), operations = path.join(maintenance, 'operations'), backups = path.join(maintenance, 'backups'), disk = storage(maintenance);
  async function directory(file, create = false) {
    let info;
    try { info = await lstat(file); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; if (!create) return false; await mkdir(file, { recursive: false, mode: 0o700 }).catch(failure => { if (failure.code !== 'EEXIST') throw failure; }); info = await lstat(file); }
    if (info.isSymbolicLink() || !info.isDirectory() || path.resolve(await realpath(file)) !== path.resolve(file)) throw error('COMPONENT_MAINTENANCE_UNSAFE_PATH');
    return true;
  }
  async function paths(create = false) {
    // dataDirectory is trusted server configuration, never a request field.
    await directory(root);
    if (!(await directory(maintenance, create))) return false;
    await directory(operations, create); await directory(backups, create);
    const lock = await lstat(path.join(maintenance, '.write.lock')).catch(failure => { if (failure.code === 'ENOENT') return null; throw failure; });
    if (lock && (lock.isSymbolicLink() || !lock.isFile())) throw error('COMPONENT_MAINTENANCE_UNSAFE_PATH');
    return true;
  }
  async function readBounded(file, limit) {
    let before;
    try { before = await lstat(file, { bigint: true }); } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) throw error('COMPONENT_MAINTENANCE_UNSAFE_PATH');
    if (before.size > BigInt(limit)) throw error('COMPONENT_MAINTENANCE_METADATA_LIMIT');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat({ bigint: true });
      // Windows pathname and handle device IDs differ on both NTFS and ReFS.
      // Compare volume identity between handles; keep pathname identity checks too.
      const windows = process.platform === 'win32';
      if (!opened.isFile() || !windows && opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size > BigInt(limit)) throw error('COMPONENT_MAINTENANCE_UNSAFE_PATH');
      async function verifyWindowsPath() {
        const current = await lstat(file, { bigint: true });
        if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino || path.resolve(await realpath(file)) !== path.resolve(file)) throw error('COMPONENT_MAINTENANCE_UNSAFE_PATH');
        const reference = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const info = await reference.stat({ bigint: true });
          if (!info.isFile() || info.nlink !== 1n || info.dev !== opened.dev || info.ino !== opened.ino) throw error('COMPONENT_MAINTENANCE_UNSAFE_PATH');
        } finally { await reference.close(); }
      }
      if (windows) await verifyWindowsPath();
      const buffer = Buffer.alloc(limit + 1); let size = 0;
      while (size <= limit) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (size > limit) throw error('COMPONENT_MAINTENANCE_METADATA_LIMIT');
      if (after.size !== BigInt(size) || opened.size !== after.size || opened.dev !== after.dev || opened.ino !== after.ino || after.nlink !== 1n || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) throw error('COMPONENT_MAINTENANCE_UNAVAILABLE');
      if (windows) await verifyWindowsPath();
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }
  const journalPath = id => path.join(operations, `${id}.json`);
  async function load(id) {
    let bytes; try { bytes = await readBounded(journalPath(id), COMPONENT_MAINTENANCE_LIMITS.journalBytes); } catch (failure) { if (failure.message === 'COMPONENT_MAINTENANCE_UNSAFE_PATH') throw failure; throw error('COMPONENT_MAINTENANCE_JOURNAL_UNAVAILABLE'); }
    if (bytes === null) return null;
    let value; try { value = JSON.parse(bytes); } catch { throw error('COMPONENT_MAINTENANCE_JOURNAL_INVALID'); }
    if (!exact(value, ['schemaVersion', 'operationId', 'action', 'actorHash', 'startedAt', 'phase', 'report']) || value.schemaVersion !== 1 || value.operationId !== id || !actions.has(value.action) || !/^[a-f0-9]{64}$/.test(value.actorHash) || !validTime(value.startedAt) || !['started', 'finished'].includes(value.phase) || value.phase === 'started' && value.report !== null) throw error('COMPONENT_MAINTENANCE_JOURNAL_INVALID');
    if (value.phase === 'finished') reportValue(value.report, id);
    return value;
  }
  function replay(record, action, actorHash) {
    if (record.action !== action || record.actorHash !== actorHash) throw error('COMPONENT_MAINTENANCE_OPERATION_CONFLICT');
    return record.phase === 'finished' ? reportValue(record.report, record.operationId) : unknown(record.operationId);
  }
  async function backup(id) {
    const framework = path.join(root, 'framework'); const available = await directory(framework);
    const originals = [];
    if (available) for (const name of ['settings.json', 'disabled.json']) { const bytes = await readBounded(path.join(framework, name), COMPONENT_MAINTENANCE_LIMITS.metadataBytes); if (bytes !== null) originals.push({ name, bytes }); }
    const destination = path.join(backups, id); await mkdir(destination, { mode: 0o700 });
    for (const original of originals) {
      const handle = await open(path.join(destination, original.name), 'wx', 0o600);
      try { await handle.writeFile(original.bytes); await handle.sync(); } finally { await handle.close(); }
    }
    await atomic(path.join(destination, 'manifest.json'), { schemaVersion: 1, operationId: id, files: originals.map(item => ({ id: item.name === 'settings.json' ? 'framework-settings' : 'framework-disabled', bytes: item.bytes.length, sha256: hash(item.bytes) })) });
  }
  async function run(action, input, actor) {
    try {
      const safeActor = actorValue(actor);
      if (!actions.has(action) || !exact(input, ['operationId', 'acknowledged']) || typeof input.operationId !== 'string' || !uuid.test(input.operationId) || input.acknowledged !== true) throw error('COMPONENT_MAINTENANCE_REQUEST_INVALID');
      const id = input.operationId, actorHash = hash(JSON.stringify([safeActor.source, safeActor.id]));
      if (await paths()) { const previous = await load(id); if (previous) return replay(previous, action, actorHash); }
      await paths(true);
      return await disk.locked(async () => {
        await paths(true);
        const previous = await load(id); if (previous) return replay(previous, action, actorHash);
        if ((await readdir(backups)).length >= COMPONENT_MAINTENANCE_LIMITS.backups) throw error('COMPONENT_MAINTENANCE_BACKUP_LIMIT');
        if ((await readdir(operations)).length >= COMPONENT_MAINTENANCE_LIMITS.operations) throw error('COMPONENT_MAINTENANCE_OPERATION_LIMIT');
        const clock = now(); if (!Number.isSafeInteger(clock) || clock < 0 || clock > 253402300799999) throw error('COMPONENT_MAINTENANCE_REQUEST_INVALID');
        const intent = { schemaVersion: 1, operationId: id, action, actorHash, startedAt: new Date(clock).toISOString(), phase: 'started', report: null };
        try { await atomic(journalPath(id), intent); } catch { throw error('COMPONENT_MAINTENANCE_JOURNAL_UNAVAILABLE'); }
        const outcomes = []; let requiresReload = false, auditOk = typeof audit === 'function', disabled = false, prepared = false;
        const outcome = (id, status, code) => outcomes.push({ id, status, code });
        if (auditOk) { try { await audit({ actor: safeActor, action: `components.${action}.started`, operationId: id, pluginId: null, result: 'started', code: null }); } catch { auditOk = false; } }
        try { await backup(id); prepared = true; outcome('backup', 'ok', 'BACKUP_CONFIRMED'); }
        catch { outcome('backup', 'failed', 'MAINTENANCE_BACKUP_FAILED'); }
        if (prepared && typeof disableAll === 'function') {
          requiresReload = true;
          try { const result = await disableAll(safeActor); disabled = result?.enabled === false && result?.sshRevoked === true; outcome('disable', disabled ? 'ok' : 'failed', disabled ? 'DISABLE_CONFIRMED' : 'MAINTENANCE_DISABLE_FAILED'); }
          catch { outcome('disable', 'failed', 'MAINTENANCE_DISABLE_FAILED'); }
        } else outcome('disable', 'warning', 'CLI_REPAIR_REQUIRED');
        const task = action === 'repair' ? repairMetadata : clearCaches;
        if (disabled && typeof task === 'function') {
          try { await task(safeActor); outcome(action, 'ok', action === 'repair' ? 'REPAIR_CONFIRMED' : 'CACHE_RESET_CONFIRMED'); }
          catch { outcome(action, 'failed', action === 'repair' ? 'MAINTENANCE_REPAIR_FAILED' : 'MAINTENANCE_RESET_FAILED'); }
        } else outcome(action, 'warning', 'CLI_REPAIR_REQUIRED');
        let requiresCli = true;
        if (typeof inspect === 'function') {
          try { const check = await inspect(safeActor); const verified = check?.verified === true || check?.ok === true; requiresCli = !verified || check.requiresCli !== false; outcome('inspect', verified ? 'ok' : 'failed', verified ? 'INSPECTION_CONFIRMED' : 'MAINTENANCE_INSPECTION_FAILED'); }
          catch { outcome('inspect', 'failed', 'MAINTENANCE_INSPECTION_FAILED'); }
        } else outcome('inspect', 'warning', 'CLI_REPAIR_REQUIRED');
        // This local repair does not recreate a Deployment, gateway or Island registration.
        if (requiresCli || outcomes.some(item => item.status !== 'ok')) outcome('scope', 'warning', 'CLI_REPAIR_REQUIRED');
        if (typeof audit === 'function') {
          try { await audit({ actor: safeActor, action: `components.${action}`, operationId: id, pluginId: null, result: outcomes.every(item => item.status === 'ok') && auditOk ? 'success' : 'failed', code: outcomes.every(item => item.status === 'ok') && auditOk ? null : 'CLI_REPAIR_REQUIRED' }); }
          catch { auditOk = false; }
        }
        outcome('audit', auditOk ? 'ok' : 'warning', auditOk ? 'AUDIT_RECORDED' : 'MAINTENANCE_AUDIT_FAILED');
        if (!auditOk && !outcomes.some(item => item.id === 'scope')) outcome('scope', 'warning', 'CLI_REPAIR_REQUIRED');
        const report = { operationId: id, result: outcomes.every(item => item.status === 'ok') ? 'success' : 'partial', outcomes, requiresReload };
        try { await atomic(journalPath(id), { ...intent, phase: 'finished', report }); } catch { return unknown(id); }
        return reportValue(report, id);
      });
    } catch (failure) { throw error(publicErrors.has(failure?.message) ? failure.message : 'COMPONENT_MAINTENANCE_UNAVAILABLE'); }
  }
  return { run };
}
