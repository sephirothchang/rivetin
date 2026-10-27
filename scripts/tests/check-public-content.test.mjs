import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, unlink, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scanner = fileURLToPath(new URL('../check-public-content.mjs', import.meta.url));
const scratch = fileURLToPath(new URL('../../.local/public-content-tests/', import.meta.url));

async function repository(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(scratch));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  // Isolate temporary Git commands from inherited repository and user settings.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = path.join(root, 'absent-global-config');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  return {
    root, git,
    async file(name, content = 'EXAMPLE_PUBLIC_TEXT\n') {
      const absolute = path.resolve(root, name);
      assert.ok(absolute.startsWith(root + path.sep));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    },
    scan() {
      const result = spawnSync(process.execPath, [scanner], { cwd: root, env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error;
      return result;
    },
  };
}

test('ordinary tracked and untracked public sources pass without overmatching build filenames', async t => {
  const repo = await repository(t);
  await repo.file('README.md'); await repo.file('src/build.js'); await repo.file('scripts/build.mjs');
  await repo.file('docs/building.md'); await repo.file('config/AGENTS.md.example');
  repo.git('add', '--', 'README.md');
  const result = repo.scan();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /5 files, 0 findings/);
});

test('force-added local instructions and generated directories fail even with harmless bodies', async t => {
  const repo = await repository(t);
  const instructions = ['AGENTS.md', 'nested/AGENTS.md', 'lower/agents.md', 'docs/local-collaboration/notes.md', 'nested/local-collaboration/notes.md'];
  const generated = ['dist/main.js', 'nested/dist/main.js', '.packaging/service.json', 'nested/.packaging/service.json', 'build/bundle.js', 'nested/build/bundle.js',
    '.local/output.json', '.runtime/output.json', 'node_modules/example/index.js', 'qa/report.json', 'payload/bundle.json', 'release/output.json'];
  await repo.file('.gitignore', 'AGENTS.md\nagents.md\n**/local-collaboration/\n**/dist/\n**/.packaging/\n**/build/\n**/.local/\n**/.runtime/\n**/node_modules/\n**/qa/\n**/payload/\n**/release/\n');
  for (const name of [...instructions, ...generated]) await repo.file(name, 'EXAMPLE_HARMLESS_BODY_MUST_NOT_BE_PRINTED\n');
  repo.git('add', '--force', '--', ...instructions, ...generated);
  const result = repo.scan();
  assert.equal(result.status, 1);
  for (const name of instructions) assert.ok(result.stderr.includes(`${name}: local-instructions`), name);
  for (const name of generated) assert.ok(result.stderr.includes(`${name}: runtime-artifact`), name);
  assert.ok(!result.stderr.includes('EXAMPLE_HARMLESS_BODY_MUST_NOT_BE_PRINTED'));
  assert.match(result.stdout, /17 findings/);
});

test('forbidden indexed paths are rejected without reading a missing working-tree body', async t => {
  const repo = await repository(t);
  await repo.file('nested/AGENTS.md'); repo.git('add', '--force', '--', 'nested/AGENTS.md');
  await unlink(path.join(repo.root, 'nested', 'AGENTS.md'));
  const result = repo.scan();
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'nested/AGENTS.md: local-instructions');
});

test('ignored local material stays outside the scan unless explicitly force-added', async t => {
  const repo = await repository(t);
  await repo.file('.gitignore', '.local/\nqa/\ndocs/local-collaboration/\nAGENTS.md\n');
  await repo.file('README.md');
  for (const name of ['.local/private.json', 'qa/report.txt', 'docs/local-collaboration/prompt.md', 'AGENTS.md']) await repo.file(name, 'EXAMPLE_LOCAL_ONLY\n');
  const result = repo.scan();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); assert.match(result.stdout, /2 files, 0 findings/);
});

test('sensitive body patterns report only file, line and category, never matching values', async t => {
  const repo = await repository(t);
  // Synthetic strings are assembled to exercise detection without embedding a credential-shaped source literal.
  const privateAddress = [10, 23, 45, 67].join('.');
  const credential = 'github_' + 'pat_' + 'X'.repeat(45);
  const personalPath = ['C:', 'Users', 'EXAMPLE_ONLY', 'private.txt'].join('\\');
  await repo.file('example.txt', `${privateAddress}\n${credential}\n${personalPath}\n`);
  const result = repo.scan();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /example\.txt:1: private-endpoint/);
  assert.match(result.stderr, /example\.txt:2: credential/);
  assert.match(result.stderr, /example\.txt:3: personal-path/);
  for (const value of [privateAddress, credential, personalPath]) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
  assert.match(result.stdout, /1 files, 3 findings/);
});
