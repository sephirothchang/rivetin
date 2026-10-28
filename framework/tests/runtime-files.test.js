import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { runtimeFiles } from '../scripts/runtime-files.mjs';

async function fixture(t) {
  const qa = path.resolve('qa'); await mkdir(qa, { recursive: true });
  const root = await mkdtemp(path.join(qa, 'runtime-files-'));
  t.after(async () => { if (!root.startsWith(qa + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  for (const name of ['server', 'shared']) await mkdir(path.join(root, name));
  const write = (name, text) => writeFile(path.join(root, name), text);
  return { root, write };
}

test('release follows entry dependencies and excludes unrelated in-progress modules', async t => {
  const { root, write } = await fixture(t);
  await write('server/main.js', "import { service } from './service.js';");
  await write('server/service.js', "import { id } from '../shared/identity.js'; export const service = id;");
  await write('shared/identity.js', 'export const id = 1;');
  await write('cli.mjs', "const service = await import('./server/service.js');");
  await write('server/draft.js', "import { unfinished } from './missing.js';");
  assert.deepEqual(await runtimeFiles(root), ['cli.mjs', 'server/main.js', 'server/service.js', 'shared/identity.js']);
});

test('release rejects modules outside the declared server/shared source scope', async t => {
  const { root, write } = await fixture(t);
  await write('server/main.js', "import { value } from '../private.js';");
  await write('private.js', 'export const value = 1;'); await write('cli.mjs', '');
  await assert.rejects(runtimeFiles(root), /RUNTIME_MODULE_OUTSIDE_RELEASE/);
});

test('current runtime graph includes shared identity, SMART storage and resource operation services', async () => {
  const files = await runtimeFiles(path.resolve('.'));
  assert.ok(files.includes('shared/identity.js')); assert.ok(files.includes('shared/version.js'));
  assert.ok(files.includes('server/ssh-broker.js')); assert.ok(files.includes('server/ssh-preflight.js'));
  for (const name of ['smart-data', 'smart-history', 'smart-provider', 'smart-collection', 'tower-disks', 'resource-actions']) assert.ok(files.includes(`server/${name}.js`), name);
  assert.ok(files.includes('shared/framework-compatibility.js'));
  for (const name of ['compatibility', 'tower-products', 'component-status', 'component-maintenance', 'support-bundle']) assert.ok(files.includes(`server/${name}.js`), name);
  assert.equal(files.some(file => file.includes('resource-vm-actions')), false);
});

test('release follows side-effect imports and transitive shared declarations without unrelated drafts', async t => {
  const { root, write } = await fixture(t);
  await write('server/main.js', "import './components.js';"); await write('server/components.js', "export { metadata } from '../shared/framework-compatibility.js';");
  await write('shared/framework-compatibility.js', "import { version } from './version.js'; export const metadata = { version };");
  await write('shared/version.js', "export const version = '0.1.0';"); await write('cli.mjs', '');
  await write('server/resource-vm-actions.js', 'EXAMPLE_UNREVIEWED_DRAFT');
  assert.deepEqual(await runtimeFiles(root), ['cli.mjs', 'server/components.js', 'server/main.js', 'shared/framework-compatibility.js', 'shared/version.js']);
});

test('release rejects ancestor junctions and limits the reachable module set', async t => {
  const { root, write } = await fixture(t);
  const target = path.join(root, 'outside'); await mkdir(target); await writeFile(path.join(target, 'example.js'), 'EXAMPLE_OUTSIDE');
  await symlink(target, path.join(root, 'server/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await write('server/main.js', "import './linked/example.js';"); await write('cli.mjs', '');
  await assert.rejects(runtimeFiles(root), /RUNTIME_MODULE_INVALID/);
  for (let index = 0; index < 201; index++) await write(`server/example-${index}.js`, index < 200 ? `import './example-${index + 1}.js';` : '');
  await write('server/main.js', "import './example-0.js';");
  await assert.rejects(runtimeFiles(root), /RUNTIME_MODULE_LIMIT/);
});
