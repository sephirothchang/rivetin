import { readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { storage, atomic, json, exists, validId } from './storage.js';
import { validatePackage, validateSettings, FRAMEWORK_VERSION } from './manifest.js';
import { auditStore } from './audit.js';
import { newer } from './updates.js';

const missing = { installed: false, enabled: false, version: null, packageId: null, previous: null };
export function createService(directory, { towerSink, updateSource } = {}) {
  const disk = storage(directory), runtimeDisk = storage(path.join(disk.root, 'framework'));
  const frameworkFile = path.join(disk.root, 'framework', 'settings.json'), disabledFile = path.join(disk.root, 'framework', 'disabled.json');
  const audit = auditStore(disk.root, towerSink);
  const actorCheck = actor => { if (!actor || !['cli', 'demo', 'tower'].includes(actor.source) || typeof actor.id !== 'string' || actor.id.length > 128 || typeof actor.name !== 'string' || actor.name.length > 128) throw new Error('ACTOR_REQUIRED'); };
  async function checkedId(id) { if (!validId(id)) throw new Error('INVALID_PLUGIN_ID'); return id; }
  async function getPackage(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('INVALID_PACKAGE_ID');
    const bytes = await readFile(path.join(disk.root, 'packages', `${digest}.json`));
    const pkg = validatePackage(bytes); if (pkg.digest !== digest) throw new Error('PACKAGE_INTEGRITY_FAILED'); return pkg;
  }
  async function state(id) {
    await checkedId(id); const value = await json(disk.plugin(id, 'state.json'), missing);
    if (typeof value.installed !== 'boolean' || typeof value.enabled !== 'boolean') throw new Error('PLUGIN_STATE_INVALID');
    return value;
  }
  async function entry(id) {
    const item = await state(id); if (!item.installed) throw new Error('PLUGIN_NOT_INSTALLED');
    const pkg = await getPackage(item.packageId); if (pkg.manifest.id !== id || pkg.manifest.version !== item.version) throw new Error('PLUGIN_STATE_INVALID');
    return { item, pkg };
  }
  async function pluginIds() {
    try { return (await readdir(path.join(disk.root, 'plugins'), { withFileTypes: true })).filter(value => value.isDirectory() && validId(value.name)).map(value => value.name).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function config(id, manifest) {
    const value = await json(disk.plugin(id), { revision: 0, updatedAt: null, schemaVersion: manifest.configuration.version, settings: manifest.configuration.defaults });
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.schemaVersion !== manifest.configuration.version) throw new Error('CONFIGURATION_INVALID');
    validateSettings(value.settings, manifest.configuration.schema); return value;
  }
  async function recorded(actor, action, id, task) {
    actorCheck(actor);
    return disk.locked(async () => {
      if (!(await exists(frameworkFile))) throw new Error('FRAMEWORK_NOT_INITIALIZED');
      // Persist intent before mutation. Interrupted operations remain visible in the journal.
      await audit.append({ actor, action: `${action}.started`, pluginId: validId(id) ? id : null, result: 'started' });
      try {
        const result = await task();
        const event = await audit.append({ actor, action, pluginId: validId(id) ? id : null });
        const mirror = await audit.mirror(event, actor);
        return { ...result, audit: { id: event.id, tower: mirror.state } };
      } catch (error) {
        await audit.append({ actor, action, pluginId: validId(id) ? id : null, result: 'failed', code: /^[A-Z_]{1,100}$/.test(error.message) ? error.message : ['EACCES', 'ENOSPC', 'EIO'].includes(error.code) ? error.code : 'OPERATION_FAILED' });
        throw error;
      }
    });
  }
  async function persistPackage(bytes) {
    const pkg = validatePackage(bytes), file = path.join(disk.root, 'packages', `${pkg.digest}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await getPackage(pkg.digest); }
    return { packageId: pkg.digest, manifest: pkg.manifest };
  }
  return {
    root: disk.root,
    async initialize(actor) {
      actorCheck(actor);
      return disk.locked(async () => {
        await mkdir(path.dirname(frameworkFile), { recursive: true });
        if (await exists(frameworkFile)) return { initialized: true, created: false };
        // The first install never silently enables browser plugins.
        await atomic(disabledFile, { disabledAt: new Date().toISOString(), actor: actor.id });
        await atomic(frameworkFile, { version: FRAMEWORK_VERSION, apiVersion: 1, initializedAt: new Date().toISOString() });
        await audit.append({ actor, action: 'framework.install' });
        return { initialized: true, created: true };
      });
    },
    async runtime() {
      const initialized = await exists(frameworkFile), disabled = await exists(disabledFile);
      let valid = false;
      try { const value = await json(frameworkFile); valid = value.apiVersion === 1 && value.version === FRAMEWORK_VERSION; } catch { /* Fail closed. */ }
      return { initialized, enabled: valid && !disabled, version: FRAMEWORK_VERSION, isolation: 'TODO', audit: audit.status() };
    },
    async disable(actor) {
      actorCheck(actor);
      // This path never reads plugin packages, configurations or the lifecycle write lock.
      return runtimeDisk.locked(async () => {
        await atomic(disabledFile, { disabledAt: new Date().toISOString(), actor: actor.id });
        let recorded = true;
        try { await audit.append({ actor, action: 'framework.disable' }); } catch { recorded = false; }
        return { enabled: false, auditRecorded: recorded };
      });
    },
    async enable(actor) {
      actorCheck(actor);
      return runtimeDisk.locked(async () => {
        if (!(await exists(frameworkFile))) throw new Error('FRAMEWORK_NOT_INITIALIZED');
        await audit.append({ actor, action: 'framework.enable' });
        await unlink(disabledFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        return { enabled: true };
      });
    },
    upload(bytes, actor) {
      return recorded(actor, 'package.upload', null, () => persistPackage(bytes));
    },
    checkUpdates(actor) {
      return recorded(actor, 'updates.check', null, async () => {
        if (!updateSource) throw new Error('UPDATE_SOURCE_UNAVAILABLE');
        const catalog = await updateSource.catalog(), items = [];
        for (const id of await pluginIds()) {
          const installed = await state(id), candidate = catalog.find(item => item.id === id);
          if (installed.installed && candidate) items.push({ id, version: candidate.version, available: newer(candidate.version, installed.version), downloadable: Boolean(candidate.assetId) });
        }
        return { items, checkedAt: new Date().toISOString() };
      });
    },
    downloadUpdate(id, version, actor) {
      return recorded(actor, 'plugin.download', id, async () => {
        await checkedId(id); const installed = await state(id);
        if (!installed.installed || !newer(version, installed.version)) throw new Error('UPDATE_VERSION_MUST_INCREASE');
        if (!updateSource) throw new Error('UPDATE_SOURCE_UNAVAILABLE');
        return persistPackage(await updateSource.download(id, version));
      });
    },
    async packages() {
      let names; try { names = await readdir(path.join(disk.root, 'packages')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const items = [];
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 500)) {
        try { const pkg = await getPackage(name.slice(0, -5)); items.push({ packageId: pkg.digest, manifest: pkg.manifest }); }
        catch { items.push({ packageId: name.slice(0, -5), error: 'PACKAGE_UNAVAILABLE' }); }
      }
      return items;
    },
    async plugins() {
      const items = [];
      for (const id of await pluginIds()) {
        try {
          const item = await state(id);
          if (!item.installed) { items.push({ id, ...item }); continue; }
          const { pkg } = await entry(id), runtime = await this.runtime();
          let error = null; try { await config(id, pkg.manifest); } catch { error = 'CONFIGURATION_UNAVAILABLE'; }
          items.push({ id, ...item, manifest: pkg.manifest, active: runtime.enabled && item.enabled && !error, error,
            frontendSha256: pkg.files.find(file => file.path === pkg.manifest.frontend.entry).sha256 });
        } catch { items.push({ id, installed: false, enabled: false, active: false, error: 'PLUGIN_UNAVAILABLE' }); }
      }
      return items;
    },
    async loadConfig() {
      const plugins = {}, errors = {};
      for (const id of await pluginIds()) {
        try { const { pkg } = await entry(id); plugins[id] = await config(id, pkg.manifest); }
        catch (error) { if (error.message !== 'PLUGIN_NOT_INSTALLED') errors[id] = 'CONFIGURATION_UNAVAILABLE'; }
      }
      return { version: 1, revision: Object.values(plugins).reduce((sum, value) => sum + value.revision, 0), plugins, errors };
    },
    saveConfig(id, settings, actor) {
      return recorded(actor, 'configuration.save', id, async () => {
        const { pkg } = await entry(id), previous = await config(id, pkg.manifest);
        const clean = validateSettings(settings, pkg.manifest.configuration.schema);
        const next = { revision: previous.revision + 1, updatedAt: new Date().toISOString(), schemaVersion: pkg.manifest.configuration.version, settings: clean };
        await atomic(disk.plugin(id), next); return next;
      });
    },
    change(action, id, packageId, actor) {
      return recorded(actor, `plugin.${action}`, id, async () => {
        await checkedId(id); const previous = await state(id);
        if (['install', 'update'].includes(action)) {
          if ((action === 'install' && previous.installed) || (action === 'update' && !previous.installed)) throw new Error('INVALID_TRANSITION');
          const pkg = await getPackage(packageId), manifest = pkg.manifest;
          if (manifest.id !== id) throw new Error('PLUGIN_ID_MISMATCH');
          if (previous.installed && previous.version === manifest.version) throw new Error('VERSION_ALREADY_INSTALLED');
          if (previous.installed) {
            const compare = manifest.version.split('.').map(Number), old = previous.version.split('.').map(Number);
            const difference = compare.map((value, index) => value - old[index]).find(value => value !== 0);
            if (!(difference > 0)) throw new Error('UPDATE_VERSION_MUST_INCREASE');
          }
          let saved = await config(id, manifest);
          if (previous.installed) {
            const old = await getPackage(previous.packageId);
            if (old.manifest.configuration.version !== manifest.configuration.version) throw new Error('MIGRATION_REQUIRED');
            saved = await config(id, old.manifest); validateSettings(saved.settings, manifest.configuration.schema);
            await atomic(path.join(disk.root, 'backups', `${id}-${Date.now()}-${saved.revision}.json`), { state: previous, config: saved });
          }
          await atomic(disk.plugin(id), saved);
          // Commit pointer last; updates deliberately require explicit re-enabling.
          const next = { installed: true, enabled: false, version: manifest.version, packageId, previous: previous.installed ? { ...previous, previous: null } : null, updatedAt: new Date().toISOString() };
          await atomic(disk.plugin(id, 'state.json'), next); return next;
        }
        if (!previous.installed) throw new Error('PLUGIN_NOT_INSTALLED');
        if (action === 'rollback') {
          if (!previous.previous) throw new Error('NO_PREVIOUS_VERSION');
          const pkg = await getPackage(previous.previous.packageId); await config(id, pkg.manifest);
          const next = { ...previous.previous, enabled: false, previous: { ...previous, previous: null }, updatedAt: new Date().toISOString() };
          await atomic(disk.plugin(id, 'state.json'), next); return next;
        }
        if (action === 'reset') {
          const { pkg } = await entry(id);
          let current = { revision: 0 };
          try { current = await config(id, pkg.manifest); } catch { /* Explicit reset may repair a corrupt config; preserve its original bytes. */ }
          const raw = await readFile(disk.plugin(id)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (raw) { await mkdir(path.join(disk.root, 'backups'), { recursive: true }); await writeFile(path.join(disk.root, 'backups', `${id}-${Date.now()}-${current.revision}.config.backup`), raw, { flag: 'wx', mode: 0o600 }); }
          await atomic(disk.plugin(id), { revision: current.revision + 1, updatedAt: new Date().toISOString(), schemaVersion: pkg.manifest.configuration.version, settings: pkg.manifest.configuration.defaults });
          return previous;
        }
        if (!['enable', 'disable', 'uninstall'].includes(action)) throw new Error('INVALID_ACTION');
        if (action === 'enable') { const { pkg } = await entry(id); await config(id, pkg.manifest); }
        const next = { ...previous, enabled: action === 'enable', installed: action !== 'uninstall', updatedAt: new Date().toISOString() };
        await atomic(disk.plugin(id, 'state.json'), next); return next;
      });
    },
    async asset(id, digest, file) {
      const { item, pkg } = await entry(id);
      if (!(await this.runtime()).enabled || !item.enabled || item.packageId !== digest) throw new Error('PLUGIN_DISABLED');
      const target = pkg.files.find(value => value.path === file); if (!target) throw new Error('ASSET_NOT_FOUND');
      return target;
    },
    logs: options => audit.recent(options),
    async migrateLegacy(file, actor) {
      return recorded(actor, 'configuration.migrate', null, async () => {
        const old = await json(file), entries = old.plugins || (old.settings ? { 'pluginkit-ipmi-redirection': old } : null);
        if (!entries) throw new Error('INVALID_LEGACY_CONFIG');
        const candidates = [];
        for (const [id, value] of Object.entries(entries)) {
          const { pkg } = await entry(id);
          if (await exists(disk.plugin(id)) && (await config(id, pkg.manifest)).revision !== 0) throw new Error('CONFIGURATION_ALREADY_EXISTS');
          validateSettings(value.settings, pkg.manifest.configuration.schema);
          if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('INVALID_LEGACY_CONFIG');
          candidates.push([id, { ...value, schemaVersion: pkg.manifest.configuration.version }]);
        }
        await atomic(path.join(disk.root, 'backups', 'legacy-configuration.json'), old);
        for (const [id, value] of candidates) await atomic(disk.plugin(id), value);
        return { migrated: candidates.map(([id]) => id) };
      });
    },
  };
}
