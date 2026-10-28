import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveToolchain, cliRoot } from '../toolchain.mjs';

const repo = path.resolve(cliRoot, '..');
const runtime = path.join(repo, '.local', 'migration-20261028', 'cli-script-tests');
async function fixture(run) {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(path.join(runtime, 'toolchain-'));
  assert.equal(path.dirname(root), runtime);
  try { return await run(root); } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(runtime));
    await rm(root, { recursive: true });
  }
}
async function file(root, name, data = '') {
  const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data); return target;
}

test('project-local compiler and caches resolve from the script checkout, ignoring former process paths', () => fixture(async root => {
  const cli = path.join(root, 'cli'); const expected = await file(root, '.local/toolchains/go/bin/go.exe');
  const stale = path.join(root, 'EXAMPLE_FORMER_WORKSPACE');
  const inherited = { GOPATH: stale, GOMODCACHE: stale, GOCACHE: stale, GOTMPDIR: stale, GOROOT: stale, GOENV: stale, GOWORK: stale, GOTOOLCHAIN: 'auto', RIVETIN_GO: stale, GO_BIN: stale, goRoot: stale, EXAMPLE_UNRELATED: 'preserved' };
  const result = resolveToolchain({ cli, platform: 'win32', env: inherited });
  assert.equal(result.go, expected); assert.equal(result.source, 'project-local');
  assert.equal(result.env.GOPATH, path.join(cli, '.local', 'go-cache'));
  assert.equal(result.env.GOMODCACHE, path.join(cli, '.local', 'go-cache', 'pkg', 'mod'));
  assert.equal(result.env.GOCACHE, path.join(cli, '.local', 'go-build'));
  assert.equal(result.env.GOTMPDIR, path.join(cli, '.runtime', 'go-tmp'));
  assert.equal(result.env.GOENV, 'off'); assert.equal(result.env.GOWORK, 'off'); assert.equal(result.env.GOTOOLCHAIN, 'local'); assert.equal(result.env.CGO_ENABLED, '0');
  assert.equal(result.env.EXAMPLE_UNRELATED, 'preserved'); assert.equal(result.env.GOROOT, undefined); assert.equal(result.env.goRoot, undefined); assert.equal(result.env.RIVETIN_GO, undefined); assert.equal(result.env.GO_BIN, undefined);
  assert.equal(inherited.GOPATH, stale); assert.equal(inherited.GOROOT, stale);
}));

test('missing project compiler fails even when a different Go is offered through environment or PATH', () => fixture(async root => {
  assert.throws(() => resolveToolchain({ cli: path.join(root, 'cli'), platform: 'win32', env: { PATH: process.env.PATH, RIVETIN_GO: process.execPath, GO_BIN: process.execPath } }), /Project-local Go toolchain is missing/);
}));

test('Unix compiler discovery and explicit external selection remain deliberate', () => fixture(async root => {
  const cli = path.join(root, 'cli'); const local = await file(root, '.local/toolchains/go/bin/go');
  assert.equal(resolveToolchain({ cli, platform: 'linux', env: {} }).go, local);
  assert.equal(resolveToolchain({ cli, platform: 'darwin', env: {} }).go, local);
  const explicit = resolveToolchain({ cli, explicit: process.execPath, platform: 'win32', env: {} });
  assert.equal(explicit.go, process.execPath); assert.equal(explicit.source, 'explicit'); assert.equal(explicit.env.GOCACHE, path.join(cli, '.local', 'go-build'));
  assert.throws(() => resolveToolchain({ cli, explicit: '  ' }), /Provide the Go executable/);
}));

