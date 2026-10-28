import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomic, storage } from './storage.js';
import { validId } from '../shared/identity.js';
import { createSmartHistory } from './smart-history.js';
import { sanitizeSmartOutput, smartFailureCode } from './smart-data.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const operation = 'disk.smart.read', source = 'host-smartctl';
const failure = (code, status = 503) => Object.assign(new Error(code), { status });
const keyFor = diskId => createHash('sha256').update(diskId).digest('hex');
const sameToken = (left, right) => hex(left) && hex(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const actorCheck = actor => { if (!actor || !text(actor.id, 128) || !['tower', 'cli', 'demo'].includes(actor.source)) throw failure('AUTHENTICATION_REQUIRED', 401); };
const admin = actor => { actorCheck(actor); if (actor.admin !== true) throw failure('ADMIN_REQUIRED', 403); };
const cancelled = signal => { if (signal?.aborted) throw failure('SMART_EXECUTION_CANCELLED', 409); };

export function createSmartProvider(directory, { readDisk, vault, history = createSmartHistory(directory), pluginStatus } = {}) {
  if (typeof readDisk !== 'function' || typeof pluginStatus !== 'function' || !vault || typeof vault.get !== 'function' || !history || !['append', 'latest', 'page'].every(name => typeof history[name] === 'function')) throw failure('SMART_PROVIDER_REQUIRED');
  const root = path.join(path.resolve(directory), 'smart-provider'), disk = storage(root), keyFile = path.join(root, 'key.json'), bindingsFile = path.join(root, 'bindings.json');
  async function readJson(file, max, fallback) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > max || process.platform !== 'win32' && (info.mode & 0o077)) throw failure('SMART_PROVIDER_CORRUPT');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return fallback; throw failure('SMART_PROVIDER_CORRUPT'); }
  }
  async function key() {
    let value = await readJson(keyFile, 256, null);
    if (value === null) {
      const existing = await readJson(bindingsFile, 8 * 1024 * 1024, null);
      let historyExists = false;
      try { historyExists = (await readdir(path.join(path.resolve(directory), 'smart-history'))).some(name => name !== '.write.lock'); } catch (error) { if (error.code !== 'ENOENT') throw failure('SMART_PROVIDER_CORRUPT'); }
      if (existing !== null || historyExists) throw failure('SMART_GENERATION_KEY_MISSING');
      value = { version: 1, key: randomBytes(32).toString('hex') }; await atomic(keyFile, value);
    }
    if (!exact(value, ['version', 'key']) || value.version !== 1 || !hex(value.key)) throw failure('SMART_PROVIDER_CORRUPT');
    return Buffer.from(value.key, 'hex');
  }
  const hmac = (secret, purpose, value) => createHmac('sha256', secret).update(purpose + '\0' + JSON.stringify(value)).digest('hex');
  const generation = (secret, tower) => hmac(secret, 'physical-disk-generation-v1', { diskId: tower.id, hostId: tower.hostId, serial: tower.serial });
  const towerToken = (secret, tower) => hmac(secret, 'tower-binding-v1', { diskId: tower.id, hostId: tower.hostId, serial: tower.serial, path: tower.path });
  const targetToken = (secret, host, device) => hmac(secret, 'ssh-binding-v1', { profileHostId: host.hostId, deviceId: device.deviceId, serial: device.serial, path: device.path, address: host.address, port: host.port, username: host.username, hostKeySha256: host.hostKeySha256 });
  const signBinding = (secret, { bindingToken, ...row }) => hmac(secret, 'binding-record-v1', row);
  async function bindingsData(secret) {
    const value = await readJson(bindingsFile, 8 * 1024 * 1024, { version: 1, items: {} });
    if (!exact(value, ['version', 'items']) || value.version !== 1 || !object(value.items) || Object.keys(value.items).length > 10000) throw failure('SMART_PROVIDER_CORRUPT');
    for (const [id, row] of Object.entries(value.items)) if (!hex(id) || !exact(row, ['diskId', 'hostId', 'profileHostId', 'deviceId', 'generation', 'towerToken', 'targetToken', 'bindingToken', 'nonce']) || !identifier(row.diskId) || !identifier(row.hostId) || !identifier(row.profileHostId) || !identifier(row.deviceId) || keyFor(row.diskId) !== id || !['generation', 'towerToken', 'targetToken', 'bindingToken', 'nonce'].every(name => hex(row[name])) || !sameToken(row.bindingToken, signBinding(secret, row))) throw failure('SMART_PROVIDER_CORRUPT');
    return value;
  }
  async function allowed(pluginId) {
    if (!validId(pluginId)) throw failure('INVALID_PLUGIN_ID', 400);
    let plugin; try { plugin = await pluginStatus(pluginId); } catch { throw failure('SMART_PLUGIN_STATUS_UNAVAILABLE'); }
    if (!plugin?.installed || !plugin.active || !['ssh.channel.use', 'disk.smart.read', 'inventory.read'].every(permission => plugin.manifest?.permissions?.includes(permission)) || !plugin.manifest.ssh?.commands?.some(command => command.operation === operation)) throw failure('SMART_PLUGIN_DISABLED', 403);
  }
  async function authorized(diskId, actor, signal) {
    actorCheck(actor); if (!identifier(diskId)) throw failure('SMART_DISK_REQUEST_INVALID', 400); cancelled(signal);
    let timer, abort;
    try {
      const tower = await Promise.race([
        Promise.resolve().then(() => readDisk({ diskId, actor, ...(signal ? { signal } : {}) })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('SMART_DISK_READ_TIMEOUT')), 8000); timer.unref?.(); }),
        new Promise((_, reject) => { if (signal) { abort = () => reject(failure('SMART_EXECUTION_CANCELLED', 409)); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); } }),
      ]);
      cancelled(signal);
      if (!tower || tower.id !== diskId || !identifier(tower.hostId) || !text(tower.serial, 256) || !text(tower.path, 256) || !text(tower.model, 512)) throw failure('SMART_DISK_RESPONSE_INVALID');
      return tower;
    } catch (error) {
      if (error.message === 'AUTHENTICATION_REQUIRED' || error.status === 401) throw failure('AUTHENTICATION_REQUIRED', 401);
      if (['SMART_DISK_READ_TIMEOUT', 'SMART_DISK_RESPONSE_INVALID'].includes(error.message)) throw failure(error.message);
      if (error.message === 'SMART_EXECUTION_CANCELLED') throw failure('SMART_EXECUTION_CANCELLED', 409);
      if (error.status === 403) throw failure('SMART_DISK_FORBIDDEN', 403);
      if (error.message === 'TOWER_DISK_NOT_FOUND' || error.status === 404) throw failure('SMART_DISK_NOT_FOUND', 404);
      throw failure('SMART_DISK_READ_FAILED');
    } finally { clearTimeout(timer); if (signal && abort) signal.removeEventListener('abort', abort); }
  }
  async function target(profileHostId, deviceId) {
    let host; try { host = await vault.get(profileHostId); } catch { throw failure('SMART_PROFILE_UNAVAILABLE'); }
    const device = host.devices?.find(item => item.deviceId === deviceId);
    if (!device || !text(device.serial, 256) || !text(device.path, 256)) throw failure('SMART_DEVICE_UNAVAILABLE');
    return { host, device };
  }
  const publicIdentity = (tower, row) => ({ diskId: tower.id, hostId: tower.hostId, generation: row.generation, deviceId: row.generation, path: '', model: tower.model });
  const summary = row => ({ diskId: row.diskId, hostId: row.hostId, profileHostId: row.profileHostId, deviceId: row.deviceId, generation: row.generation });
  async function verify(tower, requestedGeneration) {
    const secret = await key(), data = await bindingsData(secret), row = data.items[keyFor(tower.id)];
    if (!row) throw failure('SMART_DISK_UNBOUND', 404);
    const actual = generation(secret, tower);
    if (row.generation !== actual || requestedGeneration !== undefined && requestedGeneration !== actual) throw failure('SMART_GENERATION_CHANGED', 409);
    if (row.hostId !== tower.hostId || !sameToken(row.towerToken, towerToken(secret, tower))) throw failure('SMART_BINDING_CHANGED', 409);
    const selected = await target(row.profileHostId, row.deviceId);
    if (!sameToken(row.targetToken, targetToken(secret, selected.host, selected.device))) throw failure('SMART_BINDING_CHANGED', 409);
    return { row, identity: publicIdentity(tower, row) };
  }
  async function readContext(input, requireGeneration = true) {
    if (!exact(input, ['pluginId', 'diskId', 'generation', 'actor', 'signal', 'limit', 'cursor']) || requireGeneration && !hex(input.generation)) throw failure('SMART_DISK_REQUEST_INVALID', 400);
    actorCheck(input.actor);
    await allowed(input.pluginId); const tower = await authorized(input.diskId, input.actor, input.signal);
    return disk.locked(async () => { cancelled(input.signal); return verify(tower, input.generation); });
  }
  function snapshot(record, identity) {
    if (!record) return { schemaVersion: 1, source, identity, status: 'unavailable', code: 'SMART_NO_SAMPLE', collectedAt: null };
    return { schemaVersion: 1, source, identity, status: record.status, collectedAt: record.collectedAt,
      ...(record.status === 'ok' ? { smart: record.smart } : { code: record.code }), ...(record.gapCode ? { gapCode: record.gapCode } : {}) };
  }
  async function historyRead(task) {
    try { return await task(); } catch (error) {
      if (/^SMART_HISTORY_CURSOR_(?:INVALID|EXPIRED)$/.test(error.message)) throw failure(error.message, 400);
      if (error.message === 'SMART_HISTORY_CURSOR_STALE') throw failure(error.message, 409);
      if (error.message === 'SMART_HISTORY_PAGE_LIMIT_INVALID') throw failure(error.message, 400);
      throw failure('SMART_HISTORY_UNAVAILABLE');
    }
  }
  return {
    async resolveDisk(input) { const { identity } = await readContext(input, false); return identity; },
    async collectionTarget(input) {
      admin(input?.actor);
      const { row } = await readContext(input);
      return { profileHostId: row.profileHostId, deviceId: row.deviceId, generation: row.generation, bindingToken: row.bindingToken };
    },
    async readLatest(input) {
      const { identity } = await readContext(input);
      const { record } = await historyRead(() => history.latest({ pluginId: input.pluginId, diskId: identity.diskId, hostId: identity.hostId, generation: identity.generation }));
      cancelled(input.signal); return snapshot(record, identity);
    },
    async readHistory(input) {
      const { identity } = await readContext(input);
      const result = await historyRead(() => history.page({ pluginId: input.pluginId, diskId: identity.diskId, hostId: identity.hostId, generation: identity.generation,
        ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor == null ? {} : { cursor: input.cursor }) }));
      cancelled(input.signal); return { schemaVersion: 1, source, identity, items: result.items.map(record => snapshot(record, identity)), nextCursor: result.nextCursor, snapshotAt: result.snapshotAt };
    },
    async bind(input) {
      if (!exact(input, ['diskId', 'profileHostId', 'deviceId', 'actor']) || !identifier(input.profileHostId) || !identifier(input.deviceId)) throw failure('SMART_DISK_REQUEST_INVALID', 400);
      admin(input.actor); const tower = await authorized(input.diskId, input.actor);
      return disk.locked(async () => {
        const secret = await key(), data = await bindingsData(secret), { host, device } = await target(input.profileHostId, input.deviceId);
        if (tower.serial !== device.serial || tower.path !== device.path) throw failure('SMART_BINDING_IDENTITY_MISMATCH', 409);
        if (Object.values(data.items).some(row => row.diskId !== tower.id && row.profileHostId === input.profileHostId && row.deviceId === input.deviceId)) throw failure('SMART_BINDING_AMBIGUOUS', 409);
        const id = keyFor(tower.id); if (!data.items[id] && Object.keys(data.items).length >= 10000) throw failure('SMART_BINDING_LIMIT');
        const row = { diskId: tower.id, hostId: tower.hostId, profileHostId: input.profileHostId, deviceId: input.deviceId, generation: generation(secret, tower), towerToken: towerToken(secret, tower), targetToken: targetToken(secret, host, device), nonce: randomBytes(32).toString('hex') };
        row.bindingToken = signBinding(secret, row);
        data.items[id] = row;
        if (Buffer.byteLength(JSON.stringify(data, null, 2) + '\n') > 8 * 1024 * 1024) throw failure('SMART_BINDING_LIMIT');
        await atomic(bindingsFile, data); return { ...summary(row), bound: true };
      });
    },
    async unbind(input) {
      if (!exact(input, ['diskId', 'actor'])) throw failure('SMART_DISK_REQUEST_INVALID', 400);
      admin(input.actor); await authorized(input.diskId, input.actor);
      return disk.locked(async () => { const secret = await key(), data = await bindingsData(secret); const id = keyFor(input.diskId), removed = Boolean(data.items[id]); delete data.items[id]; await atomic(bindingsFile, data); return { diskId: input.diskId, removed }; });
    },
    async bindings(actor) { admin(actor); return disk.locked(async () => { const secret = await key(); return { items: Object.values((await bindingsData(secret)).items).map(summary) }; }); },
    async prepareResultContext(input) {
      if (!input || input.operation !== operation) return undefined;
      await allowed(input.pluginId);
      if (!identifier(input.hostId) || !identifier(input.deviceId)) return undefined;
      return disk.locked(async () => {
        const secret = await key(), matches = Object.values((await bindingsData(secret)).items).filter(row => row.profileHostId === input.hostId && row.deviceId === input.deviceId);
        if (matches.length !== 1) return undefined;
        const row = matches[0], { host, device } = await target(row.profileHostId, row.deviceId);
        if (!sameToken(row.targetToken, targetToken(secret, host, device)) || input.host && !sameToken(row.targetToken, targetToken(secret, input.host, input.host.devices?.find(item => item.deviceId === input.deviceId) || {}))) return undefined;
        return { pluginId: input.pluginId, diskId: row.diskId, hostId: row.hostId, profileHostId: row.profileHostId, deviceId: row.deviceId, generation: row.generation, bindingToken: row.bindingToken };
      });
    },
    async onResult(item, context, { signal, assertActive } = {}) {
      if (!context || item?.operation !== operation) return { recorded: false };
      if (!exact(context, ['pluginId', 'diskId', 'hostId', 'profileHostId', 'deviceId', 'generation', 'bindingToken']) || !validId(context.pluginId) || !['diskId', 'hostId', 'profileHostId', 'deviceId'].every(name => identifier(context[name])) || !hex(context.generation) || !hex(context.bindingToken) || item.pluginId !== context.pluginId || item.hostId !== context.profileHostId || item.deviceId !== context.deviceId) throw failure('SMART_RESULT_CONTEXT_INVALID', 409);
      if (typeof assertActive !== 'function') throw failure('SMART_COMMIT_GUARD_REQUIRED');
      await allowed(context.pluginId);
      return disk.locked(async () => {
        const secret = await key(), row = (await bindingsData(secret)).items[keyFor(context.diskId)];
        if (!row || row.generation !== context.generation || row.hostId !== context.hostId || row.profileHostId !== context.profileHostId || row.deviceId !== context.deviceId || !sameToken(row.bindingToken, context.bindingToken)) throw failure('SMART_BINDING_CHANGED', 409);
        const { host, device } = await target(row.profileHostId, row.deviceId);
        if (!sameToken(row.targetToken, targetToken(secret, host, device))) throw failure('SMART_BINDING_CHANGED', 409);
        const record = { pluginId: context.pluginId, diskId: context.diskId, hostId: context.hostId, generation: context.generation, operation, operationId: item.id, collectedAt: item.finishedAt };
        if (item.result === 'success') {
          try { record.smart = sanitizeSmartOutput(item.stdout, item.exitCode, { expectedSerial: device.serial }); record.status = 'ok'; }
          catch (error) { record.status = error.message === 'SMART_UNSUPPORTED' ? 'unsupported' : 'unavailable'; record.code = smartFailureCode(error.message); }
        } else { record.status = 'unavailable'; record.code = smartFailureCode(item.code); }
        const publication = await history.append(record, { beforeCommit: async () => {
          cancelled(signal); await allowed(context.pluginId); await assertActive(); cancelled(signal);
          const latest = (await bindingsData(secret)).items[keyFor(context.diskId)], selected = await target(row.profileHostId, row.deviceId);
          if (!latest || !sameToken(latest.bindingToken, context.bindingToken) || !sameToken(row.targetToken, targetToken(secret, selected.host, selected.device))) throw failure('SMART_BINDING_CHANGED', 409);
        } });
        return { ...publication, collectedStatus: record.status, ...(record.code ? { collectedCode: record.code } : {}) };
      });
    },
  };
}
