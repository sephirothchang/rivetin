import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from './helpers.js';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { createClient } from '../src/client.js';
import { createDataProviders } from '../src/data-providers.js';

export const smartId = 'rivetin-smart-example';
export const caller = { id: 'example-admin', name: 'Example administrator', source: 'tower', role: 'ROOT', admin: true, auth: { Authorization: 'EXAMPLE_NOT_A_REAL_TOKEN' } };
export async function smartFixture(t, { twoDevices = false } = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'data-integration-'));
  let denied = false, serial = 'EXAMPLE_SERIAL', runs = 0, failRun = false;
  const reads = [], commands = [];
  const service = createService(directory, { towerBuild: '4.9.0', readDisk: async ({ diskId, actor }) => {
    reads.push({ diskId, actorId: actor.id, auth: actor.auth });
    if (denied) throw Object.assign(new Error('TOWER_DISK_READ_FAILED'), { status: 403 });
    const second = diskId === 'example-disk-second';
    return { id: diskId, hostId: 'example-host', serial: second ? 'EXAMPLE_SECOND_SERIAL' : serial, path: second ? '/dev/sdb' : '/dev/sda', model: 'Example disk' };
  }, sshRun: async ({ command }) => {
    commands.push(command);
    runs++; if (typeof failRun === 'function' ? await failRun({ command }) : failRun) throw new Error('SSH_EXECUTION_TIMEOUT');
    const second = command.endsWith('/dev/sdb');
    return { stdout: JSON.stringify({ serial_number: second ? 'EXAMPLE_SECOND_SERIAL' : serial, device: { name: second ? '/dev/sdb' : '/dev/sda', protocol: 'ATA' }, smartctl: { exit_status: 0 }, smart_status: { passed: true }, temperature: { current: 35 }, power_on_time: { hours: 123 } }), stderr: '', exitCode: 0 };
  } });
  t.after(async () => { await service.smartBatch?.stop(); await service.smartBatch?.drain(); await Promise.all([service.smartCollection.stop(), service.sshChannel.stop()]); if (!directory.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE'); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await service.initialize(caller);
  for (const id of ['rivetin-ssh-channel', smartId]) {
    const bytes = bundle(id, '0.1.0', pkg => {
      if (id === smartId) {
        pkg.manifest.permissions = ['inventory.read', 'disk.smart.read', 'ssh.channel.use'];
        pkg.manifest.ssh = { version: 1, commands: [{ id: 'daily-smart', operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured', intervalSeconds: 86400, purpose: { 'zh-CN': '读取磁盘健康', 'en-US': 'Read disk health' } }] };
      }
      return pkg;
    });
    const upload = await service.upload(bytes, caller); await service.change('install', id, upload.packageId, caller); await service.change('enable', id, null, caller);
  }
  await service.enable(caller);
  await service.sshSaveHost({ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, username: 'collector', password: 'EXAMPLE_NOT_A_REAL_SSH_SECRET', hostKeySha256: 'a'.repeat(64), devices: [{ deviceId: 'example-device', path: '/dev/sda', serial }, ...(twoDevices ? [{ deviceId: 'example-second-device', path: '/dev/sdb', serial: 'EXAMPLE_SECOND_SERIAL' }] : [])] }, caller);
  await service.smartBind({ diskId: 'example-disk', profileHostId: 'example-host', deviceId: 'example-device' }, caller);
  if (twoDevices) await service.smartBind({ diskId: 'example-disk-second', profileHostId: 'example-host', deviceId: 'example-second-device' }, caller);
  const server = http.createServer(createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers.authorization === caller.auth.Authorization ? { ...caller, auth: { Authorization: req.headers.authorization } } : null }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ localStorage: { getItem: () => JSON.stringify({ value: caller.auth.Authorization }) }, fetch: (route, options) => fetch(url + route, { ...options, headers: { ...options.headers, Origin: 'https://tower.example.invalid' } }) });
  return { directory, service, client, url, provider: createDataProviders(client, smartId).diskSmart, reads, commands,
    deny(value = true) { denied = value; }, replaceSerial(value) { serial = value; }, failRun(value = true) { failRun = value; }, runs: () => runs,
    async approve() { const review = await service.sshChannel.review(smartId, caller); await service.sshChannel.approve({ pluginId: smartId, digest: review.digest, challenge: review.challenge, acknowledged: true }, caller); },
    async collect() { return service.sshChannel.run(smartId, 'daily-smart', caller); },
  };
}
