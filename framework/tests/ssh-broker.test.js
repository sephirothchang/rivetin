import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSshBroker } from '../server/ssh-broker.js';
import { createSshVault } from '../server/ssh-vault.js';

const actor = { id: 'example-admin', name: 'Example administrator', source: 'demo', admin: true }, id = 'rivetin-example';
const command = () => ({ id: 'identity', operation: 'host.identity', purpose: { 'zh-CN': '读取系统标识', 'en-US': 'Read system identity' }, hostIds: ['example-host'], intervalSeconds: 0 });
const host = () => ({ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, username: 'collector', hostKeySha256: 'a'.repeat(64), password: 'EXAMPLE_NOT_A_REAL_SECRET', devices: [{ deviceId: 'example-disk', path: '/dev/sda', serial: 'EXAMPLE_SERIAL' }] });
async function fixture(t, options = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'ssh-broker-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let timestamp = Date.UTC(2026, 0, 1), calls = 0;
  const vault = createSshVault(root); await vault.put(host());
  const status = { enabled: true, channelInstalled: true, channelEnabled: true, plugins: [{ id, installed: true, enabled: true, packageId: 'a'.repeat(64), manifest: { name: { 'zh-CN': '示例', 'en-US': 'Example' }, ssh: { version: 1, commands: [command()] } } }] };
  const events = [], broker = createSshBroker(root, { serviceStatus: async () => structuredClone(status), vault, now: () => timestamp,
    prepareResultContext: options.prepareResultContext, onResult: options.onResult,
    run: async input => { calls++; return options.run ? options.run(input) : { stdout: 'Linux x86_64', stderr: '', exitCode: 0 }; },
    audit: async event => { events.push(event); if (options.audit) await options.audit(event); } });
  t.after(() => broker.stop());
  return { root, broker, vault, status, events, calls: () => calls, advance: ms => { timestamp += ms; }, async approve(who = actor) { const review = await broker.review(id, who); return broker.approve({ pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true }, who); } };
}
test('SSH commands remain unapproved after install; enabling channel still requires explicit review confirmation', async t => {
  const f = await fixture(t);
  assert.equal((await f.broker.status(actor)).registrations[0].approved, false);
  await assert.rejects(f.broker.run(id, 'identity', actor), /SSH_APPROVAL_REQUIRED/); assert.equal(f.calls(), 0);
  await f.approve(); assert.equal(f.calls(), 0);
  assert.equal((await f.broker.run(id, 'identity', actor)).items[0].result, 'success');
  assert.equal(f.calls(), 1);
  const status = await f.broker.status(actor); assert.equal(status.registrations[0].approved, true); assert.ok(!JSON.stringify(status).includes('Linux x86_64'));
  assert.equal((await f.broker.results(id, actor)).items[0].stdout, 'Linux x86_64');
});

test('approved SMART target execution selects one disk without running other registered daily targets', async t => {
  const inputs = [], f = await fixture(t, { run: async input => { inputs.push(input.command); return { stdout: JSON.stringify({ serial_number: input.command.endsWith('/dev/sdb') ? 'EXAMPLE_SERIAL_B' : 'EXAMPLE_SERIAL', smart_status: { passed: true } }), exitCode: 0 }; } });
  await f.vault.put({ ...host(), devices: [...host().devices, { deviceId: 'second-disk', path: '/dev/sdb', serial: 'EXAMPLE_SERIAL_B' }] });
  f.status.plugins[0].manifest.ssh.commands = [{ ...command(), id: 'daily-smart', operation: 'disk.smart.read', deviceScope: 'configured' }];
  await assert.rejects(f.broker.selectSmartTarget(id, { hostId: 'example-host', deviceId: 'second-disk' }, actor), /SSH_APPROVAL_REQUIRED/);
  await f.approve(); const selection = await f.broker.selectSmartTarget(id, { hostId: 'example-host', deviceId: 'second-disk' }, actor);
  assert.equal((await f.broker.runTarget(selection, actor)).items[0].result, 'success');
  assert.deepEqual(inputs, ['sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sdb']);
  await assert.rejects(f.broker.runTarget({ ...selection, command: 'id' }, actor), /SSH_TARGET_NOT_APPROVED/);
  await assert.rejects(f.broker.runTarget({ ...selection, deviceId: 'missing' }, actor), /SSH_TARGET_NOT_APPROVED/);
  await f.broker.invalidate(id); await assert.rejects(f.broker.runTarget(selection, actor), /SSH_APPROVAL_REQUIRED/);
  assert.equal(inputs.length, 1);
});

