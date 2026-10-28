import { mkdir, readFile, open, rename, unlink, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { idPattern, validId, assertId } from '../shared/identity.js';

export { idPattern, validId, assertId };
export async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw new Error('DATA_UNAVAILABLE'); }
}
export async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    const deadline = Date.now() + 1500;
    for (;;) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
        // Preserve the destination while Windows releases transient reader handles.
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (process.platform !== 'win32') {
      const parent = await open(path.dirname(file), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// Classify only observed lock-open failures; a missing Windows lock is transient,
// not permission to wait through a persistent access failure.
export function lockRetryDecision(error, { platform, info, statError, now, missing = null }) {
  if (error.code === 'EEXIST') return { retry: true, missing: null };
  if (platform !== 'win32' || error.code !== 'EPERM') return { retry: false, missing: null };
  if (!statError) return { retry: Boolean(info?.isFile() && !info.isSymbolicLink()), missing: null };
  if (statError.code !== 'ENOENT') return { retry: false, missing: null };
  const transient = missing || { expiresAt: now + 180, error };
  return now < transient.expiresAt ? { retry: true, missing: transient } : { retry: false, missing: transient, error: transient.error };
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
      let handle, missing = null;
      const deadline = Date.now() + 5000;
      while (!handle) {
        try { handle = await open(file, 'wx', 0o600); }
        catch (error) {
          let info, statError;
          if (process.platform === 'win32' && error.code === 'EPERM') {
            try { info = await lstat(file); } catch (failure) { statError = failure; }
          }
          const decision = lockRetryDecision(error, { platform: process.platform, info, statError, now: Date.now(), missing });
          missing = decision.missing;
          if (!decision.retry) throw decision.error || error;
          if (Date.now() >= deadline) throw missing?.error || new Error('STORE_BUSY');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await task(); }
      finally { await handle.close(); await unlink(file); }
    },
  };
}
