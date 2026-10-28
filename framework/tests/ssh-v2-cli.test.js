import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectionsFixture } from './ssh-v2-fixture.js';
import { caller } from './data-fixture.js';

test('actual data CLI requires offline assertion and disabled state, then migrates and rolls back ciphertext bytes', async t => {
  const f = await connectionsFixture(t, { legacy: true }), operationId = randomUUID(), run = promisify(execFile);
  const args = ['cli.mjs', 'ssh-connections-migrate', '--data', f.directory, '--direction', 'upgrade', '--operation', operationId];
  const env = { ...process.env }; delete env.RIVETIN_OFFLINE_WRITERS_STOPPED;
  await assert.rejects(run(process.execPath, args, { env, timeout: 15000 }), error => error.stderr.trim() === 'SSH_CONNECTION_MIGRATION_OFFLINE_CONFIRMATION_REQUIRED');
  env.RIVETIN_OFFLINE_WRITERS_STOPPED = 'yes';
  await assert.rejects(run(process.execPath, args, { env, timeout: 15000 }), error => error.stderr.trim() === 'SSH_CONNECTION_MIGRATION_REQUIRES_DISABLED');
  await f.service.disable(caller);
  const file = path.join(f.directory, 'ssh-channel/vault/example-host.host.json'), before = await readFile(file);
  const result = JSON.parse((await run(process.execPath, args, { env, timeout: 15000 })).stdout);
  assert.equal(result.migrated, true); assert.equal(result.unresolvedHosts, 1);
  args[args.indexOf('upgrade')] = 'rollback';
  assert.equal(JSON.parse((await run(process.execPath, args, { env, timeout: 15000 })).stdout).rolledBack, true);
  assert.deepEqual(await readFile(file), before);
});