test('manual SMART selection rejects multiple matching commands and cancelled external tasks cannot run', async t => {
  const f = await fixture(t);
  f.status.plugins[0].manifest.ssh.commands = ['daily', 'weekly'].map(name => ({ ...command(), id: name, operation: 'disk.smart.read', deviceScope: 'configured' }));
  await f.approve(); await assert.rejects(f.broker.selectSmartTarget(id, { hostId: 'example-host', deviceId: 'example-disk' }, actor), /SSH_SMART_COMMAND_AMBIGUOUS/);
  f.status.plugins[0].manifest.ssh.commands.pop(); await f.approve(); const selected = await f.broker.selectSmartTarget(id, { hostId: 'example-host', deviceId: 'example-disk' }, actor), controller = new AbortController(); controller.abort();
  await assert.rejects(f.broker.runTarget(selected, actor, { signal: controller.signal }), /SSH_EXECUTION_CANCELLED/);
  await assert.rejects(f.broker.selectSmartTarget(id, { hostId: 'example-host', deviceId: 'example-disk' }, { ...actor, admin: false }), /SSH_ADMIN_REQUIRED/); assert.equal(f.calls(), 0);
});
test('SSH review is actor-bound, expires and cannot be replayed or accepted without acknowledgment', async t => {
  const f = await fixture(t), review = await f.broker.review(id, actor), body = { pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true };
  await assert.rejects(f.broker.approve(body, { ...actor, id: 'other-admin' }), /SSH_REVIEW_CONFIRMATION_REQUIRED/);
  await assert.rejects(f.broker.approve(body, actor), /SSH_REVIEW_CONFIRMATION_REQUIRED/);
  const expired = await f.broker.review(id, actor); f.advance(120001);
  await assert.rejects(f.broker.approve({ ...body, challenge: expired.challenge }, actor), /SSH_REVIEW_CONFIRMATION_REQUIRED/);
  const missingAck = await f.broker.review(id, actor);
  await assert.rejects(f.broker.approve({ ...body, challenge: missingAck.challenge, acknowledged: false }, actor), /SSH_REVIEW_CONFIRMATION_REQUIRED/);
});
test('SSH status, review, approval, run and data queries reject non-admin callers', async t => {
  const f = await fixture(t), user = { ...actor, admin: false };
  for (const action of [() => f.broker.status(user), () => f.broker.review(id, user), () => f.broker.approve({}, user), () => f.broker.run(id, 'identity', user), () => f.broker.results(id, user)]) await assert.rejects(action, /SSH_ADMIN_REQUIRED/);
});
test('SSH changed package or host profile invalidates review and persisted approval', async t => {
  const f = await fixture(t); const review = await f.broker.review(id, actor);
  f.status.plugins[0].packageId = 'b'.repeat(64);
  await assert.rejects(f.broker.approve({ pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true }, actor), /SSH_REGISTRATION_CHANGED/);
  await f.approve(); await f.vault.put({ ...host(), port: 2222 });
  assert.equal((await f.broker.status(actor)).registrations[0].approved, false);
  await assert.rejects(f.broker.run(id, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
});
test('SSH approval audit failure fails closed and cannot leave executable authorization', async t => {
  const f = await fixture(t, { audit: event => { if (event.action === 'ssh.approve') throw new Error('audit write failed with EXAMPLE_SECRET'); } });
  await assert.rejects(f.approve()); assert.equal((await f.broker.status(actor)).registrations[0].approved, false);
  await assert.rejects(f.broker.run(id, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
});
test('SSH emergency gate, owner disable and channel disable persistently revoke approvals', async t => {
  for (const change of [f => { f.status.enabled = false; }, f => { f.status.channelEnabled = false; }, f => { f.status.plugins[0].enabled = false; }]) {
    const f = await fixture(t); await f.approve(); change(f); await f.broker.sync();
    f.status.enabled = true; f.status.channelEnabled = true; f.status.plugins[0].enabled = true;
    assert.equal((await f.broker.status(actor)).registrations[0].approved, false);
    await assert.rejects(f.broker.run(id, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
  }
});
test('SSH revoke aborts an in-flight transport and reapproval never revives the old batch', async t => {
  let entered, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { run: input => { signal = input.signal; entered(); return new Promise(() => {}); } });
  await f.approve(); const running = f.broker.run(id, 'identity', actor); await started;
  await f.broker.revoke(id, actor); assert.equal(signal.aborted, true); await f.approve();
  assert.equal((await running).items[0].result, 'failed');
  assert.equal((await f.broker.results(id, actor)).items[0].code, 'SSH_EXECUTION_CANCELLED');
});
test('SSH errors and stderr never leak through audit or failed result records', async t => {
  const f = await fixture(t, { run: () => { throw new Error('credential=EXAMPLE_SECRET'); } }); await f.approve();
  const result = await f.broker.run(id, 'identity', actor);
  assert.equal(result.items[0].code, 'SSH_EXECUTION_FAILED');
  assert.ok(!JSON.stringify(await f.broker.results(id, actor)).includes('EXAMPLE_SECRET'));
  assert.ok(!JSON.stringify(f.events).includes('EXAMPLE_SECRET'));
});
test('SSH schedules persist future deadlines, do not run immediately, and cancel after disable', async t => {
  const f = await fixture(t); f.status.plugins[0].manifest.ssh.commands[0].intervalSeconds = 300;
  await f.approve(); await f.broker.tick(); assert.equal(f.calls(), 0);
  f.advance(300001); await f.broker.tick(); await f.broker.drain(); assert.equal(f.calls(), 1);
  f.status.enabled = false; f.advance(300001); await f.broker.tick(); assert.equal(f.calls(), 1);
  f.status.enabled = true; await f.broker.tick(); assert.equal(f.calls(), 1);
});
test('SSH restarted scheduler rebases overdue tasks instead of replaying missed intervals', async t => {
  const f = await fixture(t); f.status.plugins[0].manifest.ssh.commands[0].intervalSeconds = 300; await f.approve(); f.advance(86400000);
  await f.broker.tick(); assert.equal(f.calls(), 0); f.advance(300001); await f.broker.tick(); await f.broker.drain(); assert.equal(f.calls(), 1);
});
test('SSH SMART data rejects replaced disks and never treats bitmask failure as device health success', async t => {
  const f = await fixture(t, { run: () => ({ stdout: JSON.stringify({ serial_number: 'DIFFERENT_DEVICE' }), stderr: '', exitCode: 8 }) });
  f.status.plugins[0].manifest.ssh.commands = [{ ...command(), id: 'smart', operation: 'disk.smart.read', deviceIds: ['example-disk'] }];
  await f.approve(); assert.equal((await f.broker.run(id, 'smart', actor)).items[0].code, 'SSH_DEVICE_IDENTITY_MISMATCH');
});
test('SSH SMART successful collection retains device exit bitmask for the consumer and omits stderr', async t => {
  const f = await fixture(t, { run: () => ({ stdout: JSON.stringify({ serial_number: 'EXAMPLE_SERIAL', smart_status: { passed: false } }), stderr: 'EXAMPLE_SECRET', exitCode: 8 }) });
  f.status.plugins[0].manifest.ssh.commands = [{ ...command(), id: 'smart', operation: 'disk.smart.read', deviceIds: ['example-disk'] }];
  await f.approve(); assert.equal((await f.broker.run(id, 'smart', actor)).items[0].result, 'success');
  const collected = (await f.broker.results(id, actor)).items[0];
  assert.equal(collected.exitCode, 8); assert.equal(JSON.parse(collected.stdout).smart_status.passed, false);
  assert.ok(!JSON.stringify(collected).includes('EXAMPLE_SECRET'));
});
test('SSH failed SMART samples preserve each device identity and sampling times without raw diagnostics', async t => {
  const f = await fixture(t, { run: () => { throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); } });
  await f.vault.put({ ...host(), devices: [...host().devices, { deviceId: 'second-disk', path: '/dev/sdb', serial: 'EXAMPLE_OTHER_SERIAL' }] });
  f.status.plugins[0].manifest.ssh.commands = [{ ...command(), id: 'smart', operation: 'disk.smart.read', deviceScope: 'configured' }];
  await f.approve(); const execution = await f.broker.run(id, 'smart', actor), results = (await f.broker.results(id, actor)).items;
  assert.deepEqual(execution.items.map(item => item.result), ['failed', 'failed']);
  assert.deepEqual(results.map(item => item.deviceId).sort(), ['example-disk', 'second-disk']);
  for (const item of results) {
    assert.equal(item.pluginId, id); assert.equal(item.hostId, 'example-host'); assert.equal(item.commandId, 'smart');
    assert.equal(item.code, 'SSH_EXECUTION_FAILED'); assert.ok(Number.isFinite(Date.parse(item.startedAt))); assert.ok(Number.isFinite(Date.parse(item.finishedAt)));
    assert.equal(Object.hasOwn(item, 'stdout'), false); assert.equal(Object.hasOwn(item, 'stderr'), false);
  }
  assert.doesNotMatch(JSON.stringify({ results, events: f.events }), /EXAMPLE_PRIVATE_DIAGNOSTIC|EXAMPLE_OTHER_SERIAL/);
  assert.ok(f.events.every(event => !Object.hasOwn(event, 'deviceId') && !Object.hasOwn(event, 'stdout') && !Object.hasOwn(event, 'stderr')));
  f.status.plugins.push({ ...structuredClone(f.status.plugins[0]), id: 'rivetin-other-consumer' });
  assert.deepEqual((await f.broker.results('rivetin-other-consumer', actor)).items, []);
});
test('SSH same-host concurrency cannot start a second transport and multi-host batches stay bounded', async t => {
  let entered, finish, count = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { run: () => { count++; entered(); return new Promise(resolve => { finish = resolve; }); } });
  await f.approve(); const first = f.broker.run(id, 'identity', actor); await started;
  const second = await f.broker.run(id, 'identity', actor);
  assert.equal(second.items[0].code, 'SSH_CONCURRENCY_LIMIT'); assert.equal(count, 1);
  finish({ stdout: 'Linux', exitCode: 0 }); await first;
});
test('SSH batch handles more than two targets sequentially and stops new connections at the five-minute budget', async t => {
  let f;
  f = await fixture(t, { run: () => { f.advance(300001); return { stdout: 'Linux', exitCode: 0 }; } });
  await f.vault.put({ ...host(), hostId: 'example-host-2' }); await f.vault.put({ ...host(), hostId: 'example-host-3' });
  f.status.plugins[0].manifest.ssh.commands[0].hostIds = ['example-host', 'example-host-2', 'example-host-3'];
  await f.approve(); const result = await f.broker.run(id, 'identity', actor);
  assert.equal(f.calls(), 1); assert.deepEqual(result.items.map(item => item.result), ['success', 'failed', 'failed']);
  assert.equal(result.items[1].code, 'SSH_BATCH_TIMEOUT');
});
test('SSH broker stop aborts an in-flight run, and scheduler cannot reenter during a blocked transport', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { run: () => { entered(); return new Promise(() => {}); } });
  f.status.plugins[0].manifest.ssh.commands[0].intervalSeconds = 300;
  await f.approve(); await f.broker.tick(); f.advance(300001);
  const scheduled = f.broker.tick(); await started; await f.broker.tick(); assert.equal(f.calls(), 1);
  await f.broker.stop(); await scheduled;
  assert.equal((await f.broker.results(id, actor)).items[0].code, 'SSH_EXECUTION_CANCELLED');
});
test('SSH concurrent approval consumes its review once and rejects changed scope before mutation', async t => {
  const f = await fixture(t), review = await f.broker.review(id, actor);
  const value = { pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true };
  const result = await Promise.allSettled([f.broker.approve(value, actor), f.broker.approve(value, actor)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(result.filter(item => item.status === 'rejected').length, 1);
  await f.broker.revoke(id, actor); const changed = await f.broker.review(id, actor);
  f.status.plugins[0].manifest.ssh.commands[0].intervalSeconds = 300;
  await assert.rejects(f.broker.approve({ ...value, challenge: changed.challenge, digest: changed.digest }, actor), /SSH_REGISTRATION_CHANGED/);
});
test('SSH excessive or malformed output and command-level failures never persist raw diagnostics', async t => {
  for (const output of [{ stdout: 'x'.repeat(1024 * 1024 + 1), exitCode: 0 }, { stdout: 'EXAMPLE_SECRET', exitCode: 1 }, { stdout: 'x', exitCode: undefined }]) {
    const f = await fixture(t, { run: () => output }); await f.approve(); const result = await f.broker.run(id, 'identity', actor);
    assert.equal(result.items[0].result, 'failed'); assert.ok(!JSON.stringify(await f.broker.results(id, actor)).includes('EXAMPLE_SECRET'));
  }
});
test('SSH scheduled transport is aborted by a later tick after another process disables the framework', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { run: () => { entered(); return new Promise(() => {}); } });
  f.status.plugins[0].manifest.ssh.commands[0].intervalSeconds = 300;
  await f.approve(); await f.broker.tick(); f.advance(300001); await f.broker.tick(); await started;
  f.status.enabled = false; await f.broker.tick(); await f.broker.drain();
  assert.equal((await f.broker.results(id, actor)).items[0].code, 'SSH_EXECUTION_CANCELLED');
});
test('SSH sync detects external approval removal and same-digest approval replacement', async t => {
  for (const replace of [false, true]) {
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, { run: () => { entered(); return new Promise(() => {}); } });
    await f.approve(); const execution = f.broker.run(id, 'identity', actor); await started;
    const filename = path.join(f.root, 'ssh-channel/approvals.json'), value = JSON.parse(await readFile(filename, 'utf8'));
    if (replace) value.approvals[id].id = 'EXAMPLE_DIFFERENT_APPROVAL'; else delete value.approvals[id];
    await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    await f.broker.tick(); assert.equal((await execution).items[0].code, 'SSH_EXECUTION_CANCELLED');
  }
});
test('SSH results cannot commit success when disable races with the final transport response', async t => {
  let f;
  f = await fixture(t, { run: () => { f.status.enabled = false; return { stdout: 'Linux', exitCode: 0 }; } });
  await f.approve(); const result = await f.broker.run(id, 'identity', actor);
  assert.equal(result.items[0].result, 'failed'); assert.ok(!(await f.broker.results(id, actor)).items.some(item => item.result === 'success'));
});
test('SSH idle ticks without approvals do not repeatedly create or rewrite approval files', async t => {
  const f = await fixture(t); await f.broker.tick(); await f.broker.tick();
  await assert.rejects(readFile(path.join(f.root, 'ssh-channel/approvals.json')), { code: 'ENOENT' });
});
test('SSH plugin result retention has both a record count and four-megabyte byte ceiling', async t => {
  const f = await fixture(t, { run: () => ({ stdout: 'x'.repeat(1024 * 1024), exitCode: 0 }) }); await f.approve();
  for (let n = 0; n < 6; n++) await f.broker.run(id, 'identity', actor);
  const results = await f.broker.results(id, actor);
  assert.ok(results.items.length <= 30); assert.ok(Buffer.byteLength(JSON.stringify(results)) <= 4 * 1024 * 1024);
  assert.ok(results.items.length >= 1);
});
test('SSH malformed registration is isolated from other valid registrations and commands', async t => {
  const f = await fixture(t);
  f.status.plugins.push({ ...structuredClone(f.status.plugins[0]), id: 'rivetin-broken', manifest: { ssh: { version: 1, commands: [{ ...command(), operation: 'shell' }] } } });
  const status = await f.broker.status(actor);
  assert.equal(status.registrations.find(item => item.pluginId === 'rivetin-broken').reason, 'SSH_REGISTRATION_INVALID');
  await assert.rejects(f.broker.review('rivetin-broken', actor), /SSH_REGISTRATION_INVALID/);
  await f.approve(); assert.equal((await f.broker.run(id, 'identity', actor)).items[0].result, 'success');
});
test('SSH durable per-plugin revoke nonce invalidates review tokens in another broker without affecting unrelated reviews', async t => {
  const f = await fixture(t);
  const otherId = 'rivetin-other'; f.status.plugins.push({ ...structuredClone(f.status.plugins[0]), id: otherId });
  const peer = createSshBroker(f.root, { vault: f.vault, serviceStatus: async () => structuredClone(f.status), run: async () => ({ stdout: 'Linux', exitCode: 0 }) });
  t.after(() => peer.stop());
  const own = await f.broker.review(id, actor), unrelated = await f.broker.review(otherId, actor);
  await peer.invalidate(id);
  await assert.rejects(f.broker.approve({ pluginId: id, challenge: own.challenge, digest: own.digest, acknowledged: true }, actor), /SSH_REGISTRATION_CHANGED/);
  assert.equal((await f.broker.approve({ pluginId: otherId, challenge: unrelated.challenge, digest: unrelated.digest, acknowledged: true }, actor)).approved, true);
});
test('SSH durable global revoke nonce invalidates outstanding review even when no plugin was approved yet', async t => {
  const f = await fixture(t), review = await f.broker.review(id, actor);
  const peer = createSshBroker(f.root, { vault: f.vault, serviceStatus: async () => structuredClone(f.status), run: async () => ({ stdout: 'Linux', exitCode: 0 }) });
  t.after(() => peer.stop()); await peer.invalidate(null);
  await assert.rejects(f.broker.approve({ pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true }, actor), /SSH_REGISTRATION_CHANGED/);
});
test('SSH owner becoming incompatible after a host version change cannot reuse its previous approval', async t => {
  const f = await fixture(t); await f.approve();
  // The service provider marks incompatible/config-corrupt consumers inactive.
  f.status.plugins[0].enabled = false;
  await f.broker.sync(); f.status.plugins[0].enabled = true;
  await assert.rejects(f.broker.run(id, 'identity', actor), /SSH_APPROVAL_REQUIRED/);
});
test('SSH configured host/device selectors expand complete trusted previews and execute without embedding environment IDs', async t => {
  const f = await fixture(t, { run: input => ({ stdout: JSON.stringify({ serial_number: input.host.devices.find(device => input.command.endsWith(device.path)).serial }), exitCode: 0 }) });
  const { hostIds, ...base } = command();
  f.status.plugins[0].manifest.ssh.commands = [{ ...base, operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured' }];
  await f.vault.put({ ...host(), hostId: 'second-host', devices: [{ deviceId: 'second-disk', path: '/dev/nvme1n1', serial: 'EXAMPLE_OTHER_SERIAL' }] });
  const view = (await f.broker.status(actor)).registrations[0].commands[0];
  assert.equal(view.hostScope, 'configured'); assert.equal(view.deviceScope, 'configured');
  assert.deepEqual(view.hostIds, ['example-host', 'second-host']); assert.deepEqual(view.deviceIds, ['example-disk', 'second-disk']);
  assert.deepEqual(view.preview, ['example-host/example-disk: sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sda', 'second-host/second-disk: sudo -n -- /usr/sbin/smartctl --json=c --all /dev/nvme1n1']);
  await f.approve(); assert.deepEqual((await f.broker.run(id, 'identity', actor)).items.map(item => item.result), ['success', 'success']);
});
test('SSH configured scope cannot be reviewed without hosts, devices or trusted serial identity', async t => {
  for (const shape of ['no-host', 'no-device', 'no-serial']) {
    const f = await fixture(t), { hostIds, ...base } = command();
    f.status.plugins[0].manifest.ssh.commands = [{ ...base, operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured' }];
    if (shape === 'no-host') await f.vault.remove('example-host');
    else await f.vault.put({ ...host(), devices: shape === 'no-device' ? [] : [{ deviceId: 'example-disk', path: '/dev/sda' }] });
    assert.equal((await f.broker.status(actor)).registrations[0].reason, 'SSH_TARGET_UNAVAILABLE');
    await assert.rejects(f.broker.review(id, actor), /SSH_TARGET_UNAVAILABLE/); assert.equal(f.calls(), 0);
  }
});
test('SSH adding or removing configured targets invalidates existing approvals and review transcripts', async t => {
  const f = await fixture(t), { hostIds, ...base } = command();
  f.status.plugins[0].manifest.ssh.commands = [{ ...base, hostScope: 'configured' }];
  const review = await f.broker.review(id, actor); await f.approve();
  await f.vault.put({ ...host(), hostId: 'second-host' });
  assert.equal((await f.broker.status(actor)).registrations[0].approved, false);
  await assert.rejects(f.broker.approve({ pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true }, actor), /SSH_REVIEW_CONFIRMATION_REQUIRED/);
  await f.approve(); await f.vault.remove('second-host');
  assert.equal((await f.broker.status(actor)).registrations[0].approved, false);
});
test('SSH dynamically expanded configured scope over the target ceiling is isolated to that registration', async t => {
  const f = await fixture(t), { hostIds, ...base } = command();
  f.status.plugins.push({ ...structuredClone(f.status.plugins[0]), id: 'rivetin-large-scope', manifest: { ssh: { version: 1, commands: [{ ...base, operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured' }] } } });
  await f.vault.put({ ...host(), devices: Array.from({ length: 101 }, (_, n) => ({ deviceId: 'disk-' + n, path: '/dev/nvme' + n + 'n1', serial: 'EXAMPLE_SERIAL_' + n })) });
  const view = await f.broker.status(actor);
  assert.equal(view.registrations.find(item => item.pluginId === 'rivetin-large-scope').reason, 'SSH_TARGET_LIMIT');
  await assert.rejects(f.broker.review('rivetin-large-scope', actor), /SSH_TARGET_LIMIT/);
  await f.approve(); assert.equal((await f.broker.run(id, 'identity', actor)).items[0].result, 'success');
});

test('SSH result hooks reject invalid injected values before initialization', () => {
  for (const hooks of [{ prepareResultContext: null }, { onResult: true }, { prepareResultContext: {} }])
    assert.throws(() => createSshBroker('qa', { serviceStatus: async () => ({}), ...hooks }), /^Error: SSH_RESULT_HOOK_INVALID$/);
});

test('SSH result context is prepared before transport and stays opaque while the success sink runs under the broker lock', async t => {
  const context = { generation: 'EXAMPLE_OPAQUE_GENERATION', marker: Symbol('opaque') }, steps = [], raw = JSON.stringify({ serial_number: 'EXAMPLE_SERIAL', counter_s: '18446744073709551615' });
  let f, seen;
  f = await fixture(t, {
    prepareResultContext: input => {
      steps.push('prepare'); assert.equal(f.calls(), 0);
      assert.equal(input.pluginId, id); assert.equal(input.commandId, 'smart'); assert.equal(input.operation, 'disk.smart.read');
      assert.equal(input.hostId, 'example-host'); assert.equal(input.deviceId, 'example-disk'); assert.deepEqual(input.host, host());
      input.host.username = 'changed-hook-copy'; return context;
    },
    run: input => { steps.push('transport'); assert.equal(input.host.username, 'collector'); return { stdout: raw, stderr: 'EXAMPLE_PRIVATE_STDERR', exitCode: 8 }; },
    onResult: async (item, supplied, control) => {
      steps.push('sink'); assert.equal(supplied, context); assert.equal(control.signal.aborted, false); await control.assertActive();
      assert.ok(JSON.parse(await readFile(path.join(f.root, 'ssh-channel/.write.lock'), 'utf8')).pid);
      assert.equal(item.operation, 'disk.smart.read'); assert.equal(item.deviceId, 'example-disk'); assert.equal(item.stdout, raw); assert.equal(item.exitCode, 8);
      seen = structuredClone(item); item.stdout = 'changed-hook-copy'; item.pluginId = 'rivetin-other';
    },
  });
  f.status.plugins[0].manifest.ssh.commands = [{ ...command(), id: 'smart', operation: 'disk.smart.read', deviceIds: ['example-disk'] }];
  await f.approve(); assert.equal((await f.broker.run(id, 'smart', actor)).items[0].result, 'success');
  assert.deepEqual(steps, ['prepare', 'transport', 'sink']); assert.deepEqual((await f.broker.results(id, actor)).items, [seen]);
  assert.doesNotMatch(JSON.stringify({ cache: await f.broker.results(id, actor), events: f.events }), /EXAMPLE_OPAQUE_GENERATION|EXAMPLE_PRIVATE_STDERR|changed-hook-copy/);
  assert.doesNotMatch(JSON.stringify(f.events), /18446744073709551615|EXAMPLE_SERIAL/);
});

test('SSH preparation failure never connects and notifies one fixed-code failure without leaking hook errors', async t => {
  const notifications = [];
  const f = await fixture(t, {
    prepareResultContext: () => { throw new Error('EXAMPLE_PRIVATE_CONTEXT_FAILURE'); },
    onResult: (item, context) => { assert.equal(context, undefined); notifications.push(item); },
  });
  await f.approve(); const result = await f.broker.run(id, 'identity', actor);
  assert.equal(f.calls(), 0); assert.equal(result.items[0].code, 'SSH_RESULT_CONTEXT_FAILED');
  assert.equal(notifications.length, 1); assert.equal(notifications[0].operation, 'host.identity'); assert.equal(notifications[0].result, 'failed');
  assert.doesNotMatch(JSON.stringify({ cache: await f.broker.results(id, actor), events: f.events }), /EXAMPLE_PRIVATE_CONTEXT_FAILURE/);
});

test('SSH failure sinks preserve distinct SMART target contexts and never receive unsuccessful output', async t => {
  const notifications = [], contexts = new Map();
  const f = await fixture(t, {
    prepareResultContext: input => { const context = { deviceId: input.deviceId, generation: input.deviceId + '-generation' }; contexts.set(input.deviceId, context); return context; },
    run: input => {
      if (input.command.endsWith('/dev/sda')) return { stdout: JSON.stringify({ serial_number: 'EXAMPLE_REPLACED_DISK' }), exitCode: 0 };
      throw new Error('EXAMPLE_PRIVATE_TRANSPORT_FAILURE');
    },
    onResult: async (item, context, control) => {
      await control.assertActive(); assert.equal(context, contexts.get(item.deviceId));
      assert.equal(item.operation, 'disk.smart.read'); assert.equal(Object.hasOwn(item, 'stdout'), false); assert.equal(Object.hasOwn(item, 'stderr'), false);
      notifications.push(item);
    },
  });
  await f.vault.put({ ...host(), devices: [...host().devices, { deviceId: 'second-disk', path: '/dev/sdb', serial: 'EXAMPLE_OTHER_SERIAL' }] });
  f.status.plugins[0].manifest.ssh.commands = [{ ...command(), id: 'smart', operation: 'disk.smart.read', deviceScope: 'configured' }];
  await f.approve(); await f.broker.run(id, 'smart', actor);
  assert.deepEqual(notifications.map(item => [item.deviceId, item.code]), [['example-disk', 'SSH_DEVICE_IDENTITY_MISMATCH'], ['second-disk', 'SSH_EXECUTION_FAILED']]);
  assert.ok(notifications.every(item => item.hostId === 'example-host' && item.pluginId === id && Number.isFinite(Date.parse(item.finishedAt))));
  assert.doesNotMatch(JSON.stringify({ cache: await f.broker.results(id, actor), events: f.events }), /EXAMPLE_PRIVATE_TRANSPORT_FAILURE|EXAMPLE_REPLACED_DISK/);
});

test('SSH sink failures become fixed visible failures and never trigger a second callback', async t => {
  for (const remoteFailure of [false, true]) {
    const notifications = [];
    const f = await fixture(t, {
      run: () => { if (remoteFailure) throw new Error('EXAMPLE_PRIVATE_TRANSPORT_FAILURE'); return { stdout: 'EXAMPLE_PRIVATE_OUTPUT', exitCode: 0 }; },
      onResult: item => { notifications.push(item); throw new Error('EXAMPLE_PRIVATE_SINK_FAILURE'); },
    });
    await f.approve(); const result = await f.broker.run(id, 'identity', actor), cache = await f.broker.results(id, actor);
    assert.equal(notifications.length, 1); assert.equal(notifications[0].result, remoteFailure ? 'failed' : 'success');
    assert.equal(result.items[0].code, 'SSH_RESULT_PERSIST_FAILED'); assert.equal(cache.items[0].code, 'SSH_RESULT_PERSIST_FAILED');
    assert.equal(cache.items[0].result, 'failed'); assert.equal(Object.hasOwn(cache.items[0], 'stdout'), false);
    assert.equal(f.events.at(-1).code, 'SSH_RESULT_PERSIST_FAILED');
    assert.doesNotMatch(JSON.stringify({ cache, events: f.events }), /EXAMPLE_PRIVATE_/);
  }
});

test('SSH revoke during preparation prevents transport and cannot revive the old context after reapproval', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; }), notifications = [];
  const f = await fixture(t, { prepareResultContext: async () => { entered(); await waiting; return { generation: 'old-generation' }; }, onResult: item => notifications.push(item) });
  await f.approve(); const running = f.broker.run(id, 'identity', actor); await started;
  await f.broker.revoke(id, actor); await f.approve(); release();
  assert.equal((await running).items[0].code, 'SSH_APPROVAL_REVOKED'); assert.equal(f.calls(), 0);
  assert.equal(notifications.length, 1); assert.equal(notifications[0].result, 'failed');
});

test('SSH external approval removal during preparation is checked even without a local abort signal', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; }), notifications = [];
  const f = await fixture(t, { prepareResultContext: async () => { entered(); await waiting; }, onResult: item => notifications.push(item) });
  await f.approve(); const running = f.broker.run(id, 'identity', actor); await started;
  const filename = path.join(f.root, 'ssh-channel/approvals.json'), value = JSON.parse(await readFile(filename, 'utf8')); delete value.approvals[id];
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 }); release();
  assert.equal((await running).items[0].code, 'SSH_APPROVAL_REVOKED'); assert.equal(f.calls(), 0);
  assert.equal(notifications.length, 1); assert.equal(notifications[0].result, 'failed');
});

test('SSH cancellation and disable before the commit never call a success sink', async t => {
  for (const cancel of ['stop', 'revoke', 'disable']) {
    let entered; const started = new Promise(resolve => { entered = resolve; }), notifications = [];
    const f = await fixture(t, {
      prepareResultContext: () => ({ generation: 'example-generation' }),
      run: () => { if (cancel === 'disable') { f.status.enabled = false; return { stdout: 'EXAMPLE_OUTPUT', exitCode: 0 }; } entered(); return new Promise(() => {}); },
      onResult: item => notifications.push(item),
    });
    await f.approve(); const running = f.broker.run(id, 'identity', actor);
    if (cancel !== 'disable') { await started; if (cancel === 'stop') await f.broker.stop(); else await f.broker.revoke(id, actor); }
    assert.equal((await running).items[0].result, 'failed');
    assert.equal(notifications.length, 1); assert.equal(notifications[0].result, 'failed');
    assert.ok(!(await f.broker.results(id, actor)).items.some(item => item.result === 'success'));
  }
});

test('SSH a blocked sink checks cancellation immediately before its independent history commit', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; }), history = [];
  let callbacks = 0;
  const f = await fixture(t, { onResult: async (item, context, control) => { callbacks++; entered(); await waiting; assert.equal(control.signal.aborted, true); await control.assertActive(); history.push(item); } });
  await f.approve(); const running = f.broker.run(id, 'identity', actor); await started;
  const revoking = f.broker.revoke(id, actor); release();
  const [result] = await Promise.all([running, revoking]);
  assert.equal(callbacks, 1); assert.deepEqual(history, []); assert.equal(result.items[0].code, 'SSH_RESULT_PERSIST_FAILED');
  assert.equal((await f.broker.results(id, actor)).items[0].result, 'failed');
});

