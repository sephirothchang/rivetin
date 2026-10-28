import path from 'node:path';
import { readFile, lstat, realpath } from 'node:fs/promises';

// Release only modules reachable from the service and local CLI entry points.
export async function runtimeFiles(root, entries = ['server/main.js', 'cli.mjs']) {
  root = path.resolve(root);
  if (!Array.isArray(entries) || !entries.length || entries.length > 200) throw new Error('RUNTIME_MODULE_LIMIT');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new Error('RUNTIME_MODULE_INVALID');
  const seen = new Set(), pending = [...entries];
  let total = 0;
  while (pending.length) {
    const relative = pending.pop(), absolute = path.resolve(root, relative), normalized = path.relative(root, absolute);
    if (path.isAbsolute(normalized) || normalized.startsWith('..' + path.sep) || !/^(?:server\/|shared\/|cli\.mjs$)/.test(normalized.replaceAll(path.sep, '/'))) throw new Error('RUNTIME_MODULE_OUTSIDE_RELEASE');
    const name = normalized.replaceAll(path.sep, '/');
    if (seen.has(name)) continue;
    if (seen.size >= 200) throw new Error('RUNTIME_MODULE_LIMIT');
    let parent = root;
    for (const part of name.split('/')) { parent = path.join(parent, part); const info = await lstat(parent); if (info.isSymbolicLink() || parent !== absolute && !info.isDirectory()) throw new Error('RUNTIME_MODULE_INVALID'); }
    const info = await lstat(absolute);
    if (!/\.(?:js|mjs)$/.test(name) || !info.isFile() || await realpath(absolute) !== absolute) throw new Error('RUNTIME_MODULE_INVALID');
    if (info.size > 16 * 1024 * 1024 || (total += info.size) > 32 * 1024 * 1024) throw new Error('RUNTIME_MODULE_LIMIT');
    seen.add(name);
    const source = await readFile(absolute, 'utf8');
    const imports = source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith('.')) pending.push(path.relative(root, path.resolve(path.dirname(absolute), specifier)));
    }
  }
  return [...seen].sort();
}
