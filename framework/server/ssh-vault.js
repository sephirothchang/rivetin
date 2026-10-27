import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { atomic, storage } from './storage.js';
import { sshIdentifier } from './ssh-policy.js';
import { validateSshTarget, legacyConnections, validateConnectionsDocument, applyConnections, resolveConnection, summarizeConnections } from './ssh-connection-settings.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const allowed = ['hostId', 'clusterId', 'address', 'port', 'username', 'hostKeySha256', 'password', 'privateKey', 'devices'];
export function validateSshHost(value) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('SSH_HOST_INVALID');
  const { username, password, privateKey, ...target } = value;
  validateSshTarget(target);
  if (typeof username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,31}\$?$/.test(username)) throw new Error('SSH_HOST_INVALID');
  if ((typeof value.password === 'string') === (typeof value.privateKey === 'string')) throw new Error('SSH_CREDENTIAL_REQUIRED');
  if (value.password !== undefined && typeof value.password !== 'string' || value.privateKey !== undefined && typeof value.privateKey !== 'string') throw new Error('SSH_CREDENTIAL_INVALID');
  if (value.password !== undefined && (!value.password.length || value.password.length > 1024 || value.password.includes('\0'))) throw new Error('SSH_CREDENTIAL_INVALID');
  if (value.privateKey !== undefined && (!/^-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----\r?\n/.test(value.privateKey) || value.privateKey.length > 32768)) throw new Error('SSH_CREDENTIAL_INVALID');
  return structuredClone(value);
}

