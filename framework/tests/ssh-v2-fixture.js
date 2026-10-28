import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { createClient } from '../src/client.js';
import { bundle } from './helpers.js';
import { caller, smartId } from './data-fixture.js';
import { emptyPolicy } from '../server/ssh-device-policy.js';

// Real Rivetin HTTP/service/vault/broker, with an injected Tower/SSH transport.
// This fixture neither connects a real host nor establishes platform acceptance.
export async function connectionsFixture(t, { legacy = false } = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'connections-v2-'));
  const state = { reads: 0, runs: 0, denied: false, disks: [{ id: 'example-disk', host: { id: 'example-host' }, serial: 'EXAMPLE_SERIAL', path: '/dev/sda', model: 'Example disk' }] };
  const towerRequest = async (route, body, actor) => {
    state.reads++; if (state.denied) throw Object.assign(new Error('DENIED'), { status: 403 });
    if (!actor?.auth?.Authorization) throw Object.assign(new Error('DENIED'), { status: 401 });
    if (route === '/v2/api/get-hosts') return [{ id: 'example-host', cluster: { id: 'example-cluster' }, management_ip: '192.0.2.10' }];
    if (route === '/v2/api/get-disks') return structuredClone(state.disks);
    throw new Error('UNEXPECTED_FIXTURE_REQUEST');
  };
  const service = createService(directory, { towerBuild: '4.9.0', towerRequest,
    readDisk: async ({ diskId, actor }) => {
      const rows = await towerRequest('/v2/api/get-disks', {}, actor), row = rows.find(row => row.id === diskId);
      if (!row) throw new Error('TOWER_DISK_NOT_FOUND');
      return { id: row.id, hostId: row.host.id, serial: row.serial, path: row.path, model: row.model };
    }, sshRun: async () => { state.runs++; return { stdout: JSON.stringify({ serial_number: state.disks[0].serial, smartctl: { exit_status: 0 }, smart_status: { passed: true } }), stderr: '', exitCode: 0 }; },
  });
  t.after(async () => { await service.smartBatch.stop(); await service.smartBatch.drain(); await service.smartCollection.stop(); await service.sshChannel.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await service.initialize(caller);
  for (const id of ['rivetin-ssh-channel', smartId]) {
    const bytes = bundle(id, '0.1.0', pkg => {
      if (id === smartId) { pkg.manifest.permissions = ['inventory.read', 'disk.smart.read', 'ssh.channel.use']; pkg.manifest.ssh = { version: 1, commands: [{ id: 'daily-smart', operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured', intervalSeconds: 86400, purpose: { 'zh-CN': '读取磁盘健康', 'en-US': 'Read disk health' } }] }; }
      return pkg;
    });
    const upload = await service.upload(bytes, caller); await service.change('install', id, upload.packageId, caller); await service.change('enable', id, null, caller);
  }
  await service.enable(caller);
  const host = { hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, hostKeySha256: 'a'.repeat(64), devicePolicy: emptyPolicy(), connection: null };
  const patch = { username: 'collector', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_NOT_A_REAL_SSH_SECRET' }, privateKey: { action: 'clear' } };
  if (legacy) await service.sshSaveHost({ hostId: host.hostId, clusterId: host.clusterId, address: host.address, port: host.port, hostKeySha256: host.hostKeySha256, username: patch.username, password: patch.password.value, devices: [{ deviceId: 'legacy-device', path: '/dev/sda', serial: state.disks[0].serial }] }, caller);
  else await service.sshSaveConnections({ version: 2, operationId: randomUUID(), expectedRevision: 0, global: patch, clusters: [], hosts: [host], selectionProofs: [] }, caller);
  const server = http.createServer(createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers.authorization === caller.auth.Authorization ? { ...caller, auth: { Authorization: req.headers.authorization } } : null }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ localStorage: { getItem: () => JSON.stringify({ value: caller.auth.Authorization }) }, fetch: (route, options) => fetch(url + route, { ...options, headers: { ...options.headers, Origin: 'https://tower.example.invalid' } }) });
  const request = async () => { const value = await service.sshConnections(caller); return { version: 2, operationId: randomUUID(), expectedRevision: value.revision, global: value.global && { username: value.global.username, authType: value.global.authType, password: { action: 'keep' }, privateKey: { action: 'keep' } }, clusters: [], hosts: value.hosts.map(({ effective, policyState, ...row }) => ({ ...row, connection: row.connection === null ? null : { username: row.connection.username, authType: row.connection.authType, password: { action: 'keep' }, privateKey: { action: 'keep' } } })), selectionProofs: [] }; };
  return { directory, service, client, state, request, async approve() { const review = await service.sshChannel.review(smartId, caller); return service.sshChannel.approve({ pluginId: smartId, digest: review.digest, challenge: review.challenge, acknowledged: true }, caller); }, async collect() { return service.sshChannel.run(smartId, 'daily-smart', caller); }, runs: () => state.runs };
}
