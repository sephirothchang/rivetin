import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { storage, atomic, lockRetryDecision } from '../server/storage.js';

const failure = code => Object.assign(new Error('EXAMPLE_' + code), { code });
const file = { isFile: () => true, isSymbolicLink: () => false };
const directory = { isFile: () => false, isSymbolicLink: () => false };
const link = { isFile: () => false, isSymbolicLink: () => true };

async function fixture(t) {
  const base = path.resolve('qa/storage-lock'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'test-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return root;
}

test('Windows unlink-between-open-and-lstat race retries only its explicit missing-lock window', () => {
  const original = failure('EPERM'), missingStat = failure('ENOENT');
  const first = lockRetryDecision(original, { platform: 'win32', statError: missingStat, now: 1000 });
  assert.equal(first.retry, true); assert.equal(first.missing.expiresAt, 1180); assert.equal(first.missing.error, original);
  const late = failure('EPERM');
  assert.equal(lockRetryDecision(late, { platform: 'win32', statError: missingStat, now: 1179, missing: first.missing }).retry, true);
  const expired = lockRetryDecision(late, { platform: 'win32', statError: missingStat, now: 1180, missing: first.missing });
  assert.equal(expired.retry, false); assert.equal(expired.error, original);
  assert.equal(first.missing.expiresAt, 1180, 'Repeated failures must not extend the window.');
});

test('real Windows contention resets only a resolved missing episode and never treats unsafe objects as locks', () => {
  const original = failure('EPERM'), initial = lockRetryDecision(original, { platform: 'win32', statError: failure('ENOENT'), now: 0 });
  const regular = lockRetryDecision(original, { platform: 'win32', info: file, now: 100, missing: initial.missing });
  assert.deepEqual(regular, { retry: true, missing: null });
  const next = lockRetryDecision(original, { platform: 'win32', statError: failure('ENOENT'), now: 500, missing: regular.missing });
  assert.equal(next.missing.expiresAt, 680);
  for (const info of [directory, link, { isFile: () => true, isSymbolicLink: () => true }, undefined]) assert.equal(lockRetryDecision(original, { platform: 'win32', info, now: 1 }).retry, false);
});

test('permission errors, other lstat failures and non-Windows EPERM fail without retry', () => {
  for (const platform of ['linux', 'darwin']) assert.equal(lockRetryDecision(failure('EPERM'), { platform, statError: failure('ENOENT'), now: 0 }).retry, false);
  for (const code of ['EACCES', 'EIO', 'ENOTDIR', 'EPERM']) assert.equal(lockRetryDecision(failure('EPERM'), { platform: 'win32', statError: failure(code), now: 0 }).retry, false);
  for (const code of ['EACCES', 'EIO', 'EBUSY']) assert.equal(lockRetryDecision(failure(code), { platform: 'win32', info: file, now: 0 }).retry, false);
  for (const platform of ['win32', 'linux', 'darwin']) assert.deepEqual(lockRetryDecision(failure('EEXIST'), { platform, now: 0 }), { retry: true, missing: null });
});

test('concurrent real filesystem writers remain mutually exclusive and all increments commit', async t => {
  const root = await fixture(t), counter = path.join(root, 'counter.json'); await atomic(counter, { value: 0 });
  let active = 0, maximum = 0; const completed = new Set();
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => storage(root).locked(async () => {
    active++; maximum = Math.max(maximum, active);
    try { const previous = JSON.parse(await readFile(counter, 'utf8')); await new Promise(setImmediate); assert.equal(active, 1); await atomic(counter, { value: previous.value + 1 }); completed.add(index); }
    finally { active--; }
  })));
  assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results.map(result => result.status === 'fulfilled' ? 'ok' : result.reason?.code || result.reason?.message)));
  assert.equal(maximum, 1); assert.equal(completed.size, 40); assert.equal(JSON.parse(await readFile(counter, 'utf8')).value, 40);
  await assert.rejects(lstat(path.join(root, '.write.lock')), failure => failure.code === 'ENOENT');
});

test('a failing task releases only its acquired lock and a following writer completes', async t => {
  const root = await fixture(t), disk = storage(root), expected = failure('EXAMPLE_TASK_FAILURE');
  await assert.rejects(disk.locked(async () => { throw expected; }), value => value === expected);
  let ran = false; await disk.locked(async () => { ran = true; }); assert.equal(ran, true);
  await assert.rejects(lstat(path.join(root, '.write.lock')), value => value.code === 'ENOENT');
});

test('a competing lock keeps the original five-second bound and is never deleted by a waiter', async t => {
  const root = await fixture(t), lock = path.join(root, '.write.lock'), original = 'EXAMPLE_EXTERNAL_LOCK';
  await writeFile(lock, original, { flag: 'wx' }); let entered = false; const started = Date.now();
  await assert.rejects(storage(root).locked(async () => { entered = true; }), failure => failure.message === 'STORE_BUSY');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 6500, `Contention took ${elapsed}ms.`);
  assert.equal(entered, false); assert.equal(await readFile(lock, 'utf8'), original);
});
