import { mkdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const idPattern = /^pluginkit-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const validId = id => typeof id === 'string' && id.length <= 100 && idPattern.test(id);
export async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw new Error('DATA_UNAVAILABLE'); }
}
export async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function storage(directory) {
  const root = path.resolve(directory);
  return {
    root,
    plugin(id, file = 'config.json') {
      if (!validId(id) || !['config.json', 'state.json'].includes(file)) throw new Error('INVALID_PLUGIN_ID');
      return path.join(root, 'plugins', id, file);
    },
    async locked(task) {
      await mkdir(root, { recursive: true });
      const file = path.join(root, '.write.lock');
      let handle;
      const deadline = Date.now() + 5000;
      while (!handle) {
        try { handle = await open(file, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (Date.now() >= deadline) throw new Error('STORE_BUSY');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await task(); }
      finally { await handle.close(); await unlink(file); }
    },
  };
}
