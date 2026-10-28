import path from 'node:path';
import { readFile, lstat, mkdir, readdir, unlink, open } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { atomic, storage } from './storage.js';
import { patchConnection, validateConnection, connectionSummary, resolveConnection } from './ssh-connection-settings.js';
import { sshIdentifier } from './ssh-policy.js';
import { createDeviceResolver, emptyPolicy, hostTarget, exact, canonical, sign, problem } from './ssh-device-policy.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const empty = () => ({ version: 2, revision: 0, updatedAt: null, operationId: null, requestDigest: null, global: null, clusters: [], hosts: [], selectionIdentities: {}, pendingLegacyRefs: {}, migrationId: null });
function validate(document) {
  if (!exact(document, Object.keys(empty())) || document.version !== 2 || !Number.isSafeInteger(document.revision) || document.revision < 0 || !(document.operationId === null || uuid(document.operationId)) || !(document.requestDigest === null || hex(document.requestDigest)) || !(document.updatedAt === null || Number.isFinite(Date.parse(document.updatedAt))) || !(document.migrationId === null || uuid(document.migrationId))) throw problem('SSH_VAULT_INVALID', 503);
  if (document.global !== null) validateConnection(document.global);
  if (!Array.isArray(document.clusters) || document.clusters.length > 500 || !Array.isArray(document.hosts) || document.hosts.length > 500) throw problem('SSH_VAULT_INVALID', 503);
  const groups = new Set(), hosts = new Set();
  for (const row of document.clusters) {
    if (!exact(row, ['clusterId', 'connection']) || !sshIdentifier(row.clusterId) || groups.has(row.clusterId) || row.connection === null) throw problem('SSH_VAULT_INVALID', 503);
    groups.add(row.clusterId); validateConnection(row.connection);
  }
  for (const row of document.hosts) {
    if (!exact(row, ['hostId', 'clusterId', 'address', 'port', 'hostKeySha256', 'devicePolicy', 'connection']) || hosts.has(row.hostId)) throw problem('SSH_VAULT_INVALID', 503);
    hosts.add(row.hostId); hostTarget(row); if (row.connection !== null) validateConnection(row.connection);
  }
  for (const name of ['selectionIdentities', 'pendingLegacyRefs']) if (document[name] === null || typeof document[name] !== 'object' || Array.isArray(document[name]) || Object.keys(document[name]).length > 10000) throw problem('SSH_VAULT_INVALID', 503);
  for (const [id, value] of Object.entries(document.selectionIdentities)) if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(id) || !hex(value)) throw problem('SSH_VAULT_INVALID', 503);
  for (const [id, values] of Object.entries(document.pendingLegacyRefs)) if (!hosts.has(id) || !Array.isArray(values) || values.length > 1000) throw problem('SSH_VAULT_INVALID', 503);
  return document;
}
function summary(document, legacy = false) {
  return { version: 2, revision: document.revision, updatedAt: document.updatedAt, operationId: document.operationId, global: connectionSummary(document.global),
    clusters: document.clusters.map(row => ({ clusterId: row.clusterId, connection: connectionSummary(row.connection) })),
    hosts: document.hosts.map(row => {
      const { connection, ...target } = row, resolved = resolveConnection(document, row), effective = connectionSummary(resolved.connection), unresolved = document.pendingLegacyRefs[row.hostId]?.length || 0;
      return { ...target, connection: connectionSummary(connection), effective: { source: resolved.source, username: effective?.username || '', authType: effective?.authType || '', hasPassword: effective?.hasPassword || false, hasPrivateKey: effective?.hasPrivateKey || false, ready: Boolean(effective?.hasPassword || effective?.hasPrivateKey) }, policyState: { disk: unresolved ? 'unresolved' : 'ready', unresolvedLegacyCount: unresolved, changedSelectionCount: 0 } };
    }), migration: { persistedVersion: legacy ? 1 : 2, required: legacy, state: legacy ? 'required' : 'ready' } };
}
function project(old) {
  const value = { ...empty(), revision: old.revision, updatedAt: old.updatedAt, global: old.global, clusters: old.clusters };
  value.hosts = old.hosts.map(({ devices, ...row }) => {
    value.pendingLegacyRefs[row.hostId] = devices;
    const policy = emptyPolicy(); policy.classes.disk = { mode: 'custom', ids: [] };
    return { ...row, devicePolicy: policy };
  });
  return value;
}