test('SSH the post-sink check rejects an external emergency epoch change without caching success', async t => {
  let f, callbacks = 0;
  f = await fixture(t, { onResult: async (item, context, control) => {
    callbacks++; await control.assertActive(); const directory = path.join(f.root, 'framework'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'ssh-revocation.json'), JSON.stringify({ nonce: 'b'.repeat(32) }), { mode: 0o600 });
  } });
  await f.approve(); const result = await f.broker.run(id, 'identity', actor);
  assert.equal(callbacks, 1); assert.equal(result.items[0].code, 'SSH_APPROVAL_REVOKED');
  assert.ok(!(await f.broker.results(id, actor)).items.some(item => item.result === 'success'));
});

test('SSH independent history sees each result before the bounded recent cache evicts it', async t => {
  const history = [];
  const f = await fixture(t, { onResult: async (item, context, control) => { await control.assertActive(); history.push(item); } });
  await f.approve(); for (let n = 0; n < 32; n++) await f.broker.run(id, 'identity', actor);
  const cache = (await f.broker.results(id, actor)).items;
  assert.equal(history.length, 32); assert.equal(new Set(history.map(item => item.id)).size, 32); assert.equal(cache.length, 30);
  assert.ok(!cache.some(item => item.id === history[0].id)); assert.equal(cache[0].id, history.at(-1).id);
});

