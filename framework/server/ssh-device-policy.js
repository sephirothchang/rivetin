import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { validateSshTarget, resolveConnection } from './ssh-connection-settings.js';
import { sshIdentifier, validSshDevicePath } from './ssh-policy.js';

export const classes = ['disk', 'gpu', 'usb', 'pcie'];
export const problem = (code, status = 409) => Object.assign(new Error(code), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
export const sign = (key, domain, value) => createHmac('sha256', key).update(domain + '\0' + canonical(value)).digest('hex');
export function devicePolicy(value) {
  if (!exact(value, ['version', 'classes']) || value.version !== 1 || !exact(value.classes, classes)) throw problem('SSH_CONNECTION_SETTINGS_INVALID', 400);
  for (const category of classes) {
    const row = value.classes[category];
    if (!exact(row, ['mode', 'ids']) || !['all', 'custom'].includes(row.mode) || !Array.isArray(row.ids) || row.ids.length > 1000 || row.ids.some(id => !sshIdentifier(id)) || new Set(row.ids).size !== row.ids.length || row.mode === 'all' && row.ids.length) throw problem('SSH_CONNECTION_SETTINGS_INVALID', 400);
    row.ids.sort();
    if (category !== 'disk' && row.mode === 'custom' && row.ids.length) throw problem('SSH_DEVICE_CLASS_UNSUPPORTED');
  }
  return value;
}
export const emptyPolicy = () => ({ version: 1, classes: Object.fromEntries(classes.map(category => [category, { mode: 'all', ids: [] }])) });
export function hostTarget(row) {
  const { devicePolicy: policy, connection, ...target } = row;
  validateSshTarget({ ...target, devices: [] }); devicePolicy(policy);
}

// No credential or actor is retained. Every call reads an exact host and its
// entire bounded disk set under the currently supplied Tower identity.
export function createDeviceResolver({ request, key, now = Date.now } = {}) {
  const epoch = randomBytes(32).toString('hex'); let inflight = 0;
  const available = typeof request === 'function';
  function authenticated(actor) {
    if (!actor?.admin || actor.source !== 'tower' || actor.role !== 'ROOT' || !text(actor.id, 128) || !['Authorization', 'Cookie'].some(name => text(actor.auth?.[name], 16384))) throw problem('SSH_BACKGROUND_INVENTORY_AUTH_UNAVAILABLE', 503);
  }
  async function fresh(hostId, actor, hostOnly = false) {
    authenticated(actor);
    if (!available) throw problem('SSH_DEVICE_INVENTORY_UNAVAILABLE', 503);
    if (!sshIdentifier(hostId)) throw problem('SSH_HOST_INVALID', 400);
    if (inflight >= 2) throw problem('SSH_DEVICE_INVENTORY_LIMIT', 429);
    inflight++; let timer;
    const operation = (async () => {
        const hosts = await request('/v2/api/get-hosts', { where: { id: hostId }, first: 2 }, actor);
        if (!Array.isArray(hosts) || Object.hasOwn(hosts, 'errors') || hosts.length !== 1 || hosts[0]?.id !== hostId || !sshIdentifier(hosts[0].cluster?.id) || !text(hosts[0].management_ip, 128)) throw problem('SSH_DEVICE_IDENTITY_UNVERIFIED');
        if (hostOnly) return { host: hosts[0], disks: [] };
        const rows = await request('/v2/api/get-disks', { where: { host: { id: hostId } }, first: 1001 }, actor);
        if (!Array.isArray(rows) || Object.hasOwn(rows, 'errors')) throw problem('SSH_DEVICE_INVENTORY_UNAVAILABLE', 503);
        if (rows.length > 1000) throw problem('SSH_DEVICE_INVENTORY_LIMIT');
        const ids = new Set(), paths = new Set(), serials = new Set();
        for (const row of rows) {
          if (!sshIdentifier(row?.id) || row.host?.id !== hostId || ids.has(row.id) || !text(row.model, 512)) throw problem('SSH_DEVICE_IDENTITY_UNVERIFIED');
          ids.add(row.id);
          row.selectable = text(row.serial, 256) && validSshDevicePath(row.path);
          if (row.selectable) {
            if (paths.has(row.path) || serials.has(row.serial)) throw problem('SSH_DEVICE_IDENTITY_UNVERIFIED');
            paths.add(row.path); serials.add(row.serial);
          }
        }
        return { host: hosts[0], disks: rows.sort((a, b) => a.id.localeCompare(b.id)) };
      })();
    operation.then(() => inflight--, () => inflight--);
    try {
      return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(problem('SSH_DEVICE_INVENTORY_TIMEOUT', 504)), 5000); })]);
    } catch (error) {
      if (error.status === 401) throw problem('AUTHENTICATION_REQUIRED', 401);
      if (error.status === 403) throw problem('SSH_DEVICE_INVENTORY_UNAVAILABLE', 403);
      throw /^SSH_|^AUTHENTICATION_REQUIRED$/.test(error.message) ? error : problem('SSH_DEVICE_INVENTORY_UNAVAILABLE', 503);
    } finally { clearTimeout(timer); }
  }
  const endpoint = row => row && [row.hostId, row.clusterId, row.address, row.port, row.hostKeySha256];
  const identity = (secret, host, disk) => sign(secret, 'selection-identity-v2', [endpoint(host), disk.id, disk.host.id, disk.serial, disk.path]);
  async function inventory(hostId, category, actor, document) {
    if (category !== 'disk') throw problem('SSH_DEVICE_CLASS_UNSUPPORTED');
    const found = await fresh(hostId, actor), host = document.hosts.find(row => row.hostId === hostId) || { hostId, clusterId: found.host.cluster.id, address: found.host.management_ip, port: 22, hostKeySha256: '' };
    const secret = await key(), expiresAt = now() + 60000;
    const revision = sign(secret, 'inventory-set-v2', found.disks.map(row => [row.id, row.serial || null, row.path || null]));
    const credentials = sign(secret, 'proof-credentials-v2', resolveConnection(document, host).connection);
    return { version: 1, hostId, category, complete: true, inventoryRevision: revision, expiresAt: new Date(expiresAt).toISOString(), items: await Promise.all(found.disks.map(async row => {
      const base = { id: row.id, label: row.model, model: row.model, selectable: Boolean(row.selectable) };
      if (!row.selectable) return { ...base, reason: 'SSH_DEVICE_IDENTITY_UNVERIFIED' };
      const payload = { epoch, actor: [actor.source, actor.id], hostId, id: row.id, identity: identity(secret, host, row), revision, connectionsRevision: document.revision, endpoint: sign(secret, 'proof-endpoint-v2', endpoint(host)), credentials, expiresAt };
      const encoded = Buffer.from(canonical(payload)).toString('base64url');
      return { ...base, selectionToken: encoded + '.' + sign(secret, 'selection-proof-v2', encoded) };
    })) };
  }
  async function validate(document, previous, proofs, actor) {
    if (!Array.isArray(proofs) || proofs.length > 1000) throw problem('SSH_CONNECTION_SETTINGS_INVALID', 400);
    const used = new Set(), identities = {}, deadline = now() + 15000;
    for (const host of document.hosts) {
      if (now() >= deadline) throw problem('SSH_DEVICE_INVENTORY_TIMEOUT', 504);
      const found = await fresh(host.hostId, actor);
      if (found.host.cluster.id !== host.clusterId || found.host.management_ip !== host.address) throw problem('SSH_DEVICE_IDENTITY_CHANGED');
      const selection = host.devicePolicy.classes.disk;
      const secret = await key();
      for (const id of selection.ids) {
        const disk = found.disks.find(row => row.id === id);
        if (!disk?.selectable) throw problem('SSH_DEVICE_IDENTITY_UNVERIFIED');
        const current = identity(secret, host, disk), name = host.hostId + '/' + id;
        const proof = proofs.find(row => row.hostId === host.hostId && row.category === 'disk' && row.id === id);
        if (proof) {
          if (!exact(proof, ['hostId', 'category', 'id', 'selectionToken']) || used.has(name) || !text(proof.selectionToken, 8192)) throw problem('SSH_DEVICE_SELECTION_EXPIRED');
          used.add(name);
          const [encoded, signature, extra] = proof.selectionToken.split('.');
          const expected = sign(secret, 'selection-proof-v2', encoded);
          if (extra !== undefined || !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw problem('SSH_DEVICE_SELECTION_EXPIRED');
          let payload; try { payload = JSON.parse(Buffer.from(encoded, 'base64url')); } catch { throw problem('SSH_DEVICE_SELECTION_EXPIRED'); }
          const revision = sign(secret, 'inventory-set-v2', found.disks.map(row => [row.id, row.serial || null, row.path || null]));
          if (payload.epoch !== epoch || payload.expiresAt <= now() || canonical(payload.actor) !== canonical([actor.source, actor.id]) || payload.hostId !== host.hostId || payload.id !== id || payload.identity !== current || payload.revision !== revision || payload.connectionsRevision !== previous.revision || payload.endpoint !== sign(secret, 'proof-endpoint-v2', endpoint(host)) || payload.credentials !== sign(secret, 'proof-credentials-v2', resolveConnection(document, host).connection)) throw problem('SSH_DEVICE_SELECTION_EXPIRED');
        } else if (previous.selectionIdentities?.[name] !== current) throw problem(previous.selectionIdentities?.[name] ? 'SSH_DEVICE_IDENTITY_CHANGED' : 'SSH_DEVICE_SELECTION_EXPIRED');
        identities[name] = current;
      }
    }
    if (used.size !== proofs.length) throw problem('SSH_DEVICE_SELECTION_EXPIRED');
    return identities;
  }
  async function targets(document, actor) {
    const result = [], secret = await key(); let count = 0;
    for (const row of document.hosts) {
      const found = await fresh(row.hostId, actor);
      if (found.host.cluster.id !== row.clusterId || found.host.management_ip !== row.address || document.pendingLegacyRefs?.[row.hostId]?.length) throw problem('SSH_DEVICE_IDENTITY_UNVERIFIED');
      const scope = row.devicePolicy.classes.disk, selected = scope.mode === 'all' ? found.disks : scope.ids.map(id => found.disks.find(disk => disk.id === id));
      count += selected.length;
      if (count > 100) throw problem('SSH_TARGET_LIMIT');
      const devices = [];
      for (const item of selected) {
        if (!item?.selectable) throw problem('SSH_DEVICE_IDENTITY_UNVERIFIED');
        if (scope.mode === 'custom' && document.selectionIdentities[row.hostId + '/' + item.id] !== identity(secret, row, item)) throw problem('SSH_DEVICE_IDENTITY_CHANGED');
        devices.push({ deviceId: item.id, path: item.path, serial: item.serial });
      }
      const resolved = resolveConnection(document, row).connection;
      result.push({ hostId: row.hostId, clusterId: row.clusterId, address: row.address, port: row.port, hostKeySha256: row.hostKeySha256, ...(resolved ? { username: resolved.username, ...(resolved.password ? { password: resolved.password } : {}), ...(resolved.privateKey ? { privateKey: resolved.privateKey } : {}) } : {}),
        diskSelection: { source: 'fresh-host-inventory', mode: scope.mode, explicitlyEmpty: scope.mode === 'custom' && scope.ids.length === 0 }, devices });
    }
    return result;
  }
  async function connection(document, hostId, actor) {
    const row = document.hosts.find(host => host.hostId === hostId);
    if (!row) throw problem('SSH_HOST_UNAVAILABLE');
    const found = await fresh(hostId, actor, true);
    if (found.host.cluster.id !== row.clusterId || found.host.management_ip !== row.address) throw problem('SSH_DEVICE_IDENTITY_CHANGED');
    const credential = resolveConnection(document, row).connection;
    if (!credential) throw problem('SSH_CREDENTIAL_REQUIRED');
    const { authType, ...details } = credential;
    return { hostId: row.hostId, clusterId: row.clusterId, address: row.address, port: row.port, hostKeySha256: row.hostKeySha256, ...details, devices: [] };
  }
  return { available, inventory, validate, targets, connection };
}
