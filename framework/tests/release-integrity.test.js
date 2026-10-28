import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildIntegrity } from '../scripts/release-integrity.mjs';

const row = (path = 'server/main.js', content = Buffer.from('EXAMPLE_CODE')) => ({ path, content });
const build = files => buildIntegrity({ frameworkVersion: '0.1.6', files });

test('release manifest deterministically covers every explicit ordinary archive input except itself', () => {
  const files = ['server/main.js', 'server/vendor/ssh2.cjs', 'server/builtins/rivetin-ssh-channel.json', 'shared/framework-compatibility.js', 'deploy/rivetin.yaml', 'deploy/install.sh', 'cli.mjs', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'].map(name => row(name));
  const before = files.map(file => ({ path: file.path, data: file.content.toString() }));
  const manifest = build(files);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.frameworkVersion, '0.1.6');
  assert.deepEqual(manifest, build([...files].reverse())); assert.deepEqual(manifest.files.map(file => file.path), files.map(file => file.path).sort());
  for (const file of manifest.files) { assert.equal(file.bytes, 12); assert.equal(file.sha256, createHash('sha256').update('EXAMPLE_CODE').digest('hex')); }
  assert.equal(manifest.files.some(file => file.path === 'integrity.json'), false);
  assert.deepEqual(files.map(file => ({ path: file.path, data: file.content.toString() })), before);
  assert.equal(JSON.stringify(manifest).includes('EXAMPLE_CODE'), false);
});

test('release manifest rejects private paths, arbitrary metadata, aliases and duplicate paths', () => {
  for (const file of ['../private', '/etc/secret', 'C:/private', 'server\\main.js', 'server/../main.js', 'integrity.json', '.local/settings.json', 'docs/private.md', 'server/con.js']) assert.throws(() => build([row(file)]), /INTEGRITY_INPUT_INVALID/);
  assert.throws(() => build([row(), row('SERVER/main.js')]), /INTEGRITY_INPUT_INVALID/);
  assert.throws(() => build([{ ...row(), settings: {} }]), /INTEGRITY_INPUT_INVALID/);
  assert.throws(() => build([{ path: 'server/main.js', content: 'not bytes' }]), /INTEGRITY_INPUT_INVALID/);
});

test('release manifest enforces version, entry count and byte budgets before hashing', () => {
  for (const frameworkVersion of ['unknown', '0.1.0-rc', '01.1.0', '0.1.0\n', null]) assert.throws(() => buildIntegrity({ frameworkVersion, files: [row()] }), /INTEGRITY_VERSION_INVALID/);
  assert.throws(() => build([]), /INTEGRITY_FILE_LIMIT/);
  assert.throws(() => build(Array.from({ length: 201 }, (_, index) => row(`server/example-${index}.js`))), /INTEGRITY_FILE_LIMIT/);
  assert.throws(() => build([row('server/main.js', Buffer.alloc(16 * 1024 * 1024 + 1))]), /INTEGRITY_BYTE_LIMIT/);
  const bytes = Buffer.alloc(12 * 1024 * 1024);
  assert.throws(() => build([row('server/one.js', bytes), row('server/two.js', bytes), row('server/three.js', bytes)]), /INTEGRITY_BYTE_LIMIT/);
});
