import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { actor, bundle } from './helpers.js';

const channel = 'rivetin-ssh-channel', consumer = 'rivetin-ssh-example';
const command = () => ({ id: 'identity', operation: 'host.identity', hostIds: ['example-host'], purpose: { 'zh-CN': '读取系统标识', 'en-US': 'Read system identity' }, intervalSeconds: 0 });
const builtin = () => bundle(channel, '0.1.0', pkg => { pkg.manifest.configuration.defaults.enabled = false; return pkg; });
const child = (id = consumer, version = '0.1.0', mutate = pkg => pkg) => bundle(id, version, pkg => { pkg.manifest.permissions = ['ssh.channel.use']; pkg.manifest.ssh = { version: 1, commands: [command()] }; return mutate(pkg); });
const profile = () => ({ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, username: 'collector', hostKeySha256: 'a'.repeat(64), password: 'EXAMPLE_NOT_A_REAL_SSH_SECRET', devices: [] });

async function setup(t, { initialize = true, run = async () => ({ stdout: 'EXAMPLE_KERNEL', stderr: '', exitCode: 0 }), towerVersionProvider } = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'ssh-integration-'));
  const opts = { builtinPackages: [builtin()], sshRun: run, towerBuild: '4.9.0', ...(towerVersionProvider ? { towerVersionProvider } : {}) }, service = createService(directory, opts);
  t.after(async () => { await service.sshChannel.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  if (initialize) await service.initialize(actor);
  async function install(id = consumer, version = '0.1.0') { const uploaded = await service.upload(child(id, version), actor); await service.change('install', id, uploaded.packageId, actor); return uploaded; }
  async function ready(id = consumer) {
    await install(id); await service.sshSaveHost(profile(), actor); await service.enable(actor);
    await service.change('enable', channel, null, actor); await service.saveConfig(channel, { enabled: true }, actor); await service.change('enable', id, null, actor);
  }
  async function approve(id = consumer, target = service) { const review = await target.sshChannel.review(id, actor); return target.sshChannel.approve({ pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true }, actor); }
  return { directory, service, opts, install, ready, approve };
}
async function apiFor(t, service) {
  const api = createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers['x-example-role'] ? { ...actor, admin: req.headers['x-example-role'] === 'admin' } : null });
  const server = http.createServer(api); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/rivetin/v1`;
  return async (route, method = 'GET', body, extra = {}) => {
    const response = await fetch(base + route, { method, headers: { 'x-example-role': 'admin', Origin: 'https://tower.example.invalid', 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    return { status: response.status, body: await response.json() };
  };
}
function cli(args, input = '') {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['cli.mjs', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { proc.kill(); reject(new Error('EXAMPLE_CLI_TIMEOUT')); }, 10000);
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.once('error', reject); proc.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); proc.stdin.end(input);
  });
}

test('SSH builtin initializes installed but disabled, keeps configuration false, and repeated init preserves bytes', async t => {
  const { service, directory } = await setup(t);
  const installed = (await service.plugins()).find(item => item.id === channel);
  assert.equal(installed.installed, true); assert.equal(installed.enabled, false); assert.equal(installed.active, false);
  assert.equal((await service.loadConfig()).plugins[channel].settings.enabled, false);
  const stateFile = path.join(directory, 'plugins', channel, 'state.json'), before = await readFile(stateFile, 'utf8');
  assert.equal((await service.initialize(actor)).created, false); assert.equal(await readFile(stateFile, 'utf8'), before);
});
test('SSH builtin is added on framework upgrade, while an uninstall tombstone is respected across instances', async t => {
  const f = await setup(t, { initialize: false });
  const legacy = createService(f.directory, { towerBuild: '4.9.0' }); await legacy.initialize(actor); await legacy.enable(actor);
  await f.service.initialize(actor);
  assert.equal((await f.service.runtime()).enabled, true); assert.equal((await f.service.plugins()).find(item => item.id === channel).enabled, false);
  await f.service.change('uninstall', channel, null, actor);
  const newer = createService(f.directory, f.opts); await newer.initialize(actor);
  assert.equal((await newer.plugins()).find(item => item.id === channel).installed, false);
});
test('SSH channel requires framework, lifecycle and explicit functional configuration gates and per-plugin approval', async t => {
  let calls = 0; const f = await setup(t, { run: async () => { calls++; return { stdout: 'EXAMPLE_KERNEL', exitCode: 0 }; } });
  await f.install(); await f.service.sshSaveHost(profile(), actor); await f.service.enable(actor); await f.service.change('enable', consumer, null, actor);
  await assert.rejects(f.service.sshChannel.review(consumer, actor), /SSH_CHANNEL_DISABLED/);
  await f.service.change('enable', channel, null, actor);
  await assert.rejects(f.service.sshChannel.review(consumer, actor), /SSH_CHANNEL_DISABLED/);
  await f.service.saveConfig(channel, { enabled: true }, actor);
  assert.equal((await f.service.sshChannel.status(actor)).registrations[0].approved, false);
  await assert.rejects(f.service.sshChannel.run(consumer, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
  await f.approve(); assert.equal(calls, 0); await f.service.sshChannel.run(consumer, 'identity', actor); assert.equal(calls, 1);
});
test('SSH HTTP review and acknowledged approval work in two stages and reject reader or foreign-origin changes', async t => {
  const f = await setup(t); await f.ready(); const api = await apiFor(t, f.service);
  assert.equal((await api('/ssh-channel', 'GET', undefined, { 'x-example-role': '' })).status, 401);
  assert.equal((await api('/ssh-channel', 'GET', undefined, { 'x-example-role': 'reader' })).status, 403);
  for (const extra of [{ 'x-example-role': 'reader' }, { Origin: 'https://other.example.invalid' }]) assert.equal((await api('/ssh-channel', 'POST', { action: 'review', pluginId: consumer }, extra)).status, 403);
  const review = await api('/ssh-channel', 'POST', { action: 'review', pluginId: consumer });
  assert.equal(review.status, 200); assert.equal(review.body.registration.digest, review.body.digest); assert.match(review.body.registration.commands[0].preview[0], /uname -srm/);
  const body = { action: 'approve', pluginId: consumer, challenge: review.body.challenge, digest: review.body.digest, acknowledged: true };
  assert.equal((await api('/ssh-channel', 'POST', body)).status, 200);
  assert.equal((await api('/ssh-channel')).body.registrations.find(item => item.pluginId === consumer).approved, true);
  assert.equal((await api('/ssh-channel', 'POST', body)).status, 400);
});
test('SSH package installation rejects raw commands, unsafe operations and manifest permission bypass', async t => {
  const f = await setup(t);
  for (const mutate of [pkg => { pkg.manifest.ssh.commands[0].command = 'reboot'; return pkg; }, pkg => { pkg.manifest.ssh.commands[0].operation = 'system.reboot'; return pkg; }, pkg => { pkg.manifest.ssh.commands[0].hostIds = ['example;shutdown']; return pkg; }, pkg => { pkg.manifest.permissions = []; return pkg; }]) await assert.rejects(f.service.upload(child(consumer, '0.1.0', mutate), actor), /^Error: SSH_/);
  assert.ok(!(await f.service.plugins()).some(item => item.id === consumer));
});
for (const action of ['disable', 'reset', 'uninstall', 'configuration', 'update', 'rollback', 'channel-disable', 'channel-reset', 'channel-configuration', 'emergency']) {
  test(`SSH service ${action} revokes persisted approvals across a second service instance`, async t => {
    const f = await setup(t); await f.ready();
    if (action === 'rollback') { const uploaded = await f.service.upload(child(consumer, '0.1.1'), actor); await f.service.change('update', consumer, uploaded.packageId, actor); await f.service.change('enable', consumer, null, actor); }
    await f.approve();
    const other = createService(f.directory, f.opts);
    if (action === 'configuration') await other.saveConfig(consumer, { enabled: false }, actor);
    else if (action === 'channel-configuration') await other.saveConfig(channel, { enabled: false }, actor);
    else if (action === 'channel-disable') await other.change('disable', channel, null, actor);
    else if (action === 'channel-reset') await other.change('reset', channel, null, actor);
    else if (action === 'update') { const uploaded = await other.upload(child(consumer, '0.1.1'), actor); await other.change('update', consumer, uploaded.packageId, actor); }
    else if (action === 'emergency') await other.disable(actor);
    else await other.change(action, consumer, null, actor);
    const approvals = JSON.parse(await readFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'utf8'));
    assert.equal(approvals.approvals[consumer], undefined);
    await other.enable(actor);
    if (action === 'uninstall') await other.change('install', consumer, (await f.service.packages()).find(item => item.manifest.id === consumer).packageId, actor);
    await other.change('enable', consumer, null, actor); await other.change('enable', channel, null, actor); await other.saveConfig(channel, { enabled: true }, actor);
    await assert.rejects(f.service.sshChannel.run(consumer, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
  });
}
test('SSH HTTP host management redacts secrets from responses, config, logs, status and encrypted files', async t => {
  const f = await setup(t); await f.ready(); const api = await apiFor(t, f.service);
  const result = await api('/ssh-channel/hosts', 'POST', { action: 'put', profile: profile() });
  assert.equal(result.status, 200);
  for (const value of [result.body, (await api('/ssh-channel')).body, await f.service.loadConfig(), await f.service.logs()]) assert.ok(!JSON.stringify(value).includes(profile().password));
  const vault = path.join(f.directory, 'ssh-channel/vault');
  for (const name of await readdir(vault)) assert.ok(!(await readFile(path.join(vault, name), 'utf8')).includes(profile().password));
  assert.equal((await api('/ssh-channel/hosts', 'POST', { action: 'put', profile: profile() }, { 'x-example-role': 'reader' })).status, 403);
  assert.equal((await api('/ssh-channel/hosts', 'POST', { action: 'remove', hostId: profile().hostId }, { Origin: 'https://other.example.invalid' })).status, 403);
  assert.equal((await api('/ssh-channel/hosts', 'POST', { action: 'remove', hostId: profile().hostId })).status, 200);
});
test('SSH results remain scoped to their consumer and HTTP exposes no generic run or command endpoint', async t => {
  const f = await setup(t); await f.ready(); await f.install('rivetin-ssh-other'); await f.service.change('enable', 'rivetin-ssh-other', null, actor); await f.approve();
  await f.service.sshChannel.run(consumer, 'identity', actor); const api = await apiFor(t, f.service);
  assert.equal((await api('/ssh-channel/results?pluginId=' + consumer)).body.items.length, 1);
  assert.equal((await api('/ssh-channel/results?pluginId=rivetin-ssh-other')).body.items.length, 0);
  assert.equal((await api('/ssh-channel/results?pluginId=' + consumer, 'GET', undefined, { 'x-example-role': 'reader' })).status, 403);
  for (const body of [{ action: 'run', pluginId: consumer, commandId: 'identity' }, { action: 'review', pluginId: consumer, command: 'id' }, { action: 'approve', pluginId: consumer, command: 'id' }]) assert.equal((await api('/ssh-channel', 'POST', body)).status, 400);
  assert.equal((await api('/ssh-channel/run', 'POST', { command: 'id' })).status, 404);
});
test('SSH CLI imports secrets only from stdin, gives redacted output and revokes approvals', async t => {
  const f = await setup(t); await f.ready(); await f.approve();
  const output = await cli(['ssh-host-put', '--data', f.directory], JSON.stringify(profile()));
  assert.equal(output.code, 0); assert.equal(JSON.parse(output.stdout).saved, true); assert.ok(!(output.stdout + output.stderr).includes(profile().password));
  await assert.rejects(f.service.sshChannel.run(consumer, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
  const list = await cli(['ssh-hosts', '--data', f.directory]); assert.equal(list.code, 0); assert.ok(!(list.stdout + list.stderr).includes(profile().password));
  const rejected = await cli(['ssh-host-put', '--data', f.directory, 'EXAMPLE_FORBIDDEN_ARGUMENT']); assert.notEqual(rejected.code, 0); assert.match(rejected.stderr, /SSH_PROFILE_STDIN_REQUIRED/);
});
test('SSH offline emergency epoch survives immediate reenable and cancels old in-process authorization', async t => {
  const f = await setup(t); await f.ready(); await f.approve();
  await writeFile(path.join(f.directory, 'framework/disabled.json'), JSON.stringify({ disabledAt: 'EXAMPLE_OFFLINE_DISABLE' }));
  await writeFile(path.join(f.directory, 'framework/ssh-revocation.json'), JSON.stringify({ nonce: 'a'.repeat(32) }));
  const other = createService(f.directory, f.opts); await other.enable(actor);
  assert.equal((await f.service.sshChannel.status(actor)).registrations.find(item => item.pluginId === consumer).approved, false);
  await assert.rejects(f.service.sshChannel.run(consumer, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
});
test('SSH emergency disable returns confirmed framework disabled even with corrupt broker approval state', async t => {
  const f = await setup(t); await f.ready(); await f.approve();
  await writeFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'EXAMPLE_CORRUPT_STATE');
  const api = await apiFor(t, f.service), disabled = await api('/disable', 'POST');
  assert.equal(disabled.status, 200); assert.equal(disabled.body.enabled, false); assert.equal((await f.service.runtime()).enabled, false);
});
test('SSH offline emergency epoch changes cancel an active transport without relying on browser polling', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { run: () => { entered(); return new Promise(() => {}); } });
  await f.ready(); await f.approve();
  const execution = f.service.sshChannel.run(consumer, 'identity', actor); await started;
  await writeFile(path.join(f.directory, 'framework/ssh-revocation.json'), JSON.stringify({ nonce: 'b'.repeat(32) }));
  await f.service.sshChannel.tick(); await f.service.sshChannel.drain();
  assert.equal((await execution).items[0].code, 'SSH_EXECUTION_CANCELLED');
});
test('SSH malformed emergency epoch fails closed only for SSH and cannot prevent framework emergency disable', async t => {
  const f = await setup(t); await f.ready(); await f.approve();
  await writeFile(path.join(f.directory, 'framework/ssh-revocation.json'), JSON.stringify({ nonce: 'EXAMPLE_INVALID_NONCE', extra: true }));
  await assert.rejects(f.service.sshChannel.review(consumer, actor), /SSH_REVOCATION_INVALID/);
  assert.equal((await f.service.runtime()).enabled, true);
  assert.ok((await f.service.loadConfig()).plugins[consumer]);
  assert.equal((await f.service.disable(actor)).enabled, false); assert.equal((await f.service.runtime()).enabled, false);
});
test('SSH approval belongs to each consumer, and unrelated plugin changes cannot grant or revoke another consumer', async t => {
  const f = await setup(t); await f.ready(); await f.approve(); await f.install('rivetin-ssh-other'); await f.service.change('enable', 'rivetin-ssh-other', null, actor);
  let registrations = (await f.service.sshChannel.status(actor)).registrations;
  assert.equal(registrations.find(item => item.pluginId === consumer).approved, true);
  assert.equal(registrations.find(item => item.pluginId === 'rivetin-ssh-other').approved, false);
  await f.service.saveConfig('rivetin-ssh-other', { enabled: false }, actor);
  registrations = (await f.service.sshChannel.status(actor)).registrations;
  assert.equal(registrations.find(item => item.pluginId === consumer).approved, true);
  await assert.rejects(f.service.sshChannel.run('rivetin-ssh-other', 'identity', actor), /SSH_APPROVAL_REQUIRED/);
});
test('SSH service configuration change invalidates an unconfirmed review held by another process', async t => {
  const f = await setup(t); await f.ready();
  const review = await f.service.sshChannel.review(consumer, actor), other = createService(f.directory, f.opts);
  await other.saveConfig(consumer, { enabled: false }, actor);
  await assert.rejects(f.service.sshChannel.approve({ pluginId: consumer, challenge: review.challenge, digest: review.digest, acknowledged: true }, actor), /SSH_REGISTRATION_CHANGED/);
});
test('SSH packages with excessive host-device expansion are refused before installation or global channel disruption', async t => {
  const f = await setup(t); await f.ready(); await f.approve();
  await assert.rejects(f.service.upload(child('rivetin-too-large', '0.1.0', pkg => {
    pkg.manifest.ssh.commands = [{ ...command(), operation: 'disk.smart.read', hostIds: ['example-host', 'example-other-host'], deviceIds: Array.from({ length: 51 }, (_, n) => 'disk-' + n) }]; return pkg;
  }), actor), /SSH_TARGET_LIMIT/);
  assert.equal((await f.service.sshChannel.status(actor)).registrations.find(item => item.pluginId === consumer).approved, true);
});
test('SSH host version provider changing to an untested build suspends consumers and destroys their prior approval', async t => {
  let version = '4.9.0', calls = 0;
  const f = await setup(t, { towerVersionProvider: async () => version, run: async () => { calls++; return { stdout: 'EXAMPLE_KERNEL', exitCode: 0 }; } });
  await f.ready(); await f.approve();
  version = '4.10.0';
  assert.equal((await f.service.plugins()).find(item => item.id === consumer).active, false);
  const suspended = await f.service.sshChannel.status(actor);
  assert.equal(suspended.enabled, false); assert.equal(suspended.registrations.find(item => item.pluginId === consumer).approved, false);
  await assert.rejects(f.service.sshChannel.review(consumer, actor), /SSH_CHANNEL_DISABLED/);
  version = '4.9.0';
  await assert.rejects(f.service.sshChannel.run(consumer, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
  assert.equal(calls, 0);
});