export function createSshVault(directory) {
  const root = path.join(path.resolve(directory), 'ssh-channel', 'vault'), disk = storage(root);
  const connectionsFile = path.join(root, 'connections.v1.json');
  async function hasConnections() { try { await lstat(connectionsFile); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  async function secureFile(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('SSH_VAULT_PERMISSIONS');
    if (info.size > (file === connectionsFile ? 3 * 1024 * 1024 : 1024 * 1024)) throw new Error('SSH_VAULT_INVALID');
  }
  async function key(create = true) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const filename = path.join(root, 'key.json');
    if (create) {
      // An absent key must be restored from backup, never replaced over existing ciphertext.
      if ((await names()).length || await hasConnections()) {
        try { await secureFile(filename); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('SSH_VAULT_KEY_MISSING'); throw error; }
      }
      try { await writeFile(filename, JSON.stringify({ key: randomBytes(32).toString('base64') }), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await secureFile(filename);
    let value;
    try { value = JSON.parse(await readFile(filename, 'utf8')); }
    catch { throw new Error('SSH_VAULT_INVALID'); }
    if (!object(value) || !/^[A-Za-z0-9+/]{43}=$/.test(value.key || '')) throw new Error('SSH_VAULT_INVALID');
    return Buffer.from(value.key, 'base64');
  }
  const file = hostId => {
    if (!sshIdentifier(hostId)) throw new Error('SSH_HOST_INVALID');
    return path.join(root, `${hostId}.host.json`);
  };
  async function names() {
    try { const result = (await readdir(root)).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.host\.json$/.test(name)).sort(); if (result.length > 500) throw new Error('SSH_HOST_LIMIT'); return result; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function legacyGet(hostId) {
    try {
      const filename = file(hostId); await secureFile(filename);
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (!object(value) || value.version !== 1 || typeof value.iv !== 'string' || !/^[a-f0-9]{24}$/.test(value.iv) || typeof value.tag !== 'string' || !/^[a-f0-9]{32}$/.test(value.tag) || typeof value.ciphertext !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(value.ciphertext)) throw new Error('SSH_VAULT_INVALID');
      const decipher = createDecipheriv('aes-256-gcm', await key(false), Buffer.from(value.iv, 'hex'));
      decipher.setAAD(Buffer.from(hostId)); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      const profile = validateSshHost(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'hex')), decipher.final()]).toString('utf8')));
      if (profile.hostId !== hostId) throw new Error('SSH_VAULT_INVALID');
      return profile;
    } catch (error) { if (error.code === 'ENOENT') throw new Error('SSH_HOST_UNAVAILABLE'); throw new Error(/^(SSH_[A-Z_]+)$/.test(error.message) ? error.message : 'SSH_VAULT_INVALID'); }
  }
  async function readConnections() {
    if (!await hasConnections()) return null;
    try {
      await secureFile(connectionsFile);
      const value = JSON.parse(await readFile(connectionsFile, 'utf8'));
      if (!object(value) || value.version !== 1 || !/^[a-f0-9]{24}$/.test(value.iv || '') || !/^[a-f0-9]{32}$/.test(value.tag || '') || !/^(?:[a-f0-9]{2})+$/.test(value.ciphertext || '')) throw new Error('SSH_VAULT_INVALID');
      const decipher = createDecipheriv('aes-256-gcm', await key(false), Buffer.from(value.iv, 'hex'));
      decipher.setAAD(Buffer.from('rivetin-ssh-connections-v1')); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return validateConnectionsDocument(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'hex')), decipher.final()]).toString('utf8')));
    } catch (error) { throw new Error(error.code === 'ENOENT' ? 'SSH_VAULT_KEY_MISSING' : /^SSH_[A-Z_]+$/.test(error.message || '') ? error.message : 'SSH_VAULT_INVALID'); }
  }
  async function currentConnections() {
    const saved = await readConnections();
    if (saved) return saved;
    const profiles = []; for (const name of await names()) profiles.push(await legacyGet(name.slice(0, -'.host.json'.length)));
    return legacyConnections(profiles);
  }
  async function writeConnections(value) {
    validateConnectionsDocument(value);
    const plaintext = Buffer.from(JSON.stringify(value));
    if (plaintext.length > 1024 * 1024) throw new Error('SSH_CONNECTION_SETTINGS_TOO_LARGE');
    try {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv);
      cipher.setAAD(Buffer.from('rivetin-ssh-connections-v1'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await atomic(connectionsFile, { version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
    } finally { plaintext.fill(0); }
  }
  async function get(hostId) {
    if (!sshIdentifier(hostId)) throw new Error('SSH_HOST_INVALID');
    const document = await readConnections();
    if (!document) return legacyGet(hostId);
    const row = document.hosts.find(item => item.hostId === hostId);
    if (!row) throw new Error('SSH_HOST_UNAVAILABLE');
    const { connection, ...target } = row, resolved = resolveConnection(document, row).connection;
    if (!resolved || !resolved.password && !resolved.privateKey) throw new Error('SSH_CREDENTIAL_REQUIRED');
    const { authType, ...credential } = resolved;
    return validateSshHost({ ...target, ...credential });
  }
  async function revision() {
    const hash = createHash('sha256');
    if (await hasConnections()) { await secureFile(connectionsFile); return hash.update('connections.v1.json').update(await readFile(connectionsFile)).digest('hex'); }
    for (const name of await names()) { const filename = path.join(root, name); await secureFile(filename); hash.update(name); hash.update(await readFile(filename)); }
    return hash.digest('hex');
  }
  return {
    root, get, revision,
    async connections() { return summarizeConnections(await currentConnections()); },
    async saveConnections(input) {
      let request, digest;
      try { request = structuredClone(input); const bytes = JSON.stringify(request); if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('SSH_CONNECTION_SETTINGS_TOO_LARGE'); digest = createHash('sha256').update(bytes).digest('hex'); }
      catch (error) { throw new Error(error.message === 'SSH_CONNECTION_SETTINGS_TOO_LARGE' ? error.message : 'SSH_CONNECTION_SETTINGS_INVALID'); }
      return disk.locked(async () => {
        const previous = await currentConnections();
        if (request.operationId && request.operationId === previous.operationId) {
          if (digest !== previous.requestDigest) throw new Error('SSH_CONNECTION_OPERATION_CONFLICT');
          return summarizeConnections(previous);
        }
        const next = applyConnections(previous, request, digest, new Date().toISOString());
        await writeConnections(next); return summarizeConnections(next);
      });
    },
    async list() {
      const document = await readConnections();
      if (document) return summarizeConnections(document).hosts.map(({ connection, effective, ...target }) => ({ ...target, username: effective.username, authType: effective.authType, credentialConfigured: effective.ready }));
      const items = [];
      for (const name of await names()) {
        const profile = await get(name.slice(0, -'.host.json'.length));
        items.push({ hostId: profile.hostId, clusterId: profile.clusterId, address: profile.address, port: profile.port, username: profile.username, hostKeySha256: profile.hostKeySha256, authType: profile.privateKey ? 'private-key' : 'password', devices: profile.devices });
      }
      return items;
    },
    put(profile) {
      const clean = validateSshHost(profile);
      return disk.locked(async () => {
        const document = await readConnections();
        if (document) {
          const row = legacyConnections([clean]).hosts[0], index = document.hosts.findIndex(item => item.hostId === clean.hostId);
          if (index < 0) document.hosts.push(row); else document.hosts[index] = row;
          await writeConnections({ ...document, revision: document.revision + 1, updatedAt: new Date().toISOString(), operationId: null, requestDigest: null });
          return { hostId: clean.hostId, saved: true };
        }
        const existing = await names(); if (existing.length >= 500 && !existing.includes(`${clean.hostId}.host.json`)) throw new Error('SSH_HOST_LIMIT');
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv);
        cipher.setAAD(Buffer.from(clean.hostId));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(clean)), cipher.final()]);
        await atomic(file(clean.hostId), { version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
        return { hostId: clean.hostId, saved: true };
      });
    },
    remove(hostId) { return disk.locked(async () => {
      file(hostId); const document = await readConnections();
      if (document) await writeConnections({ ...document, hosts: document.hosts.filter(item => item.hostId !== hostId), revision: document.revision + 1, updatedAt: new Date().toISOString(), operationId: null, requestDigest: null });
      else await unlink(file(hostId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return { hostId, removed: true };
    }); },
  };
}