export function createConnectionsV2({ root, key, legacy, request } = {}) {
  const disk = storage(root), filename = path.join(root, 'connections.v2.json'), oldFile = path.join(root, 'connections.v1.json');
  const barrier = path.join(root, 'mutation.v2.json'), ledgerFile = path.join(root, 'operations.v2.json');
  const resolver = createDeviceResolver({ request, key });
  async function clearBarrier() {
    await unlink(barrier);
    if (process.platform !== 'win32') { const handle = await open(root, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  }
  async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  async function secure(file, max = 4 * 1024 * 1024) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max || process.platform !== 'win32' && (info.mode & 0o077)) throw problem('SSH_VAULT_INVALID', 503);
    return JSON.parse(await readFile(file, 'utf8'));
  }
  async function active() { return await exists(filename) || await exists(barrier) || (await exists(oldFile) && (await secure(oldFile)).version === 2); }
  async function assertReady() { if (await exists(barrier)) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN'); }
  async function read(recovering = false) {
    if (!recovering) await assertReady();
    if (!await exists(filename)) {
      if (!recovering && await active()) throw problem('SSH_CONNECTION_MIGRATION_INCOMPLETE');
      return null;
    }
    const outer = await secure(filename), tombstone = recovering ? null : await secure(oldFile);
    if (!exact(outer, ['version', 'iv', 'tag', 'ciphertext']) || outer.version !== 2 || !/^[a-f0-9]{24}$/.test(outer.iv) || !/^[a-f0-9]{32}$/.test(outer.tag) || !/^(?:[a-f0-9]{2})+$/.test(outer.ciphertext) || !recovering && (!exact(tombstone, ['version', 'state', 'migrationId']) || tombstone.version !== 2 || tombstone.state !== 'migrated' || !uuid(tombstone.migrationId))) throw problem('SSH_VAULT_INVALID', 503);
    let plaintext;
    try {
      const cipher = createDecipheriv('aes-256-gcm', await key(false), Buffer.from(outer.iv, 'hex'));
      cipher.setAAD(Buffer.from('rivetin-ssh-connections-v2')); cipher.setAuthTag(Buffer.from(outer.tag, 'hex'));
      plaintext = Buffer.concat([cipher.update(Buffer.from(outer.ciphertext, 'hex')), cipher.final()]);
      const result = validate(JSON.parse(plaintext));
      if (!recovering && result.migrationId !== tombstone.migrationId) throw problem('SSH_VAULT_INVALID', 503);
      return result;
    } catch (error) { throw error.code === 'ENOENT' ? problem('SSH_VAULT_KEY_MISSING', 503) : /^SSH_/.test(error.message) ? error : problem('SSH_VAULT_INVALID', 503); }
    finally { plaintext?.fill(0); }
  }
  async function current() {
    const saved = await read(); if (saved) return { document: saved, required: false };
    const old = await legacy();
    return { document: project(old), required: old.hosts.length > 0 || old.revision > 0 || await exists(oldFile) };
  }
  async function write(document) {
    validate(document); const bytes = Buffer.from(JSON.stringify(document));
    if (bytes.length > 1024 * 1024) throw problem('SSH_CONNECTION_SETTINGS_TOO_LARGE', 413);
    try {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv); cipher.setAAD(Buffer.from('rivetin-ssh-connections-v2'));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      await atomic(filename, { version: 2, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
    } finally { bytes.fill(0); }
  }
  async function ledger() {
    if (!await exists(ledgerFile)) return { version: 2, items: [] };
    const value = await secure(ledgerFile, 8 * 1024 * 1024);
    if (!exact(value, ['version', 'items']) || value.version !== 2 || !Array.isArray(value.items) || value.items.length > 10000 || value.items.some(row => !exact(row, ['id', 'actor', 'digest', 'revision', 'state']) || !uuid(row.id) || !hex(row.actor) || !hex(row.digest) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !['pending', 'committed', 'aborted'].includes(row.state)) || new Set(value.items.map(row => row.id)).size !== value.items.length) throw problem('SSH_VAULT_INVALID', 503);
    return value;
  }
  async function save(input, actor, revoke) {
    if (!input || input.version !== 2) throw problem('SSH_CONNECTION_VERSION_UNSUPPORTED');
    if (!exact(input, ['version', 'operationId', 'expectedRevision', 'global', 'clusters', 'hosts', 'selectionProofs']) || !uuid(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Array.isArray(input.hosts) || input.hosts.length > 500 || !Array.isArray(input.clusters) || input.clusters.length > 500 || Buffer.byteLength(canonical(input)) > 1024 * 1024) throw problem('SSH_CONNECTION_SETTINGS_INVALID', 400);
    return disk.locked(async () => {
      const secret = await key(), log = await ledger(), digest = sign(secret, 'request-digest-v2', input), owner = sign(secret, 'operation-owner-v2', [actor.source, actor.id]);
      const previousOp = log.items.find(row => row.id === input.operationId);
      if (previousOp) {
        if (previousOp.actor !== owner || previousOp.digest !== digest) throw problem('SSH_CONNECTION_OPERATION_CONFLICT');
        if (previousOp.state !== 'committed') throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
        return { version: 2, operationId: input.operationId, committedRevision: previousOp.revision, replayed: true, connections: await connections() };
      }
      const state = await current(), previous = state.document;
      if (state.required) throw problem('SSH_CONNECTION_MIGRATION_REQUIRED');
      if (previous.revision !== input.expectedRevision) throw problem('SSH_CONNECTION_REVISION_CONFLICT');
      if (log.items.length >= 10000) throw problem('SSH_CONNECTION_OPERATION_LIMIT');
      const next = { ...empty(), migrationId: previous.migrationId || randomUUID(), revision: previous.revision + 1, operationId: input.operationId, requestDigest: digest, updatedAt: new Date().toISOString(), global: patchConnection(input.global, previous.global),
        clusters: input.clusters.map(row => { if (!exact(row, ['clusterId', 'connection'])) throw problem('SSH_CONNECTION_SETTINGS_INVALID', 400); return { clusterId: row.clusterId, connection: patchConnection(row.connection, previous.clusters.find(item => item.clusterId === row.clusterId)?.connection) }; }),
        hosts: input.hosts.map(row => { if (!exact(row, ['hostId', 'clusterId', 'address', 'port', 'hostKeySha256', 'devicePolicy', 'connection'])) throw problem('SSH_CONNECTION_SETTINGS_INVALID', 400); return { ...structuredClone(row), connection: patchConnection(row.connection, previous.hosts.find(item => item.hostId === row.hostId)?.connection) }; }) };
      validate(next); next.selectionIdentities = await resolver.validate(next, previous, input.selectionProofs, actor);
      for (const host of next.hosts) {
        const old = previous.hosts.find(row => row.hostId === host.hostId);
        if (previous.pendingLegacyRefs[host.hostId]?.length && canonical(host.devicePolicy) === canonical(old?.devicePolicy)) next.pendingLegacyRefs[host.hostId] = previous.pendingLegacyRefs[host.hostId];
      }
      const entry = { id: input.operationId, actor: owner, digest, revision: next.revision, state: 'pending' };
      await atomic(barrier, { version: 2, operationId: entry.id, revision: entry.revision, digest });
      log.items.push(entry); await atomic(ledgerFile, log);
      try { await revoke(); } catch { throw problem('SSH_CONNECTION_REVOKE_FAILED', 503); }
      // A crash after ciphertext commit keeps the barrier. No uncertain write is replayed.
      await write(next);
      await atomic(oldFile, { version: 2, state: 'migrated', migrationId: next.migrationId });
      entry.state = 'committed'; await atomic(ledgerFile, log); await clearBarrier();
      return { version: 2, operationId: input.operationId, committedRevision: next.revision, replayed: false, connections: summary(next) };
    });
  }
  async function connections() { const value = await current(); return summary(value.document, value.required); }
  async function targets(actor) { await assertReady(); const document = await read(); return document ? resolver.targets(document, actor) : null; }
  async function migrate({ direction, operationId, stopped }, revoke) {
    if (!uuid(operationId) || stopped !== true || !['upgrade', 'rollback', 'recover'].includes(direction)) throw problem('SSH_CONNECTION_MIGRATION_REQUIRED');
    return disk.locked(async () => {
      if (direction === 'recover') {
        if (!await exists(barrier)) return { recovered: true, changed: false };
        const intent = await secure(barrier), log = await ledger(), saved = await read(true);
        if (!exact(intent, ['version', 'operationId', 'revision', 'digest']) || intent.version !== 2 || intent.operationId !== operationId || !Number.isSafeInteger(intent.revision) || intent.revision < 1 || intent.digest !== null && !hex(intent.digest)) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
        if (intent.digest === null && saved?.migrationId === operationId && saved.revision === intent.revision && saved.operationId === null) {
          await revoke(); await atomic(oldFile, { version: 2, state: 'migrated', migrationId: saved.migrationId }); await clearBarrier();
          return { recovered: true, revision: saved.revision, approvalsRevoked: true };
        }
        if (intent.digest === null && !saved) {
          const backup = path.join(root, 'migrations', operationId), manifest = await secure(path.join(backup, 'manifest.json'));
          if (manifest.operationId !== operationId || manifest.direction !== 'upgrade' || manifest.revision !== intent.revision || !Array.isArray(manifest.files) || manifest.files.length > 504) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
          for (const row of manifest.files) {
            if (!['key.json', 'connections.v1.json', 'operations.v2.json'].includes(row.name) && !/^[A-Za-z0-9_-]+\.host\.json$/.test(row.name)) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
            await secure(path.join(backup, row.name)); await secure(path.join(root, row.name));
            if (!hex(row.sha256) || createHash('sha256').update(await readFile(path.join(backup, row.name))).digest('hex') !== row.sha256 || createHash('sha256').update(await readFile(path.join(root, row.name))).digest('hex') !== row.sha256) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
          }
          if (!manifest.files.some(row => row.name === 'connections.v1.json') && await exists(oldFile)) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
          await revoke(); await atomic(path.join(backup, 'recovery.json'), { operationId, committed: false, approvalsRevoked: true }); await clearBarrier();
          return { recovered: true, committed: false, approvalsRevoked: true };
        }
        const entry = log.items.find(row => row.id === operationId);
        if (!entry || entry.digest !== intent.digest || entry.revision !== intent.revision) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
        if ((saved?.revision || 0) === intent.revision - 1) {
          await revoke(); entry.state = 'aborted'; await atomic(ledgerFile, log); await clearBarrier();
          return { recovered: true, committed: false, approvalsRevoked: true };
        }
        if (!saved || saved.operationId !== operationId || saved.revision !== intent.revision || saved.requestDigest !== intent.digest) throw problem('SSH_CONNECTION_OUTCOME_UNKNOWN');
        await revoke(); await atomic(oldFile, { version: 2, state: 'migrated', migrationId: saved.migrationId });
        entry.state = 'committed'; await atomic(ledgerFile, log); await clearBarrier();
        return { recovered: true, revision: saved.revision, approvalsRevoked: true };
      }
      await assertReady();
      const backup = path.join(root, 'migrations', operationId);
      if (direction === 'rollback') {
        const saved = await read(), manifest = await secure(path.join(backup, 'manifest.json'));
        if (!saved || saved.migrationId !== operationId || saved.operationId !== null || saved.revision !== manifest.revision || manifest.direction !== 'upgrade') throw problem('SSH_CONNECTION_DOWNGRADE_UNREPRESENTABLE');
        if (!Array.isArray(manifest.files) || manifest.files.some(row => !['key.json', 'connections.v1.json', 'connections.v2.json', 'operations.v2.json'].includes(row.name) && !/^[A-Za-z0-9_-]+\.host\.json$/.test(row.name))) throw problem('SSH_VAULT_INVALID', 503);
        for (const row of manifest.files) {
          await secure(path.join(backup, row.name));
          if (createHash('sha256').update(await readFile(path.join(backup, row.name))).digest('hex') !== row.sha256) throw problem('SSH_VAULT_INVALID', 503);
          // A replacement key cannot be justified by a rollback request.
          if (row.name === 'key.json' && createHash('sha256').update(await readFile(path.join(root, row.name))).digest('hex') !== row.sha256) throw problem('SSH_VAULT_INVALID', 503);
        }
        await atomic(path.join(backup, 'rollback-connections.v2.json'), await readFile(filename));
        await atomic(barrier, { version: 2, operationId, revision: saved.revision, digest: null }); await revoke();
        const original = manifest.files.find(row => row.name === 'connections.v1.json');
        if (original) await atomic(oldFile, await readFile(path.join(backup, original.name)));
        else await unlink(oldFile);
        await unlink(filename); await clearBarrier();
        return { rolledBack: true, backupId: operationId, approvalsRevoked: true, disabled: true };
      }
      const old = await legacy(), next = project(old); next.revision++; next.migrationId = operationId; next.updatedAt = new Date().toISOString();
      await mkdir(backup, { recursive: true, mode: 0o700 });
      if (await exists(path.join(backup, 'manifest.json'))) throw problem('SSH_CONNECTION_OPERATION_CONFLICT');
      const files = (await readdir(root)).filter(name => ['key.json', 'connections.v1.json', 'connections.v2.json', 'operations.v2.json'].includes(name) || /^[A-Za-z0-9_-]+\.host\.json$/.test(name));
      const manifest = { version: 2, operationId, direction, revision: next.revision, files: [] };
      for (const name of files) {
        await secure(path.join(root, name)); await atomic(path.join(backup, name), await readFile(path.join(root, name)));
        manifest.files.push({ name, sha256: createHash('sha256').update(await readFile(path.join(backup, name))).digest('hex') });
      }
      await atomic(path.join(backup, 'manifest.json'), manifest);
      if (await active()) throw problem('SSH_CONNECTION_OPERATION_CONFLICT');
      await atomic(barrier, { version: 2, operationId, revision: next.revision, digest: null });
      await revoke(); await write(next); await atomic(oldFile, { version: 2, state: 'migrated', migrationId: operationId }); await clearBarrier();
      return { version: 2, migrated: true, revision: next.revision, backupId: operationId, unresolvedHosts: Object.values(next.pendingLegacyRefs).filter(rows => rows.length).length, approvalsRevoked: true };
    });
  }
  return { active, read, targets, connections, save, migrate, assertReady,
    async connection(hostId, actor) { return resolver.connection(await read(), hostId, actor); },
    async inventory(hostId, category, actor) { const state = await current(); return resolver.inventory(hostId, category, actor, state.document); },
    async capabilities() { await assertReady(); return { version: 1, connectionsVersion: 2, maxTargets: 100, classes: Object.fromEntries(['disk', 'gpu', 'usb', 'pcie'].map(category => [category, { inventory: category === 'disk' && resolver.available, custom: category === 'disk' && resolver.available, operations: category === 'disk' && resolver.available ? ['disk.smart.read'] : [] }])), execution: { manual: resolver.available, scheduled: false, reason: 'SSH_BACKGROUND_INVENTORY_AUTH_UNAVAILABLE' } }; },
  };
}
