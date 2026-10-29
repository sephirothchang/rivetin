import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { atomic, json } from './storage.js';
import { SSH_CHANNEL_ID, sshIdentifier } from './ssh-policy.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';

const command = '/usr/bin/uname -srm', ttl = 120000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const fail = code => { throw Object.assign(new Error(code), { status: 409 }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const owner = actor => {
  if (actor?.admin !== true || !['tower', 'cli', 'demo'].includes(actor.source) || typeof actor.id !== 'string' || !actor.id || actor.id.length > 128) fail('SSH_ADMIN_REQUIRED');
  if (actor.source === 'tower' && actor.role !== 'ROOT') fail('SSH_ROOT_REQUIRED');
  return digest([actor.source, actor.id]);
};
const safeCode = error => ['SSH_APPROVAL_REVOKED', 'SSH_HOST_KEY_MISMATCH', 'SSH_AUTHENTICATION_FAILED', 'SSH_REMOTE_COMMAND_FAILED', 'SSH_EXECUTION_TIMEOUT', 'SSH_EXECUTION_CANCELLED', 'SSH_IDENTITY_OUTPUT_INVALID', 'SSH_IDENTITY_TARGET_CHANGED', 'SSH_CHANNEL_DISABLED'].includes(error?.message) ? error.message : 'SSH_IDENTITY_EXECUTION_FAILED';
function validResult(value) {
  const fields = ['requestId', 'hostId', 'status', 'startedAt'];
  if (value?.status !== 'running') fields.push('finishedAt', 'outcomeUnknown', ...(value?.status === 'success' ? ['exitCode', 'identity'] : ['code']));
  if (!exact(value, fields) || !uuid(value.requestId) || !sshIdentifier(value.hostId) || !Number.isFinite(Date.parse(value.startedAt))) return false;
  if (value.status === 'running') return true;
  if (!Number.isFinite(Date.parse(value.finishedAt)) || typeof value.outcomeUnknown !== 'boolean') return false;
  if (value.status === 'failed') return typeof value.code === 'string' && safeCode(new Error(value.code)) === value.code;
  return value.status === 'success' && value.exitCode === 0 && value.outcomeUnknown === false && exact(value.identity, ['system', 'release', 'architecture']) && Object.values(value.identity).every(token => typeof token === 'string' && /^[A-Za-z0-9._+-]{1,160}$/.test(token));
}

// A framework-owned diagnostic, separate from manifest consumer registrations.
export function createSshIdentity({ root, disk, vault, serviceStatus, inventory, transport, audit, active, invocations, now = Date.now }) {
  const file = path.join(root, 'identity.v1.json'), challenges = new Map(), pending = new Map();
  let stopped = false;
  async function state() {
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) fail('SSH_IDENTITY_STORE_INVALID'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = await json(file, { version: 1, grants: {}, requests: {} });
    if (!exact(value, ['version', 'grants', 'requests']) || value.version !== 1 || !value.grants || !value.requests || Array.isArray(value.grants) || Array.isArray(value.requests) || typeof value.grants !== 'object' || typeof value.requests !== 'object' || Object.keys(value.grants).length > 100 || Object.keys(value.requests).length > 5000) fail('SSH_IDENTITY_STORE_INVALID');
    for (const [id, grant] of Object.entries(value.grants)) if (!uuid(id) || !exact(grant, ['owner', 'hostId', 'digest', 'expiresAt']) || !hex(grant.owner) || !hex(grant.digest) || !sshIdentifier(grant.hostId) || !Number.isSafeInteger(grant.expiresAt)) fail('SSH_IDENTITY_STORE_INVALID');
    for (const [id, request] of Object.entries(value.requests)) if (!uuid(id) || !exact(request, ['owner', 'binding', 'result']) || !hex(request.owner) || !hex(request.binding) || !validResult(request.result) || request.result.requestId !== id) fail('SSH_IDENTITY_STORE_INVALID');
    return value;
  }
  async function save(value) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if (bytes.length > 2 * 1024 * 1024) fail('SSH_IDENTITY_STORE_LIMIT');
    await atomic(file, bytes);
  }
  async function emit(actor, action, result = 'success', code = null) {
    try { await audit({ actor, action: `ssh.identity.${action}`, pluginId: SSH_CHANNEL_ID, result, code }); }
    catch { fail('SSH_IDENTITY_AUDIT_FAILED'); }
  }
  async function plan(hostId, actor) {
    owner(actor);
    if (!sshIdentifier(hostId)) fail('SSH_IDENTITY_TARGET_INVALID');
    if (stopped || typeof transport !== 'function' || typeof inventory !== 'function') fail('SSH_IDENTITY_UNAVAILABLE');
    const status = await serviceStatus(), channel = status.plugins?.find(item => item.id === SSH_CHANNEL_ID);
    if (!status.enabled || !status.channelInstalled || !status.channelEnabled || !channel?.enabled || !hex(channel.packageId)) fail('SSH_CHANNEL_DISABLED');
    const revision = await vault.revision(), host = await vault.get(hostId, actor, { connectionOnly: true });
    const snapshot = await inventory(actor), rows = snapshot?.hosts?.filter(row => row.id === hostId);
    if (!Array.isArray(snapshot?.hosts) || snapshot.hosts.length > 10000 || rows?.length !== 1 || rows[0].clusterId !== host.clusterId || rows[0].address !== host.address || revision !== await vault.revision()) fail('SSH_IDENTITY_TARGET_CHANGED');
    const grants = await json(path.join(root, 'approvals.json'), { revocations: {} }), epoch = await json(path.join(root, '..', 'framework', 'ssh-revocation.json'), null);
    const declaration = { kind: 'builtin-host-identity', operation: 'host.identity', command, intervalSeconds: 0, privilege: 'user' };
    const target = { hostId, clusterId: host.clusterId, address: host.address, port: host.port, hostKeySha256: host.hostKeySha256 };
    return { ...declaration, hostId, frameworkVersion: FRAMEWORK_VERSION, channelVersion: channel.version, packageId: channel.packageId,
      digest: digest({ declaration, frameworkVersion: FRAMEWORK_VERSION, packageId: channel.packageId, target, vaultRevision: revision, revocations: grants.revocations, epoch }), target };
  }
  async function check(job) {
    if (job.revoked || job.controller.signal.aborted || stopped) fail('SSH_APPROVAL_REVOKED');
    if (now() >= job.expiresAt) fail('SSH_APPROVAL_REVOKED');
    const current = await plan(job.hostId, job.actor);
    if (job.revoked || job.controller.signal.aborted || stopped || now() >= job.expiresAt || current.digest !== job.digest) fail('SSH_APPROVAL_REVOKED');
  }
  async function inspectResult(requestId, actor) {
    const key = owner(actor); if (!uuid(requestId)) fail('SSH_IDENTITY_REQUEST_INVALID');
    return disk.locked(async () => {
      const row = (await state()).requests[requestId];
      if (!row || row.owner !== key) fail('SSH_IDENTITY_REQUEST_UNAVAILABLE');
      return { ...row.result, outcomeUnknown: row.result.status === 'running' ? !pending.has(requestId) : row.result.outcomeUnknown };
    });
  }
  async function execute(input, actor) {
    const key = owner(actor);
    if (!exact(input, ['hostId', 'digest', 'approvalId', 'requestId']) || !sshIdentifier(input.hostId) || !hex(input.digest) || !uuid(input.approvalId) || !uuid(input.requestId)) fail('SSH_IDENTITY_REQUEST_INVALID');
    const binding = digest(input), id = input.requestId;
    const reserved = await disk.locked(async () => {
      const value = await state(), previous = value.requests[id];
      if (previous) {
        if (previous.owner !== key || previous.binding !== binding) fail('SSH_IDENTITY_REQUEST_CONFLICT');
        return { replay: { ...previous.result, outcomeUnknown: previous.result.status === 'running' ? !pending.has(id) : previous.result.outcomeUnknown } };
      }
      if (Object.keys(value.requests).length >= 5000) fail('SSH_IDENTITY_STORE_LIMIT');
      const grant = value.grants[input.approvalId];
      if (!grant || grant.owner !== key || grant.hostId !== input.hostId || grant.digest !== input.digest || grant.expiresAt <= now()) fail('SSH_APPROVAL_REQUIRED');
      if ((await plan(input.hostId, actor)).digest !== input.digest) fail('SSH_APPROVAL_REVOKED');
      if (invocations.size >= 2 || active.size >= 2 || [...active.values()].some(job => job.hostId === input.hostId)) fail('SSH_CONCURRENCY_LIMIT');
      const job = { id, actor, builtinIdentity: true, pluginId: SSH_CHANNEL_ID, hostId: input.hostId, digest: input.digest, expiresAt: grant.expiresAt, controller: new AbortController(), permissionController: new AbortController(), revoked: false };
      value.requests[id] = { owner: key, binding, result: { requestId: id, hostId: input.hostId, status: 'running', startedAt: new Date(now()).toISOString() } };
      delete value.grants[input.approvalId];
      await emit(actor, 'execute', 'started'); await save(value);
      invocations.add(id); active.set(id, job); return { job, initial: value.requests[id].result };
    });
    if (reserved.replay) return reserved.replay;
    const { job, initial } = reserved;
    const work = (async () => {
      let timer, polling = false, dispatched = false, result;
      const poll = setInterval(async () => { if (polling) return; polling = true; try { await check(job); } catch { job.revoked = true; job.controller.abort(); } finally { polling = false; } }, 1000); poll.unref?.();
      try {
        await check(job); const host = await vault.get(job.hostId, actor, { connectionOnly: true }); await check(job);
        dispatched = true;
        const output = await Promise.race([
          transport({ host, command, signal: job.controller.signal, timeoutMs: 5000, maxBytes: 1024 }),
          new Promise((_, reject) => { timer = setTimeout(() => { job.controller.abort(); reject(new Error('SSH_EXECUTION_TIMEOUT')); }, 5000); }),
          new Promise((_, reject) => { const abort = () => reject(new Error('SSH_EXECUTION_CANCELLED')); if (job.controller.signal.aborted) abort(); else job.controller.signal.addEventListener('abort', abort, { once: true }); }),
        ]);
        if (output?.exitCode !== 0) fail('SSH_REMOTE_COMMAND_FAILED');
        if (typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > 1024) fail('SSH_IDENTITY_OUTPUT_INVALID');
        const match = /^([A-Za-z0-9._+-]{1,64}) ([A-Za-z0-9._+-]{1,160}) ([A-Za-z0-9._+-]{1,64})\r?\n?$/.exec(output.stdout);
        if (!match) fail('SSH_IDENTITY_OUTPUT_INVALID');
        await check(job);
        result = { ...initial, status: 'success', finishedAt: new Date(now()).toISOString(), exitCode: 0, identity: { system: match[1], release: match[2], architecture: match[3] }, outcomeUnknown: false };
      } catch (error) { result = { ...initial, status: 'failed', finishedAt: new Date(now()).toISOString(), code: safeCode(error), outcomeUnknown: dispatched }; }
      finally { clearTimeout(timer); clearInterval(poll); }
      try {
        await disk.locked(async () => {
          if (result.status === 'success') { try { await check(job); } catch { result = { ...initial, status: 'failed', finishedAt: new Date(now()).toISOString(), code: 'SSH_APPROVAL_REVOKED', outcomeUnknown: true }; } }
          const value = await state();
          await emit(actor, 'execute', result.status, result.code || null);
          if (result.status === 'success') {
            try { await check(job); }
            catch {
              result = { ...initial, status: 'failed', finishedAt: new Date(now()).toISOString(), code: 'SSH_APPROVAL_REVOKED', outcomeUnknown: true };
              await emit(actor, 'execute', 'failed', result.code);
            }
          }
          value.requests[id].result = result; await save(value);
        });
        return result;
      } finally { active.delete(id); invocations.delete(id); }
    })();
    pending.set(id, work);
    try { return await work; } finally { pending.delete(id); }
  }
  return {
    async review(hostId, actor) {
      const key = owner(actor), selected = await plan(hostId, actor);
      for (const [token, row] of challenges) if (row.expiresAt <= now()) challenges.delete(token);
      if (challenges.size >= 100) fail('SSH_REVIEW_LIMIT');
      const challenge = randomBytes(32).toString('hex'), expiresAt = now() + ttl;
      challenges.set(challenge, { owner: key, hostId, digest: selected.digest, expiresAt });
      return { ...selected, challenge, expiresAt: new Date(expiresAt).toISOString() };
    },
    async approve(input, actor) {
      const key = owner(actor);
      if (!exact(input, ['challenge', 'digest', 'acknowledged']) || !hex(input.challenge) || !hex(input.digest) || input.acknowledged !== true) fail('SSH_REVIEW_CONFIRMATION_REQUIRED');
      const selected = challenges.get(input.challenge); challenges.delete(input.challenge);
      if (!selected || selected.owner !== key || selected.digest !== input.digest || selected.expiresAt <= now()) fail('SSH_REVIEW_CONFIRMATION_REQUIRED');
      return disk.locked(async () => {
        if ((await plan(selected.hostId, actor)).digest !== input.digest) fail('SSH_REGISTRATION_CHANGED');
        const value = await state(); for (const [id, row] of Object.entries(value.grants)) if (row.expiresAt <= now()) delete value.grants[id];
        if (Object.keys(value.grants).length >= 100) fail('SSH_REVIEW_LIMIT');
        const approvalId = randomUUID(), expiresAt = now() + ttl;
        value.grants[approvalId] = { owner: key, hostId: selected.hostId, digest: selected.digest, expiresAt };
        await emit(actor, 'approve'); await save(value);
        return { approvalId, hostId: selected.hostId, digest: selected.digest, expiresAt: new Date(expiresAt).toISOString() };
      });
    },
    execute, result: inspectResult, check,
    async recent(actor) {
      const key = owner(actor);
      return disk.locked(async () => ({ items: Object.values((await state()).requests).filter(row => row.owner === key).map(row => ({ ...row.result, outcomeUnknown: row.result.status === 'running' ? !pending.has(row.result.requestId) : row.result.outcomeUnknown })).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30) }));
    },
    cancel() { challenges.clear(); for (const job of active.values()) if (job.builtinIdentity) { job.revoked = true; job.controller.abort(); } },
    async stop() { stopped = true; this.cancel(); await Promise.allSettled([...pending.values()]); },
    start() { stopped = false; },
  };
}