test('prepare without --go uses its own checkout compiler/cache and writes only isolated fixture payload', () => fixture(async root => {
  const cli = path.join(root, 'cli'); const goName = process.platform === 'win32' ? 'go.exe' : 'go';
  const goRoot = path.join(root, '.local', 'toolchains', 'go'); const fakeGo = await file(root, `.local/toolchains/go/bin/${goName}`, 'EXAMPLE_NOT_EXECUTED');
  const cache = path.join(cli, '.local', 'go-cache', 'pkg', 'mod');
  for (const name of ['LICENSE', 'PATENTS']) {
    await file(root, `.local/toolchains/go/${name}`, `EXAMPLE Go ${name}`);
    for (const [module, version] of [['crypto', 'v0.58.0'], ['term', 'v0.47.0'], ['sys', 'v0.49.0']]) await file(root, `cli/.local/go-cache/pkg/mod/golang.org/x/${module}@${version}/${name}`, `EXAMPLE ${module} ${name}`);
  }
  await file(root, '.local/toolchains/go/src/vendor/modules.txt', '');
  await file(root, 'cli/go.mod', 'module example.invalid/cli\ngo 1.27.0\nrequire (\n golang.org/x/crypto v0.58.0\n golang.org/x/term v0.47.0\n golang.org/x/sys v0.49.0\n)\n');
  await file(root, 'framework/package.json', '{"version":"0.0.0"}');
  await file(root, 'framework/release/rivetin-0.0.0-service.tar.gz', 'EXAMPLE_SERVICE');
  await file(root, 'framework/release/rivetin-0.0.0-island.tar.gz', 'EXAMPLE_ISLAND');
  await file(root, 'framework/dist/production/build/remoteEntry.js', 'EXAMPLE_ENTRY');
  await file(root, 'framework/THIRD_PARTY_NOTICES.txt', 'EXAMPLE_FRAMEWORK_NOTICES'); await file(root, 'LICENSE', 'EXAMPLE_PROJECT_LICENSE');
  await mkdir(path.join(cli, 'scripts'), { recursive: true });
  for (const name of ['prepare.mjs', 'toolchain.mjs']) await copyFile(path.join(cliRoot, 'scripts', name), path.join(cli, 'scripts', name));
  const record = path.join(root, 'selected.json');
  const hook = await file(root, 'mock-go-env.mjs', `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {writeFileSync} from 'node:fs';
cp.execFileSync=(go,args,options)=>{ if(go!==${JSON.stringify(fakeGo)})throw new Error('UNEXPECTED_COMPILER'); if(JSON.stringify(args)===JSON.stringify(['mod','download'])||JSON.stringify(args)===JSON.stringify(['mod','verify']))return ''; if(JSON.stringify(args)!==JSON.stringify(['env','-json','GOROOT','GOMODCACHE','GOVERSION']))throw new Error('UNEXPECTED_GO_COMMAND'); writeFileSync(${JSON.stringify(record)},JSON.stringify({go,GOMODCACHE:options.env.GOMODCACHE,GOCACHE:options.env.GOCACHE,GOROOT:options.env.GOROOT,GOENV:options.env.GOENV})); return JSON.stringify({GOROOT:${JSON.stringify(goRoot)},GOMODCACHE:options.env.GOMODCACHE,GOVERSION:'go1.27.3'});};syncBuiltinESMExports();`);
  const output = execFileSync(process.execPath, ['--import', pathToFileURL(hook).href, path.join(cli, 'scripts', 'prepare.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, GOMODCACHE: path.join(root, 'EXAMPLE_OLD_CACHE'), GOROOT: path.join(root, 'EXAMPLE_OLD_TOOLCHAIN'), RIVETIN_GO: 'EXAMPLE_OLD_GO' } });
  assert.match(output, /Prepared explicit framework release inputs/);
  const selected = JSON.parse(await readFile(record, 'utf8')); assert.equal(selected.go, fakeGo); assert.equal(selected.GOMODCACHE, cache); assert.equal(selected.GOENV, 'off'); assert.equal(selected.GOROOT, undefined);
  const bundle = JSON.parse(await readFile(path.join(cli, 'payload', 'bundle.json'), 'utf8')); assert.equal(bundle.version, '0.0.0'); assert.equal(Object.keys(bundle.files).length, 3);
  assert.match(await readFile(path.join(cli, 'payload', 'NOTICES.txt'), 'utf8'), /EXAMPLE Go LICENSE/);
}));

test('build entry points reuse the resolver and have no mandatory compiler or inherited-cache fallback', async () => {
  const powershell = await readFile(path.join(cliRoot, 'scripts', 'build.ps1'), 'utf8');
  const shell = await readFile(path.join(cliRoot, 'scripts', 'build.sh'), 'utf8');
  assert.match(powershell, /^param\(\[string\]\$Go\)/); assert.doesNotMatch(powershell, /Mandatory|if \(-not \$env:GOPATH\)/);
  for (const source of [powershell, shell]) { assert.match(source, /toolchain\.mjs.*--run-go mod download/); assert.match(source, /toolchain\.mjs.*--run-go build/); }
  assert.doesNotMatch(shell, /GO_BIN:-go|GOPATH:-|GOCACHE:-/);
});