test('SSH broker timeout can persist a metric-free failure while its authorization remains valid', async t => {
  let entered, transportSignal; const started = new Promise(resolve => { entered = resolve; }), history = [];
  const f = await fixture(t, { run: input => { transportSignal = input.signal; entered(); return new Promise(() => {}); },
    onResult: async (item, context, control) => { assert.equal(control.signal.aborted, false); await control.assertActive(); assert.equal(Object.hasOwn(item, 'stdout'), false); history.push(item); } });
  await f.approve(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = f.broker.run(id, 'identity', actor); await started; t.mock.timers.tick(30000);
  const result = await running;
  assert.equal(transportSignal.aborted, true); assert.equal(result.items[0].code, 'SSH_EXECUTION_TIMEOUT');
  assert.equal(history.length, 1); assert.equal(history[0].result, 'failed'); assert.equal(history[0].code, 'SSH_EXECUTION_TIMEOUT');
});

test('SSH revoke, stop or disable after timeout still blocks the independent failure-history commit', async t => {
  for (const action of ['revoke', 'stop', 'disable']) {
    let entered, sinkEntered, release;
    const started = new Promise(resolve => { entered = resolve; }), sinkStarted = new Promise(resolve => { sinkEntered = resolve; }), waiting = new Promise(resolve => { release = resolve; }), history = [];
    const f = await fixture(t, { run: () => { entered(); return new Promise(() => {}); }, onResult: async (item, context, control) => { sinkEntered(); await waiting; await control.assertActive(); if (control.signal.aborted) throw new Error('SSH_APPROVAL_REVOKED'); history.push(item); } });
    await f.approve(); t.mock.timers.enable({ apis: ['setTimeout'] });
    const running = f.broker.run(id, 'identity', actor); await started; t.mock.timers.tick(30000); await sinkStarted; t.mock.timers.reset();
    let cancelled = Promise.resolve();
    if (action === 'disable') f.status.enabled = false;
    else cancelled = action === 'stop' ? f.broker.stop() : f.broker.revoke(id, actor);
    release(); const [result] = await Promise.all([running, cancelled]);
    assert.deepEqual(history, []); assert.equal(result.items[0].result, 'failed'); assert.equal(result.items[0].code, 'SSH_RESULT_PERSIST_FAILED');
  }
});

test('SSH a high-priority cleared connection cannot be reviewed even when global credentials are ready', async t => {
  const f = await fixture(t), summary = await f.vault.connections();
  const credential = value => ({ username: value.username, authType: 'password', password: { action: 'keep' }, privateKey: { action: 'keep' } });
  await f.vault.saveConnections({ version: 1, operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', global: { ...credential({ username: 'global-reader' }), password: { action: 'replace', value: 'EXAMPLE_GLOBAL_PASSWORD' } }, clusters: [],
    hosts: summary.hosts.map(({ connection, effective, ...target }) => ({ ...target, connection: { ...credential(connection), password: { action: 'clear' } } })) });
  assert.equal((await f.broker.status(actor)).registrations[0].reason, 'SSH_TARGET_UNAVAILABLE');
  await assert.rejects(f.broker.review(id, actor), /^Error: SSH_TARGET_UNAVAILABLE$/); assert.equal(f.calls(), 0);
});
