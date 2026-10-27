import { isIP } from 'node:net';
import { sshIdentifier, validSshDevicePath } from './ssh-policy.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const fail = () => { throw new Error('SSH_CONNECTION_SETTINGS_INVALID'); };
export const connectionOperationId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function validateSshTarget(value) {
  if (!exact(value, ['hostId', 'clusterId', 'address', 'port', 'hostKeySha256', 'devices']) || !sshIdentifier(value.hostId) || !sshIdentifier(value.clusterId) || !isIP(value.address)) throw new Error('SSH_HOST_INVALID');
  if (value.address.includes('%')) throw new Error('SSH_HOST_ADDRESS_REJECTED');
  const address = isIP(value.address) === 6 ? new URL(`http://[${value.address}]/`).hostname.slice(1, -1) : value.address;
  if (/^(?:0\.|127\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(address) || ['::', '::1'].includes(address) || /^(?:fe[89ab]|ff|::ffff:)/i.test(address)) throw new Error('SSH_HOST_ADDRESS_REJECTED');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('SSH_HOST_INVALID');
  if (typeof value.hostKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.hostKeySha256)) throw new Error('SSH_HOST_KEY_REQUIRED');
  if (!Array.isArray(value.devices) || value.devices.length > 1000) throw new Error('SSH_HOST_INVALID');
  const ids = new Set(), paths = new Set();
  for (const device of value.devices) {
    if (!exact(device, ['deviceId', 'path', 'serial']) || !sshIdentifier(device.deviceId) || !validSshDevicePath(device.path) || ids.has(device.deviceId) || paths.has(device.path)) throw new Error('SSH_DEVICE_INVALID');
    if (device.serial !== undefined && (typeof device.serial !== 'string' || !device.serial.length || device.serial.length > 256 || /[\x00-\x1f\x7f]/.test(device.serial))) throw new Error('SSH_DEVICE_INVALID');
    ids.add(device.deviceId); paths.add(device.path);
  }
  return structuredClone(value);
}
export function validateConnection(value) {
  if (!exact(value, ['username', 'authType', 'password', 'privateKey']) || typeof value.username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,31}\$?$/.test(value.username) || !['password', 'private-key'].includes(value.authType)) fail();
  if (value.password !== undefined && (value.authType !== 'password' || typeof value.password !== 'string' || !value.password.length || value.password.length > 1024 || value.password.includes('\0'))) fail();
  if (value.privateKey !== undefined && (value.authType !== 'private-key' || typeof value.privateKey !== 'string' || !/^-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----\r?\n/.test(value.privateKey) || value.privateKey.length > 32768)) fail();
  return structuredClone(value);
}
export function connectionSummary(value) {
  return value === null ? null : { username: value.username, authType: value.authType, hasPassword: typeof value.password === 'string', hasPrivateKey: typeof value.privateKey === 'string' };
}
function patchConnection(input, previous) {
  if (input === null) return null;
  if (!exact(input, ['username', 'authType', 'password', 'privateKey']) || !['password', 'private-key'].includes(input.authType)) fail();
  const clean = { username: input.username, authType: input.authType };
  for (const field of ['password', 'privateKey']) {
    const edit = input[field];
    if (!exact(edit, ['action', 'value']) || !['keep', 'replace', 'clear'].includes(edit.action) || edit.action !== 'replace' && Object.hasOwn(edit, 'value') || edit.action === 'replace' && typeof edit.value !== 'string') fail();
    const selected = field === (input.authType === 'password' ? 'password' : 'privateKey');
    if (!selected && edit.action === 'replace') fail();
    if (selected && edit.action === 'replace') clean[field] = edit.value;
    if (selected && edit.action === 'keep' && previous?.[field] !== undefined) clean[field] = previous[field];
  }
  return validateConnection(clean);
}
export function legacyConnections(profiles) {
  return { version: 1, revision: 0, updatedAt: null, operationId: null, requestDigest: null, global: null, clusters: [], hosts: profiles.map(profile => {
    const { username, password, privateKey, ...target } = profile;
    return { ...target, connection: { username, authType: privateKey ? 'private-key' : 'password', ...(password !== undefined ? { password } : { privateKey }) } };
  }) };
}
export function validateConnectionsDocument(value) {
  if (!exact(value, ['version', 'revision', 'updatedAt', 'operationId', 'requestDigest', 'global', 'clusters', 'hosts']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) || !(value.operationId === null || connectionOperationId(value.operationId)) || !(value.requestDigest === null || /^[a-f0-9]{64}$/.test(value.requestDigest))) fail();
  if (value.global !== null) validateConnection(value.global);
  if (!Array.isArray(value.clusters) || value.clusters.length > 500 || !Array.isArray(value.hosts) || value.hosts.length > 500) fail();
  const clusterIds = new Set(), hostIds = new Set();
  for (const row of value.clusters) {
    if (!exact(row, ['clusterId', 'connection']) || !sshIdentifier(row.clusterId) || clusterIds.has(row.clusterId) || row.connection === null) fail();
    clusterIds.add(row.clusterId); validateConnection(row.connection);
  }
  for (const row of value.hosts) {
    if (!exact(row, ['hostId', 'clusterId', 'address', 'port', 'hostKeySha256', 'devices', 'connection']) || hostIds.has(row.hostId)) fail();
    hostIds.add(row.hostId); const { connection, ...target } = row; validateSshTarget(target); if (connection !== null) validateConnection(connection);
  }
  return value;
}
export function applyConnections(previous, input, digest, updatedAt) {
  if (!exact(input, ['version', 'operationId', 'global', 'clusters', 'hosts']) || input.version !== 1 || !connectionOperationId(input.operationId) || !Array.isArray(input.clusters) || input.clusters.length > 500 || !Array.isArray(input.hosts) || input.hosts.length > 500) fail();
  const value = { version: 1, revision: previous.revision + 1, updatedAt, operationId: input.operationId, requestDigest: digest,
    global: patchConnection(input.global, previous.global),
    clusters: input.clusters.map(row => {
      if (!exact(row, ['clusterId', 'connection'])) fail();
      return { clusterId: row.clusterId, connection: patchConnection(row.connection, previous.clusters.find(item => item.clusterId === row.clusterId)?.connection) };
    }),
    hosts: input.hosts.map(row => {
      if (!exact(row, ['hostId', 'clusterId', 'address', 'port', 'hostKeySha256', 'devices', 'connection'])) fail();
      return { ...row, connection: patchConnection(row.connection, previous.hosts.find(item => item.hostId === row.hostId)?.connection) };
    }) };
  return validateConnectionsDocument(value);
}
export function resolveConnection(document, row) {
  if (row.connection !== null) return { source: 'host', connection: row.connection };
  const cluster = document.clusters.find(item => item.clusterId === row.clusterId);
  if (cluster) return { source: 'cluster', connection: cluster.connection };
  return { source: document.global ? 'global' : 'none', connection: document.global };
}
export function summarizeConnections(document) {
  return { version: 1, revision: document.revision, updatedAt: document.updatedAt, operationId: document.operationId,
    global: connectionSummary(document.global), clusters: document.clusters.map(row => ({ clusterId: row.clusterId, connection: connectionSummary(row.connection) })),
    hosts: document.hosts.map(row => {
      const { connection, ...target } = row, resolved = resolveConnection(document, row), effective = connectionSummary(resolved.connection);
      return { ...structuredClone(target), connection: connectionSummary(connection), effective: { source: resolved.source, username: effective?.username || '', authType: effective?.authType || '', hasPassword: effective?.hasPassword || false, hasPrivateKey: effective?.hasPrivateKey || false, ready: Boolean(effective?.hasPassword || effective?.hasPrivateKey) } };
    }) };
}
