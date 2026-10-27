import { readFile, mkdir, open, rename, unlink, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateFunctionalSettings } from '../src/configuration.js';
import { PLUGIN_ID } from '../src/identity.js';
// Legacy prototype repository retained for migration regression tests. Runtime storage is in framework/server.

// Plugins register independent schemas while sharing one API and repository.
export function createFileConfigurationRepository(file, validators = { [PLUGIN_ID]: validateFunctionalSettings }) {
  let queue = Promise.resolve();
  const serialized = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  function validate(pluginId, settings) {
    if (typeof pluginId !== 'string' || !/^pluginkit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId) || !Object.hasOwn(validators, pluginId)) throw new Error('UNKNOWN_PLUGIN');
    return validators[pluginId](settings);
  }
  async function read() {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.settings && !value.plugins) {
        if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== 'string') throw new Error();
        return { document: { version: 1, revision: value.revision, plugins: {
          [PLUGIN_ID]: { revision: value.revision, updatedAt: value.updatedAt, settings: validate(PLUGIN_ID, value.settings) },
        } }, legacy: true };
      }
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.plugins || typeof value.plugins !== 'object' || Array.isArray(value.plugins)) throw new Error();
      for (const [id, config] of Object.entries(value.plugins)) {
        if (!/^pluginkit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !Number.isSafeInteger(config.revision) ||
          config.revision < 1 || typeof config.updatedAt !== 'string') throw new Error();
        if (Object.hasOwn(validators, id)) validate(id, config.settings);
      }
      return { document: value, legacy: false };
    } catch (error) {
      if (error.code === 'ENOENT') return { document: { version: 1, revision: 0, plugins: {} }, legacy: false };
      throw new Error('CONFIGURATION_READ_FAILED');
    }
  }
  return {
    validate,
    load: () => serialized(async () => (await read()).document),
    save: (pluginId, settings) => serialized(async () => {
      const clean = validate(pluginId, settings), previous = await read();
      const current = previous.document.plugins[pluginId];
      const next = { ...previous.document, revision: previous.document.revision + 1, plugins: {
        ...previous.document.plugins,
        [pluginId]: { revision: (current?.revision || 0) + 1, updatedAt: new Date().toISOString(), settings: clean },
      } };
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        if (previous.legacy) await copyFile(file, file + '.legacy-v1.backup', constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } catch {
        await unlink(temporary).catch(() => {}); throw new Error('CONFIGURATION_SAVE_FAILED');
      }
      return next;
    }),
  };
}

export function createDemoConfigurationHandler(repository) {
  const origins = new Set(['http://127.0.0.1:43170', 'http://localhost:43170']);
  function send(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  return async (req, res) => {
    try {
      if (req.method === 'GET') return send(res, 200, await repository.load());
      if (req.method !== 'PUT') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (!origins.has(req.headers.origin) || !req.headers['content-type']?.startsWith('application/json')) return send(res, 403, { error: 'ORIGIN_REQUIRED' });
      let bytes = 0, value;
      const chunks = [];
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 1048576) return send(res, 413, { error: 'CONFIGURATION_TOO_LARGE' }); chunks.push(chunk); }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'pluginId') || !Object.hasOwn(value, 'settings')) throw new Error();
        repository.validate(value.pluginId, value.settings);
      } catch { return send(res, 400, { error: 'INVALID_SETTINGS' }); }
      return send(res, 200, await repository.save(value.pluginId, value.settings));
    } catch { return send(res, 503, { error: 'CONFIGURATION_UNAVAILABLE' }); }
  };
}
