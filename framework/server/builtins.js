import { readFile } from 'node:fs/promises';

export async function builtinPackages({ required = false } = {}) {
  try { return [await readFile(new URL('./builtins/rivetin-ssh-channel.json', import.meta.url))]; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('BUILTIN_PACKAGE_UNAVAILABLE'); }
  if (required) throw new Error('BUILTIN_PACKAGE_UNAVAILABLE');
  return [];
}
