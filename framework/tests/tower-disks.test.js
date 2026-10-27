import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerDiskReader } from '../server/tower-disks.js';

const actor = { id: 'example-admin', source: 'tower', auth: { Authorization: 'EXAMPLE_TOKEN' } };
const disk = () => ({ id: 'example-disk', host: { id: 'example-host', name: 'Example host', management_ip: '192.0.2.10' },
  serial: 'EXAMPLE_SERIAL', path: '/dev/sda', model: 'EXAMPLE_MODEL', extra: 'EXAMPLE_PRIVATE_RAW_FIELD' });

test('disk reader uses the exact REST filter and caller credentials, returning only internal identity fields', async () => {
  const calls = [];
  const read = createTowerDiskReader({ request: async (...args) => { calls.push(args); return [disk()]; } });
  assert.deepEqual(await read({ diskId: 'example-disk', actor }), { id: 'example-disk', hostId: 'example-host', serial: 'EXAMPLE_SERIAL', path: '/dev/sda', model: 'EXAMPLE_MODEL' });
  assert.deepEqual(calls[0], ['/v2/api/get-disks', { where: { id: 'example-disk' }, first: 2 }, actor]);
  assert.equal(calls[0][2], actor);
  assert.equal(calls.length, 1);
});

test('cookie caller is passed through and disk reads are never cached across callers', async () => {
  const seen = [];
  const read = createTowerDiskReader({ request: async (path, body, current) => { seen.push(current); return [disk()]; } });
  const second = { id: 'another-admin', auth: { Cookie: 'connect.sid=EXAMPLE_SESSION' } };
  await read({ diskId: 'example-disk', actor });
  await read({ diskId: 'example-disk', actor: second });
  assert.deepEqual(seen, [actor, second]);
});

test('missing transport, invalid ID and absent caller credentials fail before requesting', async () => {
  assert.throws(() => createTowerDiskReader(), /TOWER_TRANSPORT_REQUIRED/);
  let calls = 0;
  const read = createTowerDiskReader({ request: async () => { calls++; return [disk()]; } });
  for (const value of [null, undefined, {}, { diskId: '' }, { diskId: 'a'.repeat(129) }, { diskId: '../disk' }, { diskId: 'disk\n' }]) {
    await assert.rejects(read(value), /^Error: TOWER_DISK_REQUEST_INVALID$/);
  }
  for (const current of [undefined, {}, { auth: {} }, { auth: { Authorization: '' } }, { auth: { Authorization: 'BAD\r\nHEADER' } }]) {
    await assert.rejects(read({ diskId: 'example-disk', actor: current }), /^Error: AUTHENTICATION_REQUIRED$/);
  }
  assert.equal(calls, 0);
});

test('transport failures do not expose API diagnostics or retry with another identity', async () => {
  let calls = 0;
  const read = createTowerDiskReader({ request: async () => { calls++; throw new Error('EXAMPLE_PRIVATE_API_BODY'); } });
  await assert.rejects(read({ diskId: 'example-disk', actor }), /^Error: TOWER_DISK_READ_FAILED$/);
  assert.equal(calls, 1);
});

test('unknown IDs and nonunique responses fail closed', async () => {
  for (const [value, code] of [[[], 'TOWER_DISK_NOT_FOUND'], [[disk(), disk()], 'TOWER_DISK_AMBIGUOUS']]) {
    const read = createTowerDiskReader({ request: async () => value });
    await assert.rejects(read({ diskId: 'example-disk', actor }), new RegExp(`^Error: ${code}$`));
  }
});

test('envelopes, errors and malformed identities cannot be interpreted as a disk match', async () => {
  const invalid = [null, {}, { errors: [{ message: 'EXAMPLE_PRIVATE_API_BODY' }] }, { data: [disk()] }, { items: [disk()] },
    [null], [{ ...disk(), id: 'another-disk' }], [{ ...disk(), host: [{ id: 'example-host' }] }],
    [{ ...disk(), host: null }], [{ ...disk(), host: { id: '' } }], [{ ...disk(), host: { id: 'host/invalid' } }],
    [{ ...disk(), host: undefined, host_id: 'example-host' }]];
  const arrayWithError = [disk()]; arrayWithError.errors = [{ message: 'EXAMPLE_PRIVATE_API_BODY' }]; invalid.push(arrayWithError);
  for (const value of invalid) {
    const read = createTowerDiskReader({ request: async () => value });
    await assert.rejects(read({ diskId: 'example-disk', actor }), /^Error: TOWER_DISK_RESPONSE_INVALID$/);
  }
});

test('serial, path and model require bounded unambiguous scalar values', async () => {
  for (const [field, values] of Object.entries({ serial: [null, [], '', ' ', 'EXAMPLE\nSERIAL', 'x'.repeat(257)],
    model: [null, {}, '', 'EXAMPLE\x00MODEL', 'x'.repeat(513)],
    path: [null, [], '', '/tmp/sda', '/dev/../sda', '/dev//sda', '/dev/sda;reboot', '/dev/sda\n', '/dev/' + 'x'.repeat(252)] })) {
    for (const value of values) {
      const read = createTowerDiskReader({ request: async () => [{ ...disk(), [field]: value }] });
      await assert.rejects(read({ diskId: 'example-disk', actor }), /^Error: TOWER_DISK_RESPONSE_INVALID$/);
    }
  }
});
