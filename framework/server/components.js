import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createComponentInspector } from './component-status.js';
import { createSupportBundle } from './support-bundle.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const admin = actor => { if (actor?.admin !== true) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 }); };

// Read the fixed local journal only; never follow an event-controlled delivery path.
async function supportLogs(root) {
  const absolute = path.resolve(root), file = path.join(absolute, 'audit.jsonl');
  if (await realpath(absolute) !== absolute || (await lstat(absolute)).isSymbolicLink()) throw new Error('SUPPORT_STORAGE_UNSAFE');
  let handle;
  try {
    if ((await lstat(file)).isSymbolicLink() || await realpath(file) !== file) throw new Error('SUPPORT_STORAGE_UNSAFE');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await handle.stat(); if (!info.isFile()) throw new Error('SUPPORT_STORAGE_UNSAFE');
    const size = Math.min(info.size, 1024 * 1024), bytes = Buffer.alloc(size);
    const { bytesRead } = await handle.read(bytes, 0, size, info.size - size);
    const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n'); if (info.size > size) lines.shift();
    return lines.filter(Boolean).slice(-1000).map(line => {
      let item; try { item = JSON.parse(line); } catch { throw new Error('SUPPORT_JOURNAL_INVALID'); }
      if (!uuid.test(item?.id) || typeof item.actor?.id !== 'string' || item.actor.id.length > 128) throw new Error('SUPPORT_JOURNAL_INVALID');
      return item;
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { await handle?.close(); }
}

export function createComponents({ service, dataDirectory, codeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), readIsland, readGateway, probeReply, maintenance } = {}) {
  const readRuntime = () => service.runtime();
  const readPlugins = ({ actor } = {}) => service.plugins(actor);
  const readConfig = () => service.loadConfig();
  const inspector = createComponentInspector({
    dataDirectory, codeDirectory, version: FRAMEWORK_VERSION, readRuntime, readPlugins, readConfig,
    readCompatibility: ({ actor }) => service.compatibilityStatus(actor),
    readUpdates: ({ actor }) => service.updateStatus(actor), readIsland, readGateway,
    maintenanceActions: { repair: Boolean(maintenance), reset: Boolean(maintenance) },
    apiRegistry: [
      { id: 'api-runtime', registered: true, probe: async () => typeof (await readRuntime()).enabled === 'boolean' },
      { id: 'api-plugins', registered: true, probe: async () => Array.isArray(await readPlugins()) },
      { id: 'api-config', registered: true, probe: async () => (await readConfig()).version === 1 },
      { id: 'api-components', registered: true, probe: readGateway },
      { id: 'api-support', registered: true, probe: async () => createSupportBundle({ runtime: await readRuntime(), components: [], plugins: [], logs: [] }).bytes > 0 },
      ...['api-ssh', 'api-resources'].map(id => ({ id, registered: true })),
      { id: 'api-market', registered: true, probe: async ({ actor }) => {
        const result = await service.marketplace(actor);
        return result?.source?.reachable === true && Array.isArray(result.items) && result.items.length <= 500;
      } },
    ],
  });
  function view(status) {
    const labels = { readable: ['可读取', 'Readable'], writable: ['可写入', 'Writable'], files: ['文件数', 'Files'], bytes: ['字节数', 'Bytes'], packages: ['插件包数', 'Packages'] };
    return { ...status, components: status.components.map(row => {
      const checks = [];
      for (const [key, label] of Object.entries(labels)) {
        const value = row.checks?.[key];
        if (typeof value === 'boolean') checks.push({ id: key, label: { 'zh-CN': label[0], 'en-US': label[1] }, status: value ? 'ok' : 'failed' });
        else if (Number.isSafeInteger(value) && value >= 0) checks.push({ id: key, label: { 'zh-CN': `${label[0]}：${value}`, 'en-US': `${label[1]}: ${value}` }, status: row.status });
      }
      return { ...row, checks };
    }) };
  }
  let exporting = false;
  return {
    probe(actor, challenge) {
      admin(actor);
      if (typeof probeReply !== 'function') throw Object.assign(new Error('COMPONENT_PROBE_UNAVAILABLE'), { status: 503 });
      return probeReply(challenge);
    },
    async status(actor, { fresh = false } = {}) { admin(actor); return view(await inspector.inspect({ actor, fresh })); },
    async support(actor) {
      admin(actor);
      if (exporting) throw Object.assign(new Error('SUPPORT_BUSY'), { status: 429 });
      exporting = true;
      try {
        const [runtime, status, plugins, config, logs] = await Promise.all([readRuntime(), inspector.inspect({ actor }), readPlugins({ actor }), readConfig(), supportLogs(dataDirectory)]);
        return createSupportBundle({ runtime: { ...runtime, compatibility: status.framework.compatibility }, components: status.components, plugins: plugins.map(item => ({ ...item, configSummary: config.plugins[item.id] && { revision: config.plugins[item.id].revision, schemaVersion: config.plugins[item.id].schemaVersion } })), logs });
      } finally { exporting = false; }
    },
    maintain(action, input, actor) {
      admin(actor);
      if (!maintenance) throw Object.assign(new Error('MAINTENANCE_UNAVAILABLE'), { status: 503 });
      return maintenance.run(action, input, actor);
    },
  };
}
