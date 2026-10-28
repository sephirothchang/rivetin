import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveToolchain({ cli = cliRoot, explicit, env = process.env, platform = process.platform } = {}) {
  cli = path.resolve(cli);
  const local = path.join(path.resolve(cli, '..'), '.local', 'toolchains', 'go', 'bin', platform === 'win32' ? 'go.exe' : 'go');
  let go = explicit;
  if (go !== undefined && (typeof go !== 'string' || !go.trim())) throw new Error('Provide the Go executable after --go.');
  if (!go) {
    let available = false;
    try { available = statSync(local).isFile(); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (!available) throw new Error('Project-local Go toolchain is missing. Place a complete toolchain in .local/toolchains/go, or explicitly select another compiler with --go <GO_EXECUTABLE>.');
    go = local;
  }
  const caches = {
    GOPATH: path.join(cli, '.local', 'go-cache'),
    GOMODCACHE: path.join(cli, '.local', 'go-cache', 'pkg', 'mod'),
    GOCACHE: path.join(cli, '.local', 'go-build'),
    GOTMPDIR: path.join(cli, '.runtime', 'go-tmp'),
  };
  const inherited = { ...env };
  for (const name of Object.keys(inherited)) if (['GOROOT', 'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOTMPDIR', 'GOENV', 'GOWORK', 'GOTOOLCHAIN', 'GOFLAGS', 'GOEXPERIMENT', 'CGO_ENABLED', 'RIVETIN_GO', 'GO_BIN'].includes(name.toUpperCase())) delete inherited[name];
  const childEnv = { ...inherited, ...caches, GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '', GOEXPERIMENT: '', CGO_ENABLED: '0' };
  // A relocated compiler derives GOROOT from its own location, never a former workspace.
  return { go, source: explicit === undefined ? 'project-local' : 'explicit', caches, env: childEnv };
}

export function createCacheDirectories(toolchain) {
  for (const directory of Object.values(toolchain.caches)) mkdirSync(directory, { recursive: true });
}

function main(args) {
  let explicit, json = false, command;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--go') {
      if (explicit !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Provide one Go executable after --go.');
      explicit = args[++index];
    } else if (args[index] === '--json') json = true;
    else if (args[index] === '--run-go') { command = args.slice(index + 1); break; }
    else throw new Error('Unknown toolchain option.');
  }
  if (json === Boolean(command?.length)) throw new Error('Choose --json or --run-go <GO_ARGUMENTS>.');
  const toolchain = resolveToolchain({ explicit });
  if (json) {
    console.log(JSON.stringify({ go: toolchain.go, source: toolchain.source, ...toolchain.caches, GOENV: toolchain.env.GOENV, GOWORK: toolchain.env.GOWORK, GOTOOLCHAIN: toolchain.env.GOTOOLCHAIN }));
    return;
  }
  createCacheDirectories(toolchain);
  const result = spawnSync(toolchain.go, command, { cwd: cliRoot, env: toolchain.env, stdio: 'inherit', timeout: 20 * 60 * 1000 });
  if (result.error) throw new Error('Go command could not complete.', { cause: result.error });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
