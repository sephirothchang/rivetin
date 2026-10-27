import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';

// Release only modules reachable from the service and local CLI entry points.
export async function runtimeFiles(root, entries = ['server/main.js', 'cli.mjs']) {
  const seen = new Set(), pending = [...entries];
  while (pending.length) {
    const relative = pending.pop(), absolute = path.resolve(root, relative), normalized = path.relative(root, absolute);
    if (path.isAbsolute(normalized) || normalized.startsWith('..' + path.sep) || !/^(?:server\/|shared\/|cli\.mjs$)/.test(normalized.replaceAll(path.sep, '/'))) throw new Error('RUNTIME_MODULE_OUTSIDE_RELEASE');
    const name = normalized.replaceAll(path.sep, '/');
    if (seen.has(name)) continue;
    if (!/\.(?:js|mjs)$/.test(name) || !(await lstat(absolute)).isFile()) throw new Error('RUNTIME_MODULE_INVALID');
    seen.add(name);
    const source = await readFile(absolute, 'utf8');
    const imports = source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of imports) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith('.')) pending.push(path.relative(root, path.resolve(path.dirname(absolute), specifier)));
    }
  }
  return [...seen].sort();
}
