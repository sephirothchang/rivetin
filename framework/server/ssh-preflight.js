import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const error = (code, status = 503) => Object.assign(new Error(code), { status });
const actorKey = actor => JSON.stringify({ id: actor.id, source: actor.source });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function admin(actor) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.length || actor.id.length > 128 || !['tower', 'demo', 'cli'].includes(actor.source)) throw error('AUTHENTICATION_REQUIRED', 401);
  if (actor.admin !== true) throw error('ADMIN_REQUIRED', 403);
}
function address(value) {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) throw error('SSH_PREFLIGHT_TARGET_INVALID', 400);
  const normalized = isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
  if (/^(?:0\.|127\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(normalized) || ['::', '::1'].includes(normalized) || /^(?:fe[89ab]|ff|::ffff:)/i.test(normalized)) throw error('SSH_PREFLIGHT_TARGET_INVALID', 400);
  return normalized;
}
const port = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const safeCode = failed => ['SSH_AUTHENTICATION_FAILED', 'SSH_HOST_KEY_MISMATCH', 'SSH_CONNECTION_FAILED', 'SSH_CONNECTION_CLOSED', 'SSH_KEY_UNAVAILABLE', 'SSH_UNAVAILABLE', 'SSH_TIMEOUT', 'SSH_ABORTED'].includes(failed?.message) ? failed.message : 'SSH_PREFLIGHT_FAILED';
const publicCodes = new Set(['AUTHENTICATION_REQUIRED', 'ADMIN_REQUIRED', 'SSH_CHANNEL_DISABLED', 'SSH_PREFLIGHT_TARGET_INVALID', 'SSH_PREFLIGHT_BUSY', 'SSH_PREFLIGHT_TIMEOUT', 'SSH_PREFLIGHT_CANCELLED', 'SSH_PREFLIGHT_STOPPED', 'SSH_PREFLIGHT_AUDIT_FAILED', 'SSH_PREFLIGHT_FORBIDDEN', 'SSH_PREFLIGHT_INVENTORY_FAILED', 'SSH_PREFLIGHT_HOST_UNAVAILABLE', 'SSH_PREFLIGHT_TARGET_CHANGED', 'SSH_PREFLIGHT_REQUEST_INVALID', 'SSH_PREFLIGHT_CHALLENGE_LIMIT', 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED', 'SSH_PREFLIGHT_CONNECTION_UNAVAILABLE', 'SSH_PREFLIGHT_CONNECTION_CHANGED', 'SSH_PREFLIGHT_FAILED']);

export function createSshPreflight({ inventory, vault, transport, audit = async () => {}, now = Date.now, assertActive = async () => {} } = {}) {
  if (typeof inventory !== 'function' || !vault || typeof vault.get !== 'function' || typeof vault.revision !== 'function' || !transport || typeof transport.discover !== 'function' || typeof transport.verify !== 'function' || typeof audit !== 'function' || typeof now !== 'function' || typeof assertActive !== 'function') throw error('SSH_PREFLIGHT_REQUIRED');
  const challenges = new Map(), actors = new Set(), controllers = new Set(), reservations = new Set(); let active = 0, stopped = false;
  const prune = () => { for (const [token, item] of challenges) if (item.expiresAt <= now()) challenges.delete(token); };
  async function emit(actor, action, result, code = null) {
    try { await audit({ actor: { id: actor.id, name: typeof actor.name === 'string' ? actor.name.slice(0, 128) : actor.id, source: actor.source }, action: `ssh.preflight.${action}`, pluginId: null, result, code }); }
    catch { throw error('SSH_PREFLIGHT_AUDIT_FAILED'); }
  }
  async function operation(actor, action, work) {
    admin(actor); const actorId = actorKey(actor);
    if (stopped) throw error('SSH_PREFLIGHT_STOPPED', 503);
    if (active >= 2 || actors.has(actorId)) throw error('SSH_PREFLIGHT_BUSY', 429);
    active++; actors.add(actorId);
    const controller = new AbortController(), deadline = Date.now() + 5000; let timer, timedOut = false, published = false;
    controllers.add(controller);
    const ctx = { signal: controller.signal, remaining() { const remaining = deadline - Date.now(); if (controller.signal.aborted || remaining < 1) throw error('SSH_PREFLIGHT_TIMEOUT', 504); return Math.min(5000, remaining); } };
    try {
      const value = await Promise.race([
        (async () => {
          await assertActive(actor); ctx.remaining();
          await emit(actor, action, 'started'); ctx.remaining();
          try { const result = await work(ctx); ctx.remaining(); await emit(actor, action, 'success'); ctx.remaining(); return result; }
          catch (failed) { if (!controller.signal.aborted) { await emit(actor, action, 'failed', publicCodes.has(failed?.message) ? failed.message : safeCode(failed)); ctx.remaining(); } throw failed; }
        })(),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(error(timedOut ? 'SSH_PREFLIGHT_TIMEOUT' : 'SSH_PREFLIGHT_CANCELLED', timedOut ? 504 : 409)), { once: true });
          timer = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
        }),
      ]);
      published = true; return value;
    } catch (failed) { if (publicCodes.has(failed?.message)) throw error(failed.message, [400, 401, 403, 404, 409, 429, 503, 504].includes(failed.status) ? failed.status : failed.message === 'SSH_CHANNEL_DISABLED' ? 403 : 503); throw error(safeCode(failed), ['SSH_TIMEOUT', 'SSH_ABORTED'].includes(failed.message) ? 504 : 503); }
    finally { if (!published) for (const [token, item] of challenges) if (item.owner === ctx) challenges.delete(token); clearTimeout(timer); controllers.delete(controller); reservations.delete(ctx); controller.abort(); actors.delete(actorId); active--; }
  }
  async function target(hostId, requestedAddress, requestedPort, actor, ctx) {
    if (!identifier(hostId) || !port(requestedPort)) throw error('SSH_PREFLIGHT_TARGET_INVALID', 400);
    const normalized = address(requestedAddress); let result;
    await assertActive(actor); ctx.remaining();
    try { result = await inventory(actor, { signal: ctx.signal }); } catch (failed) { throw error(failed.status === 401 ? 'AUTHENTICATION_REQUIRED' : failed.status === 403 ? 'SSH_PREFLIGHT_FORBIDDEN' : 'SSH_PREFLIGHT_INVENTORY_FAILED', [401, 403].includes(failed.status) ? failed.status : 503); }
    ctx.remaining();
    if (!result || !Array.isArray(result.hosts) || result.hosts.length > 10000) throw error('SSH_PREFLIGHT_INVENTORY_FAILED');
    const matches = result.hosts.filter(item => item?.id === hostId);
    if (matches.length !== 1) throw error('SSH_PREFLIGHT_HOST_UNAVAILABLE', 404);
    let expected; try { expected = address(matches[0].address); } catch { throw error('SSH_PREFLIGHT_INVENTORY_FAILED'); }
    if (expected !== normalized) throw error('SSH_PREFLIGHT_TARGET_CHANGED', 409);
    const digest = createHash('sha256').update(JSON.stringify({ hostId, address: expected, port: requestedPort, clusterId: matches[0].clusterId || null })).digest('hex');
    return { hostId, address: expected, port: requestedPort, digest };
  }
  function endpoint(input, allowed) {
    if (!exact(input, allowed)) throw error('SSH_PREFLIGHT_REQUEST_INVALID', 400);
    if (!identifier(input.hostId) || !port(input.port)) throw error('SSH_PREFLIGHT_TARGET_INVALID', 400);
    address(input.address);
  }
  return {
    async discover(input) {
      endpoint(input, ['hostId', 'address', 'port', 'actor']);
      return operation(input.actor, 'discover', async ctx => {
        prune(); if (challenges.size + reservations.size >= 100) throw error('SSH_PREFLIGHT_CHALLENGE_LIMIT', 429);
        reservations.add(ctx);
        try {
          const before = await target(input.hostId, input.address, input.port, input.actor, ctx);
          const found = await transport.discover({ address: before.address, port: before.port, signal: ctx.signal, timeoutMs: ctx.remaining() }); ctx.remaining();
          if (!found || !hex(found.sha256Hex) || typeof found.algorithm !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,95}$/.test(found.algorithm) || found.fingerprint !== 'SHA256:' + Buffer.from(found.sha256Hex, 'hex').toString('base64').replace(/=+$/, '')) throw error('SSH_KEY_UNAVAILABLE');
          const after = await target(input.hostId, input.address, input.port, input.actor, ctx);
          if (before.digest !== after.digest) throw error('SSH_PREFLIGHT_TARGET_CHANGED', 409);
          const challenge = randomBytes(32).toString('hex'), expiresAt = now() + 120000;
          ctx.remaining(); challenges.set(challenge, { actor: actorKey(input.actor), target: before, sha256Hex: found.sha256Hex, expiresAt, owner: ctx });
          return { hostId: before.hostId, address: before.address, port: before.port, algorithm: found.algorithm, fingerprint: found.fingerprint, sha256Hex: found.sha256Hex, challenge, expiresAt: new Date(expiresAt).toISOString() };
        } finally { reservations.delete(ctx); }
      });
    },
    async confirm(input) {
      endpoint(input, ['hostId', 'address', 'port', 'challenge', 'acknowledged', 'actor']);
      return operation(input.actor, 'confirm', async ctx => {
        const pending = challenges.get(input.challenge); challenges.delete(input.challenge);
        if (input.acknowledged !== true || !pending || pending.expiresAt <= now() || pending.actor !== actorKey(input.actor) || pending.target.hostId !== input.hostId || pending.target.address !== address(input.address) || pending.target.port !== input.port) throw error('SSH_PREFLIGHT_CONFIRMATION_REQUIRED', 409);
        const current = await target(input.hostId, input.address, input.port, input.actor, ctx);
        if (current.digest !== pending.target.digest) throw error('SSH_PREFLIGHT_TARGET_CHANGED', 409);
        return { hostId: current.hostId, address: current.address, port: current.port, sha256Hex: pending.sha256Hex, confirmed: true };
      });
    },
    async verify(input) {
      if (!exact(input, ['hostId', 'actor']) || !identifier(input.hostId)) throw error('SSH_PREFLIGHT_REQUEST_INVALID', 400);
      return operation(input.actor, 'verify', async ctx => {
        const revision = await vault.revision(); ctx.remaining();
        let host; try { host = await vault.get(input.hostId, input.actor, { connectionOnly: true }); } catch { throw error('SSH_PREFLIGHT_CONNECTION_UNAVAILABLE'); } ctx.remaining();
        if (host?.hostId !== input.hostId || !hex(host.hostKeySha256)) throw error('SSH_PREFLIGHT_CONNECTION_UNAVAILABLE');
        const before = await target(input.hostId, host.address, host.port, input.actor, ctx);
        const result = await transport.verify({ host, signal: ctx.signal, timeoutMs: ctx.remaining() }); ctx.remaining();
        if (result?.verified !== true) throw error('SSH_PREFLIGHT_FAILED');
        const after = await target(input.hostId, host.address, host.port, input.actor, ctx), latest = await vault.revision(); ctx.remaining();
        if (revision !== latest || before.digest !== after.digest) throw error('SSH_PREFLIGHT_CONNECTION_CHANGED', 409);
        return { hostId: input.hostId, verified: true, checkedAt: new Date(now()).toISOString() };
      });
    },
    cancel() { challenges.clear(); reservations.clear(); for (const controller of controllers) controller.abort(); return { cancelled: true }; },
    stop() { stopped = true; challenges.clear(); reservations.clear(); for (const controller of controllers) controller.abort(); return { stopped: true }; },
  };
}
