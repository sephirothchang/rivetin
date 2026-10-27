import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { storage, atomic, json, validId, assertId } from './storage.js';
import { SSH_CHANNEL_ID, SSH_OPERATIONS, SSH_REJECTED_EXAMPLES, validateSshRegistration, compileSshCommand, sshRegistrationDigest } from './ssh-policy.js';
import { createSshVault } from './ssh-vault.js';

const fixedError = error => /^(?:SSH_[A-Z_]+|ABORT_ERR)$/.test(error?.message || '') ? error.message : 'SSH_EXECUTION_FAILED';
const systemActor = { id: 'ssh-scheduler', name: 'SSH scheduler', source: 'cli', admin: true };
function ownerKeys(value) {
  if (Object.keys(value).some(id => !validId(id))) throw new Error('SSH_APPROVAL_STORE_INVALID');
  return value;
}
const commandSpec = ({ id, operation, purpose, hostIds, hostScope, intervalSeconds, deviceIds, deviceScope }) => ({ id, operation, purpose, intervalSeconds,
  ...(hostScope ? { hostScope } : { hostIds }), ...(deviceScope ? { deviceScope } : deviceIds ? { deviceIds } : {}) });
function boundedResults(items) {
  const kept = items.slice(0, 30);
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify({ items: kept })) > 4 * 1024 * 1024) kept.pop();
  return { items: kept };
}
export function createSshBroker(directory, { serviceStatus, vault = createSshVault(directory), run: transport, audit = async () => {}, now = Date.now, prepareResultContext, onResult } = {}) {
  if (typeof serviceStatus !== 'function') throw new Error('SSH_STATUS_PROVIDER_REQUIRED');
  if (prepareResultContext !== undefined && typeof prepareResultContext !== 'function' || onResult !== undefined && typeof onResult !== 'function') throw new Error('SSH_RESULT_HOOK_INVALID');
  const root = path.join(path.resolve(directory), 'ssh-channel'), disk = storage(root);
  const stateFile = path.join(root, 'approvals.json'), challenges = new Map(), active = new Map(), invocations = new Set(), pending = new Set();
  let timer, ticking = false, booted = false, stopped = false;
  const admin = actor => { if (!actor?.admin || !['tower', 'cli', 'demo'].includes(actor.source) || typeof actor.id !== 'string' || !actor.id.length || actor.id.length > 128) throw new Error('SSH_ADMIN_REQUIRED'); };
  async function state() {
    const value = await json(stateFile, { version: 1, approvals: {}, schedules: {}, revocations: { global: '', plugins: {} } });
    if (value.version !== 1 || !value.approvals || Array.isArray(value.approvals) || typeof value.approvals !== 'object' || !value.schedules || Array.isArray(value.schedules) || typeof value.schedules !== 'object') throw new Error('SSH_APPROVAL_STORE_INVALID');
    if (value.revocations === undefined) value.revocations = { global: '', plugins: {} };
    const revoked = value.revocations;
    if (!revoked || typeof revoked !== 'object' || Array.isArray(revoked) || Object.keys(revoked).some(key => !['global', 'plugins'].includes(key)) || typeof revoked.global !== 'string' || revoked.global !== '' && !/^[a-f0-9]{32}$/.test(revoked.global) || !revoked.plugins || typeof revoked.plugins !== 'object' || Array.isArray(revoked.plugins) || Object.entries(revoked.plugins).some(([id, nonce]) => !validId(id) || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce))) throw new Error('SSH_APPROVAL_STORE_INVALID');
    value.approvals = ownerKeys(value.approvals); value.schedules = ownerKeys(value.schedules); revoked.plugins = ownerKeys(revoked.plugins);
    return value;
  }
  async function emit(actor, action, pluginId, result = 'success', code = null) {
    await audit({ actor, action: `ssh.${action}`, pluginId, result, code });
  }
  const gate = status => status.enabled === true && status.channelInstalled === true && status.channelEnabled === true;
  function cancelJob(job) { job.revoked = true; job.permissionController.abort(); job.controller.abort(); }
  function abortMatching(pluginId) {
    for (const job of active.values()) if (pluginId === null || job.pluginId === pluginId) cancelJob(job);
    for (const [token, challenge] of challenges) if (pluginId === null || challenge.pluginId === pluginId) challenges.delete(token);
  }
  async function registrations(status) {
    const epoch = await json(path.join(path.resolve(directory), 'framework', 'ssh-revocation.json'), null);
    if (epoch !== null && (typeof epoch !== 'object' || Array.isArray(epoch) || Object.keys(epoch).join() !== 'nonce' || !/^[a-f0-9]{32}$/.test(epoch.nonce || ''))) throw new Error('SSH_REVOCATION_INVALID');
    const hosts = await vault.list(), byId = new Map(hosts.map(host => [host.hostId, host])), revocations = (await state()).revocations;
    const revision = await vault.revision() + ':' + (epoch?.nonce || '') + ':' + revocations.global, items = [];
    const seen = new Set();
    for (const input of status.plugins || []) {
      if (!validId(input.id)) continue;
      const plugin = input;
      if (seen.has(plugin.id)) throw new Error('AMBIGUOUS_SSH_IDENTITY');
      seen.add(plugin.id);
      if (!plugin.installed || !plugin.manifest?.ssh || plugin.id === SSH_CHANNEL_ID) continue;
      let registration;
      try {
        registration = validateSshRegistration(plugin.manifest.ssh);
        if (!/^[a-f0-9]{64}$/.test(plugin.packageId || '')) throw new Error('SSH_REGISTRATION_INVALID');
      } catch {
        items.push({ pluginId: plugin.id, packageId: plugin.packageId, name: plugin.manifest.name, pluginName: plugin.manifest.name, enabled: false, digest: null, commands: [], reason: 'SSH_REGISTRATION_INVALID' });
        continue;
      }
      const commands = [];
      for (const command of registration.commands) {
        const targets = [], missingHosts = [], missingDevices = [];
        const hostIds = command.hostScope === 'configured' ? hosts.map(host => host.hostId) : command.hostIds;
        const selections = [], resolvedDevices = new Set(); let count = 0;
        for (const hostId of hostIds) {
          const host = byId.get(hostId);
          if (!host || host.credentialConfigured === false) { missingHosts.push(hostId); continue; }
          const deviceIds = command.operation !== 'disk.smart.read' ? [undefined] : command.deviceScope === 'configured' ? host.devices.map(device => device.deviceId).sort() : command.deviceIds;
          if (!deviceIds.length) missingDevices.push({ hostId, reason: 'SSH_DEVICES_NOT_CONFIGURED' });
          count += deviceIds.length;
          selections.push({ host, deviceIds });
        }
        const targetLimitExceeded = count > 100;
        if (!targetLimitExceeded) {
          for (const { host, deviceIds } of selections) for (const deviceId of deviceIds) {
            if (deviceId !== undefined) resolvedDevices.add(deviceId);
            try { targets.push({ hostId: host.hostId, ...(deviceId ? { deviceId } : {}), command: compileSshCommand(command, host, deviceId) }); }
            catch { missingDevices.push({ hostId: host.hostId, deviceId }); }
          }
        }
        commands.push({ ...command, hostIds, ...(command.operation === 'disk.smart.read' ? { deviceIds: command.deviceScope === 'configured' ? [...resolvedDevices].sort() : command.deviceIds } : {}),
          risk: 'read-only', preview: targets.map(target => `${target.hostId}${target.deviceId ? '/' + target.deviceId : ''}: ${target.command}`), targets, missingHosts, missingDevices, targetLimitExceeded });
      }
      const resolvedCommands = commands.map(({ id, hostIds, deviceIds, preview, targets }) => ({ id, hostIds, ...(deviceIds ? { deviceIds } : {}), preview, targets }));
      items.push({ pluginId: plugin.id, packageId: plugin.packageId, name: plugin.manifest.name, pluginName: plugin.manifest.name, enabled: plugin.enabled === true, digest: sshRegistrationDigest(plugin, registration, revision + ':' + (revocations.plugins[plugin.id] || ''), resolvedCommands), commands,
        reason: commands.some(command => command.targetLimitExceeded) ? 'SSH_TARGET_LIMIT' : commands.some(command => !command.targets.length || command.missingHosts.length || command.missingDevices.length) ? 'SSH_TARGET_UNAVAILABLE' : !plugin.enabled ? 'SSH_PLUGIN_DISABLED' : null });
    }
    return { hosts, items };
  }
  async function current(pluginId, { enabled = true } = {}) {
    assertId(pluginId);
    const status = await serviceStatus(), { items } = await registrations(status);
    const registration = items.find(item => item.pluginId === pluginId);
    if (!registration) throw new Error('SSH_REGISTRATION_UNAVAILABLE');
    if (registration.reason === 'SSH_REGISTRATION_INVALID') throw new Error('SSH_REGISTRATION_INVALID');
    if (registration.reason === 'SSH_TARGET_LIMIT') throw new Error('SSH_TARGET_LIMIT');
    if (enabled && (!gate(status) || !registration.enabled || stopped)) throw new Error('SSH_CHANNEL_DISABLED');
    if (registration.reason === 'SSH_TARGET_UNAVAILABLE') throw new Error('SSH_TARGET_UNAVAILABLE');
    if (enabled && typeof transport !== 'function') throw new Error('SSH_TRANSPORT_UNAVAILABLE');
    return registration;
  }
  async function sync() {
    return disk.locked(async () => {
      const status = await serviceStatus(), { items } = await registrations(status), value = await state();
      let changed = false;
      for (const [pluginId, approval] of Object.entries(value.approvals)) {
        const registration = items.find(item => item.pluginId === pluginId);
        if (!gate(status) || !registration?.enabled || registration.digest !== approval.digest || typeof approval.id !== 'string' || registration.reason) {
          abortMatching(pluginId); delete value.approvals[pluginId]; delete value.schedules[pluginId]; changed = true;
        }
      }
      for (const job of active.values()) {
        const registration = items.find(item => item.pluginId === job.pluginId), approval = value.approvals[job.pluginId];
        if (!gate(status) || !registration?.enabled || registration.reason || registration.digest !== job.digest || approval?.digest !== job.digest || approval?.id !== job.approvalId) cancelJob(job);
      }
      if (changed) await atomic(stateFile, value);
      return { status, registrations: items, hosts: (await vault.list()), state: value };
    });
  }
  async function invalidate(pluginId = null, reason = 'SSH_APPROVAL_REVOKED') {
    if (pluginId !== null && !validId(pluginId)) throw new Error('SSH_REGISTRATION_INVALID');
    if (pluginId !== null) assertId(pluginId);
    abortMatching(pluginId);
    return disk.locked(async () => {
      abortMatching(pluginId);
      const value = await state();
      if (pluginId === null) value.revocations.global = randomBytes(16).toString('hex');
      else value.revocations.plugins[pluginId] = randomBytes(16).toString('hex');
      for (const id of Object.keys(value.approvals)) if (pluginId === null || id === pluginId) { delete value.approvals[id]; delete value.schedules[id]; }
      await atomic(stateFile, value);
      return { revoked: true, reason: /^[A-Z_]{1,100}$/.test(reason) ? reason : 'SSH_APPROVAL_REVOKED' };
    });
  }
  async function recent(pluginId) {
    if (!validId(pluginId)) throw new Error('SSH_REGISTRATION_INVALID');
    assertId(pluginId);
    const value = await json(path.join(root, 'results', `${pluginId}.json`), { items: [] });
    return { items: value.items.slice(0, 30) };
  }
  async function assertActive(job, allowTimeoutFailure = false) {
    const latest = await current(job.pluginId), approval = (await state()).approvals[job.pluginId];
    if (job.revoked || job.controller.signal.aborted && !(allowTimeoutFailure && job.timedOut) || latest.digest !== job.digest || approval?.id !== job.approvalId || approval?.digest !== job.digest) throw new Error('SSH_APPROVAL_REVOKED');
  }
  async function persistResult(item, context, job) {
    // A timeout cancels transport, while authorization can still permit a metric-free failure record.
    const timeoutFailure = item.result === 'failed' && item.code === 'SSH_EXECUTION_TIMEOUT' && job.timedOut && !Object.hasOwn(item, 'stdout');
    try { await onResult(structuredClone(item), context, { signal: timeoutFailure ? job.permissionController.signal : job.controller.signal, assertActive: () => assertActive(job, timeoutFailure) }); }
    catch { throw new Error('SSH_RESULT_PERSIST_FAILED'); }
  }
  async function record(pluginId, item, job, context, notify) {
    await disk.locked(async () => {
      if (notify) {
        try { await persistResult(item, context, job); }
        catch { item.code = 'SSH_RESULT_PERSIST_FAILED'; }
      }
      const value = await recent(pluginId);
      await atomic(path.join(root, 'results', `${pluginId}.json`), boundedResults([item, ...value.items]));
    });
  }
  async function execute(pluginId, commandId, actor, scheduled = false) {
    admin(actor);
    if (!validId(pluginId) || typeof commandId !== 'string') throw new Error('SSH_REGISTRATION_INVALID');
    assertId(pluginId);
    await sync();
    const invocation = randomUUID();
    const batch = await disk.locked(async () => {
      const registration = await current(pluginId), value = await state(), approval = value.approvals[pluginId];
      if (approval?.digest !== registration.digest) throw new Error('SSH_APPROVAL_REQUIRED');
      const command = registration.commands.find(item => item.id === commandId);
      if (!command) throw new Error('SSH_COMMAND_UNAVAILABLE');
      if (typeof approval.id !== 'string') throw new Error('SSH_APPROVAL_REQUIRED');
      if (!command.targets.length || invocations.size >= 2) throw new Error('SSH_CONCURRENCY_LIMIT');
      await emit(actor, 'run.started', pluginId, 'started');
      invocations.add(invocation);
      return { targets: command.targets, operation: command.operation, digest: approval.digest, approvalId: approval.id, deadline: now() + 300000 };
    });
    const results = [];
    try { for (const target of batch.targets) {
      const job = { id: randomUUID(), pluginId, commandId, hostId: target.hostId, target, controller: new AbortController(), permissionController: new AbortController(), timedOut: false, revoked: false, digest: batch.digest, approvalId: batch.approvalId };
      const startedAt = now();
      let context, sinkAttempted = false;
      try {
        if (now() >= batch.deadline) throw new Error('SSH_BATCH_TIMEOUT');
        const registration = await disk.locked(async () => {
          const candidate = await current(pluginId), approval = (await state()).approvals[pluginId];
          if (candidate.digest !== job.digest || approval?.digest !== job.digest || approval.id !== batch.approvalId) throw new Error('SSH_APPROVAL_REVOKED');
          if (active.size >= 2 || [...active.values()].some(item => item.hostId === job.hostId)) throw new Error('SSH_CONCURRENCY_LIMIT');
          active.set(job.id, job); return candidate;
        });
        const host = await vault.get(job.hostId);
        if (compileSshCommand(commandSpec(registration.commands.find(item => item.id === commandId)), host, job.target.deviceId) !== job.target.command) throw new Error('SSH_APPROVAL_REVOKED');
        await assertActive(job);
        if (prepareResultContext) {
          try { context = await prepareResultContext({ pluginId, commandId, operation: batch.operation, hostId: job.hostId, ...(job.target.deviceId ? { deviceId: job.target.deviceId } : {}), host: structuredClone(host) }); }
          catch { throw new Error('SSH_RESULT_CONTEXT_FAILED'); }
          await assertActive(job);
        }
        const timeoutMs = Math.max(1, Math.min(30000, batch.deadline - now())), maxBytes = 1024 * 1024;
        let timeout;
        const result = await Promise.race([
          transport({ host, command: job.target.command, signal: job.controller.signal, timeoutMs, maxBytes }),
          new Promise((_, reject) => { timeout = setTimeout(() => { job.timedOut = true; job.controller.abort(); reject(new Error('SSH_EXECUTION_TIMEOUT')); }, timeoutMs); timeout.unref?.(); }),
          new Promise((_, reject) => { const abort = () => reject(new Error(job.timedOut ? 'SSH_EXECUTION_TIMEOUT' : 'SSH_EXECUTION_CANCELLED')); if (job.controller.signal.aborted) abort(); else job.controller.signal.addEventListener('abort', abort, { once: true }); }),
        ]).finally(() => clearTimeout(timeout));
        if (job.controller.signal.aborted) throw new Error('SSH_EXECUTION_CANCELLED');
        const output = result?.stdout;
        if (typeof output !== 'string' || Buffer.byteLength(output) > maxBytes || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) throw new Error('SSH_RESULT_INVALID');
        if (result.exitCode !== 0 && !(job.target.deviceId && result.exitCode < 256 && (result.exitCode & 7) === 0)) throw new Error('SSH_REMOTE_COMMAND_FAILED');
        // Device replacement is not a successful sample for the old device identity.
        if (job.target.deviceId) {
          let smart; try { smart = JSON.parse(output); } catch { throw new Error('SSH_RESULT_INVALID'); }
          const device = host.devices.find(item => item.deviceId === job.target.deviceId);
          if (device.serial && smart.serial_number !== device.serial) throw new Error('SSH_DEVICE_IDENTITY_MISMATCH');
        }
        const item = { id: job.id, pluginId, commandId, operation: batch.operation, hostId: job.hostId, ...(job.target.deviceId ? { deviceId: job.target.deviceId } : {}), startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now()).toISOString(), scheduled, result: 'success', exitCode: result.exitCode, stdout: output };
        await disk.locked(async () => {
          await assertActive(job);
          if (onResult) {
            sinkAttempted = true;
            await persistResult(item, context, job);
            await assertActive(job);
          }
          const previous = await recent(pluginId);
          await atomic(path.join(root, 'results', `${pluginId}.json`), boundedResults([item, ...previous.items]));
        });
        await emit(actor, 'run', pluginId);
        results.push({ id: job.id, result: 'success' });
      } catch (error) {
        const item = { id: job.id, pluginId, commandId, operation: batch.operation, hostId: job.hostId, ...(job.target.deviceId ? { deviceId: job.target.deviceId } : {}), startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now()).toISOString(), scheduled, result: 'failed', code: fixedError(error) };
        await record(pluginId, item, job, context, Boolean(onResult && !sinkAttempted));
        await emit(actor, 'run', pluginId, 'failed', item.code);
        results.push({ id: job.id, result: 'failed', code: item.code });
      } finally { active.delete(job.id); }
    } } finally { invocations.delete(invocation); }
    return { items: results };
  }
  function trackedExecute(...args) {
    const task = execute(...args); pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  return {
    root, vault, sync, invalidate,
    async status(actor) {
      admin(actor);
      const snapshot = await sync(), recentRuns = [];
      for (const item of snapshot.registrations) recentRuns.push(...(await recent(item.pluginId)).items.map(({ stdout, ...metadata }) => metadata));
      return { enabled: gate(snapshot.status), transportReady: typeof transport === 'function', hosts: snapshot.hosts,
        operations: SSH_OPERATIONS, rejectedExamples: SSH_REJECTED_EXAMPLES.map(item => ({ ...item, command: item.example, impact: item.risk })),
        registrations: snapshot.registrations.map(item => ({ ...item, approved: snapshot.state.approvals[item.pluginId]?.digest === item.digest, approvedAt: snapshot.state.approvals[item.pluginId]?.approvedAt || null })),
        recentRuns: recentRuns.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 50), running: active.size };
    },
    async review(pluginId, actor) {
      admin(actor); assertId(pluginId); await sync(); const registration = await current(pluginId);
      for (const [token, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(token);
      if (challenges.size >= 100) throw new Error('SSH_REVIEW_LIMIT');
      const token = randomBytes(32).toString('hex'), expiresAt = now() + 120000;
      challenges.set(token, { actorId: actor.id, actorSource: actor.source, pluginId, digest: registration.digest, expiresAt });
      return { ...registration, registration: registration, challenge: token, expiresAt: new Date(expiresAt).toISOString() };
    },
    async approve({ pluginId, challenge, digest, acknowledged }, actor) {
      admin(actor);
      assertId(pluginId);
      return disk.locked(async () => {
        const review = challenges.get(challenge); challenges.delete(challenge);
        if (acknowledged !== true || !review || review.actorId !== actor.id || review.actorSource !== actor.source || review.pluginId !== pluginId || review.digest !== digest || review.expiresAt <= now()) throw new Error('SSH_REVIEW_CONFIRMATION_REQUIRED');
        const registration = await current(pluginId);
        if (registration.digest !== digest) throw new Error('SSH_REGISTRATION_CHANGED');
        const value = await state(), approvedAt = new Date(now()).toISOString();
        await emit(actor, 'approve', pluginId);
        value.approvals[pluginId] = { id: randomUUID(), digest, approvedAt, actorId: actor.id };
        value.schedules[pluginId] = Object.fromEntries(registration.commands.filter(command => command.intervalSeconds).map(command => [command.id, now() + command.intervalSeconds * 1000]));
        await atomic(stateFile, value); return { pluginId, approved: true, digest, approvedAt };
      });
    },
    async revoke(pluginId, actor) { admin(actor); const result = await invalidate(pluginId); await emit(actor, 'revoke', pluginId); return result; },
    run: (pluginId, commandId, actor) => trackedExecute(pluginId, commandId, actor),
    drain: async () => { await Promise.allSettled([...pending]); },
    async results(pluginId, actor) { admin(actor); await current(pluginId, { enabled: false }); const value = await recent(pluginId); return { items: value.items }; },
    async tick() {
      if (ticking || stopped) return;
      ticking = true;
      try {
        const snapshot = await sync(), due = [];
        if (!gate(snapshot.status) || typeof transport !== 'function') return;
        await disk.locked(async () => {
          const value = await state(); let changed = false;
          for (const registration of snapshot.registrations) {
            if (!registration.enabled || value.approvals[registration.pluginId]?.digest !== registration.digest) continue;
            const schedules = value.schedules[registration.pluginId] ||= {};
            for (const command of registration.commands.filter(item => item.intervalSeconds)) {
              const next = schedules[command.id], interval = command.intervalSeconds * 1000;
              if (!Number.isFinite(next) || !booted && next <= now()) { schedules[command.id] = now() + interval; changed = true; continue; }
              if (next <= now()) { schedules[command.id] = now() + interval; changed = true; if (due.length < 2 && pending.size + due.length < 2) due.push([registration.pluginId, command.id]); }
            }
          }
          if (changed) await atomic(stateFile, value); booted = true;
        });
        for (const [pluginId, commandId] of due) {
          trackedExecute(pluginId, commandId, systemActor, true).catch(async error => {
            try { await emit(systemActor, 'schedule', pluginId, 'failed', fixedError(error)); } catch { abortMatching(null); }
          });
        }
      } catch { abortMatching(null); }
      finally { ticking = false; }
    },
    start() { stopped = false; if (!timer) { timer = setInterval(() => { this.tick(); }, 1000); timer.unref?.(); } },
    async stop() { stopped = true; clearInterval(timer); timer = undefined; abortMatching(null); await Promise.allSettled([...pending]); },
  };
}
