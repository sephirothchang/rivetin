import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createService } from '../../../../framework/server/service.js';
import { createApi } from '../../../../framework/server/http.js';
import { bundle } from '../../../../framework/tests/helpers.js';
import { caller } from '../../../../framework/tests/data-fixture.js';
import { createClient } from '../../../../framework/src/client.js';
import { createDataProviders } from '../../../../framework/src/data-providers.js';
import { emptyPolicy } from '../../../../framework/server/ssh-device-policy.js';
import { PLUGIN_ID } from '../../src/configuration.js';

// Entirely synthetic inventory/SSH. The service, policy, HTTP and history are real.
export async function multiDiskService(t) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'multi-disk-'));
  const hosts = ['example-host-a', 'example-host-b'].map((id, index) => ({ id, cluster: { id: 'example-cluster' }, management_ip: `192.0.2.${10 + index}` }));
  const state = { commands: [], foreignRow: false, disks: [
    { id: 'disk-a-sata', host: { id: hosts[0].id }, path: '/dev/sda', serial: 'EXAMPLE_A_SATA', model: 'Example SATA' },
    { id: 'disk-a-sata-2', host: { id: hosts[0].id }, path: '/dev/sdb', serial: 'EXAMPLE_A_SATA_2', model: 'Example SATA' },
    { id: 'disk-a-nvme', host: { id: hosts[0].id }, path: '/dev/nvme0n1', serial: 'EXAMPLE_A_NVME', model: 'Example NVMe' },
    { id: 'disk-b-sata', host: { id: hosts[1].id }, path: '/dev/sdb', serial: 'EXAMPLE_B_SATA', model: 'Example SATA' },
  ] };
  const towerRequest = async (route, body, actor) => {
    assert.equal(actor?.auth?.Authorization, caller.auth.Authorization);
    if (route === '/v2/api/get-hosts') return structuredClone(hosts.filter(host => host.id === body.where.id));
    assert.equal(route, '/v2/api/get-disks');
    const rows = state.disks.filter(disk => disk.host.id === body.where.host.id);
    if (state.foreignRow && body.where.host.id === hosts[0].id) rows.push(state.disks.at(-1));
    return structuredClone(rows);
  };
  const service = createService(directory, { towerBuild: '4.9.0', towerRequest,
    readDisk: async ({ diskId, actor }) => {
      assert.equal(actor?.auth?.Authorization, caller.auth.Authorization);
      const disk = state.disks.find(row => row.id === diskId);
      if (!disk) throw new Error('TOWER_DISK_NOT_FOUND');
      return { id: disk.id, hostId: disk.host.id, path: disk.path, serial: disk.serial, model: disk.model };
    },
    sshRun: async ({ host, command }) => {
      const prefix = 'sudo -n -- /usr/sbin/smartctl --json=c --all ';
      assert.ok(command.startsWith(prefix));
      const disk = state.disks.find(row => row.host.id === host.hostId && row.path === command.slice(prefix.length));
      assert.ok(disk, 'COMMAND_DISK_MUST_BELONG_TO_THIS_HOST');
      state.commands.push({ hostId: host.hostId, diskId: disk.id, command });
      return { stdout: JSON.stringify({ serial_number: disk.serial, smartctl: { exit_status: 0 }, smart_status: { passed: true } }), stderr: '', exitCode: 0 };
    },
  });
  t.after(async () => {
    await service.smartBatch.stop(); await service.smartBatch.drain(); await service.smartCollection.stop(); await service.sshChannel.stop();
    const target = path.resolve(directory); if (!target.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await service.initialize(caller);
  for (const id of ['rivetin-ssh-channel', PLUGIN_ID]) {
    const manifest = id === PLUGIN_ID ? JSON.parse(await readFile(new URL('../../rivetin.json', import.meta.url))) : null;
    const upload = await service.upload(bundle(id, '0.1.0', pkg => { if (manifest) pkg.manifest = manifest; return pkg; }), caller);
    await service.change('install', id, upload.packageId, caller); await service.change('enable', id, null, caller);
  }
  await service.enable(caller);
  const settings = { version: 2, operationId: randomUUID(), expectedRevision: 0,
    global: { username: 'collector', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_NOT_A_REAL_SECRET' }, privateKey: { action: 'clear' } }, clusters: [], selectionProofs: [],
    hosts: hosts.map(host => ({ hostId: host.id, clusterId: host.cluster.id, address: host.management_ip, port: 22, hostKeySha256: 'a'.repeat(64), devicePolicy: emptyPolicy(), connection: null })) };
  await service.sshSaveConnections(settings, caller);
  const server = http.createServer(createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers.authorization === caller.auth.Authorization ? { ...caller } : null }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ localStorage: { getItem: () => JSON.stringify({ value: caller.auth.Authorization }) },
    fetch: (route, options) => fetch(origin + route, { ...options, headers: { ...options.headers, Origin: 'https://tower.example.invalid' } }) });
  const provider = createDataProviders(client, PLUGIN_ID).diskSmart;
  return { state, service, client, provider,
    async approve() { const review = await service.sshChannel.review(PLUGIN_ID, caller); await service.sshChannel.approve({ pluginId: PLUGIN_ID, digest: review.digest, challenge: review.challenge, acknowledged: true }, caller); return review; },
    async custom(selections) {
      const current = await service.sshConnections(caller), proofs = [];
      const next = { ...settings, operationId: randomUUID(), expectedRevision: current.revision,
        global: { username: 'collector', authType: 'password', password: { action: 'keep' }, privateKey: { action: 'keep' } },
        hosts: structuredClone(settings.hosts) };
      for (const host of next.hosts) {
        const ids = selections[host.hostId] || [];
        host.devicePolicy.classes.disk = { mode: 'custom', ids };
        if (ids.length) {
          const inventory = await client(`/ssh-channel/device-inventory?hostId=${host.hostId}&category=disk`);
          for (const id of ids) proofs.push({ hostId: host.hostId, category: 'disk', id, selectionToken: inventory.items.find(item => item.id === id)?.selectionToken });
        }
      }
      next.selectionProofs = proofs; await client('/ssh-channel/connections', 'PUT', next);
    },
  };
}
