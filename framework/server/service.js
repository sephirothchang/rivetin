import { readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { storage, atomic, json, exists, validId, assertId } from './storage.js';
import { validatePackage, validateSettings, FRAMEWORK_VERSION } from './manifest.js';
import { auditStore } from './audit.js';
import { newer } from './updates.js';
import { createSshVault } from './ssh-vault.js';
import { createSshBroker } from './ssh-broker.js';
import { checkCompatibility, assertCompatible } from './compatibility.js';
import { createSmartProvider } from './smart-provider.js';
import { createResourceActions } from './resource-actions.js';
import { createSshInventory } from './tower-inventory.js';

const missing = { installed: false, enabled: false, version: null, packageId: null, previous: null };
export function createService(directory, { towerSink, updateSource, builtinPackages = [], sshRun, towerBuild, towerVersionProvider, readDisk, towerRequest } = {}) {
  const disk = storage(directory), runtimeDisk = storage(path.join(disk.root, 'framework'));
  const frameworkFile = path.join(disk.root, 'framework', 'settings.json'), disabledFile = path.join(disk.root, 'framework', 'disabled.json');
  const sshRevocationFile = path.join(disk.root, 'framework', 'ssh-revocation.json');
  const audit = auditStore(disk.root, towerSink);
  async function compatibilityContext({ fresh = false } = {}) {
    const version = towerVersionProvider ? await towerVersionProvider({ fresh }) : towerBuild || (await json(frameworkFile, {})).towerBuild || null;
    return { towerBuild: version, frameworkApi: 1, frameworkVersion: FRAMEWORK_VERSION };
  }
  const vault = createSshVault(disk.root);
  let service, smart;
  const pluginStatus = async id => {
    const runtime = await service.runtime(), plugin = (await service.plugins()).find(item => item.id === id);
    return { ...plugin, frameworkEnabled: runtime.enabled, enabled: Boolean(plugin?.active), compatible: Boolean(plugin?.compatible) };
  };
  const ssh = createSshBroker(disk.root, { vault, run: sshRun,
    serviceStatus: async () => {
      const runtime = await service.runtime(), plugins = await service.plugins();
      const channel = plugins.find(item => item.id === 'rivetin-ssh-channel');
      let allowed = false;
      if (channel?.installed && channel.active && !channel.error) {
        try { allowed = (await config(channel.id, channel.manifest)).settings.enabled === true; } catch { /* Fail closed. */ }
      }
      return { enabled: runtime.enabled, channelInstalled: Boolean(channel?.installed), channelEnabled: allowed, plugins: plugins.map(plugin => ({ ...plugin, enabled: Boolean(plugin.active) })) };
    },
    audit: event => audit.append(event),
    prepareResultContext: async input => smart && input.operation === 'disk.smart.read' ? (await smartReady()).prepareResultContext(input) : undefined,
    onResult: async (item, context, options) => smart && context ? (await smartReady()).onResult(item, context, options) : undefined,
  });
  if (readDisk) smart = createSmartProvider(disk.root, { readDisk, vault, pluginStatus });
  async function smartReady() {
    if (!smart) throw Object.assign(new Error('SMART_PROVIDER_UNAVAILABLE'), { status: 503 });
    if ((await compatibilityContext({ fresh: true })).towerBuild !== '4.9.0') throw Object.assign(new Error('SMART_TOWER_UNSUPPORTED'), { status: 503 });
    return smart;
  }
  const actions = towerRequest ? createResourceActions(disk.root, { request: towerRequest, pluginStatus,
    towerBuildProvider: async () => (await compatibilityContext({ fresh: true })).towerBuild,
    audit: event => audit.append(event) }) : null;
  const sshInventory = towerRequest ? createSshInventory({ request: towerRequest }) : null;
  const actorCheck = actor => { if (!actor || !['cli', 'demo', 'tower'].includes(actor.source) || typeof actor.id !== 'string' || actor.id.length > 128 || typeof actor.name !== 'string' || actor.name.length > 128) throw new Error('ACTOR_REQUIRED'); };
  async function checkedId(id) { return assertId(id); }
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
    try {
      const names = (await readdir(path.join(disk.root, 'plugins'), { withFileTypes: true })).filter(value => value.isDirectory() && validId(value.name)).map(value => value.name).sort();
      return names;
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function config(id, manifest) {
    await checkedId(id);
    const value = await json(disk.plugin(id), { revision: 0, updatedAt: null, schemaVersion: manifest.configuration.version, settings: manifest.configuration.defaults });
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.schemaVersion !== manifest.configuration.version) throw new Error('CONFIGURATION_INVALID');
    validateSettings(value.settings, manifest.configuration.schema); return value;
  }
  async function recorded(actor, action, id, task) {
    actorCheck(actor);
    if (id !== null) assertId(id);
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
  return service = {
    root: disk.root,
    sshChannel: ssh,
    sshHosts: vault,
    sshConnections(actor) {
      actorCheck(actor); if (!actor.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
      return vault.connections();
    },
    async sshInventory(actor) {
      if (!actor?.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
      if (!sshInventory || (await compatibilityContext({ fresh: true })).towerBuild !== '4.9.0') throw Object.assign(new Error('SSH_INVENTORY_UNAVAILABLE'), { status: 503 });
      return sshInventory(actor);
    },
    sshSaveConnections(payload, actor) {
      if (!actor?.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
      return recorded(actor, 'ssh.connections.save', 'rivetin-ssh-channel', async () => {
        await ssh.invalidate(null, 'CONNECTION_SETTINGS_CHANGED'); return vault.saveConnections(payload);
      });
    },
    smartData: {
      async resolveDisk(input) { return (await smartReady()).resolveDisk(input); },
      async readLatest(input) { return (await smartReady()).readLatest(input); },
      async readHistory(input) { return (await smartReady()).readHistory(input); },
      async bindings(actor) { if (!actor?.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 }); return (await smartReady()).bindings(actor); },
    },
    resourceActions: {
      read(input) { if (!actions) throw Object.assign(new Error('RESOURCE_ACTION_UNAVAILABLE'), { status: 503 }); return actions.read(input); },
      execute(input) { if (!actions) throw Object.assign(new Error('RESOURCE_ACTION_UNAVAILABLE'), { status: 503 }); return actions.execute(input); },
      task(input) { if (!actions) throw Object.assign(new Error('RESOURCE_ACTION_UNAVAILABLE'), { status: 503 }); return actions.task(input); },
      openConsole(input) { if (!actions) throw Object.assign(new Error('RESOURCE_ACTION_UNAVAILABLE'), { status: 503 }); return actions.openConsole(input); },
    },
    smartBind(input, actor) {
      if (!actor?.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
      return recorded(actor, 'smart.binding.save', null, async () => {
        await smartReady();
        await ssh.invalidate(null, 'HOST_PROFILE_CHANGED'); return smart.bind({ ...input, actor });
      });
    },
    smartUnbind(diskId, actor) {
      if (!actor?.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
      return recorded(actor, 'smart.binding.remove', null, async () => {
        await smartReady();
        await ssh.invalidate(null, 'HOST_PROFILE_CHANGED'); return smart.unbind({ diskId, actor });
      });
    },
    sshSaveHost(profile, actor) {
      return recorded(actor, 'ssh.host.save', 'rivetin-ssh-channel', async () => {
        await ssh.invalidate(null, 'HOST_PROFILE_CHANGED');
        return vault.put(profile);
      });
    },
    sshRemoveHost(hostId, actor) {
      return recorded(actor, 'ssh.host.remove', 'rivetin-ssh-channel', async () => {
        await ssh.invalidate(null, 'HOST_PROFILE_CHANGED');
        return vault.remove(hostId);
      });
    },
    async initialize(actor) {
      actorCheck(actor);
      return disk.locked(async () => {
        await mkdir(path.dirname(frameworkFile), { recursive: true });
        const created = !(await exists(frameworkFile));
        // The first install never silently enables browser plugins.
        if (created) {
          await atomic(disabledFile, { disabledAt: new Date().toISOString(), actor: actor.id });
          await atomic(frameworkFile, { version: FRAMEWORK_VERSION, apiVersion: 1, initializedAt: new Date().toISOString(), ...(towerBuild ? { towerBuild } : {}) });
          await audit.append({ actor, action: 'framework.install' });
        }
        for (const bytes of builtinPackages) {
          const pkg = validatePackage(bytes), id = pkg.manifest.id;
          if (id !== 'rivetin-ssh-channel') throw new Error('INVALID_BUILTIN_PLUGIN');
          await checkedId(id);
          // A retained uninstall tombstone must not be silently reinstalled.
          if (await exists(disk.plugin(id, 'state.json'))) continue;
          await persistPackage(bytes);
          await atomic(disk.plugin(id), await config(id, pkg.manifest));
          await atomic(disk.plugin(id, 'state.json'), { installed: true, enabled: false, version: pkg.manifest.version, packageId: pkg.digest, previous: null, updatedAt: new Date().toISOString() });
          await audit.append({ actor, action: 'plugin.install', pluginId: id });
        }
        return { initialized: true, created };
      });
    },
    async runtime() {
      const initialized = await exists(frameworkFile), disabled = await exists(disabledFile);
      let valid = false;
      try { const value = await json(frameworkFile); valid = value.apiVersion === 1 && value.version === FRAMEWORK_VERSION; } catch { /* Fail closed. */ }
      return { initialized, enabled: valid && !disabled, version: FRAMEWORK_VERSION, towerBuild: (await compatibilityContext()).towerBuild, isolation: 'TODO', audit: audit.status() };
    },
    async disable(actor) {
      actorCheck(actor);
      // This path never reads plugin packages, configurations or the lifecycle write lock.
      return runtimeDisk.locked(async () => {
        await atomic(disabledFile, { disabledAt: new Date().toISOString(), actor: actor.id });
        let sshRevoked = true;
        try { await atomic(sshRevocationFile, { nonce: randomBytes(16).toString('hex') }); } catch { sshRevoked = false; }
        try { await ssh.invalidate(null, 'FRAMEWORK_DISABLED'); } catch { sshRevoked = false; }
        let recorded = true;
        try { await audit.append({ actor, action: 'framework.disable' }); } catch { recorded = false; }
        return { enabled: false, auditRecorded: recorded, sshRevoked };
      });
    },
    async enable(actor) {
      actorCheck(actor);
      return runtimeDisk.locked(async () => {
        if (!(await exists(frameworkFile))) throw new Error('FRAMEWORK_NOT_INITIALIZED');
        // Resuming never restores an SSH approval, even after an offline rescue.
        await atomic(sshRevocationFile, { nonce: randomBytes(16).toString('hex') });
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
        const catalog = updateSource.market ? await updateSource.market() : (await updateSource.catalog()).filter(item => item.status === 'published'), items = [];
        for (const id of await pluginIds()) {
          const installed = await state(id), candidate = catalog.find(item => item.id === id);
          if (installed.installed && candidate) items.push({ id: id, version: candidate.version, available: newer(candidate.version, installed.version), downloadable: Boolean(candidate.assetId) });
        }
        return { items, checkedAt: new Date().toISOString() };
      });
    },
    async updateStatus(actor) {
      actorCheck(actor);
      if (!actor.admin) throw new Error('ADMIN_REQUIRED');
      if (!updateSource?.probe) return { reachable: false, checkedAt: new Date().toISOString(), reason: 'UPDATE_SOURCE_UNAVAILABLE' };
      return updateSource.probe();
    },
    downloadUpdate(id, version, actor) {
      return recorded(actor, 'plugin.download', id, async () => {
        await checkedId(id); const installed = await state(id);
        if (!installed.installed || !newer(version, installed.version)) throw new Error('UPDATE_VERSION_MUST_INCREASE');
        if (!updateSource) throw new Error('UPDATE_SOURCE_UNAVAILABLE');
        const bytes = await updateSource.download(id, version);
        assertCompatible(validatePackage(bytes).manifest, await compatibilityContext());
        return persistPackage(bytes);
      });
    },
    async marketplace(actor) {
      actorCheck(actor); if (!actor.admin) throw new Error('ADMIN_REQUIRED');
      const context = await compatibilityContext();
      if (!updateSource?.market) return { items: [], source: { reachable: false, reason: 'UPDATE_SOURCE_UNAVAILABLE' }, towerBuild: context.towerBuild };
      try {
        const items = await updateSource.market(), installed = await this.plugins();
        return { towerBuild: context.towerBuild, source: { reachable: true }, items: items.map(item => {
          const current = installed.find(plugin => plugin.id === item.id && plugin.installed);
          return { ...item, id: item.id, published: true, downloadable: true, ...checkCompatibility({ compatibility: item.compatibility }, context), installed: Boolean(current), installedVersion: current?.version || null };
        }) };
      } catch (error) { return { items: [], towerBuild: context.towerBuild, source: { reachable: false, reason: /^UPDATE_[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_SOURCE_UNAVAILABLE' } }; }
    },
    installFromMarket(id, version, actor) {
      return recorded(actor, 'market.install', id, async () => {
        await checkedId(id); if ((await state(id)).installed) throw new Error('INVALID_TRANSITION');
        if (!updateSource?.market) throw new Error('UPDATE_SOURCE_UNAVAILABLE');
        const candidate = (await updateSource.market()).find(item => item.id === id && item.version === version);
        if (!candidate) throw new Error('UPDATE_PACKAGE_UNPUBLISHED');
        assertCompatible({ compatibility: candidate.compatibility }, await compatibilityContext({ fresh: true }));
        const bytes = await updateSource.download(id, version), pkg = validatePackage(bytes);
        if (pkg.manifest.id !== id || pkg.manifest.version !== version || pkg.digest !== candidate.sha256) throw new Error('UPDATE_METADATA_MISMATCH');
        assertCompatible(pkg.manifest, await compatibilityContext({ fresh: true }));
        await persistPackage(bytes);
        const saved = await config(id, pkg.manifest);
        await atomic(disk.plugin(id), saved);
        const next = { installed: true, enabled: false, version, packageId: pkg.digest, previous: null, updatedAt: new Date().toISOString() };
        await atomic(disk.plugin(id, 'state.json'), next); return next;
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
          if (!item.installed) { items.push({ id: id, ...item }); continue; }
          const { pkg } = await entry(id), runtime = await this.runtime();
          let error = null; try { await config(id, pkg.manifest); } catch { error = 'CONFIGURATION_UNAVAILABLE'; }
          const compatibility = checkCompatibility(pkg.manifest, await compatibilityContext());
          items.push({ id: id, ...item, manifest: pkg.manifest, active: runtime.enabled && item.enabled && !error && compatibility.compatible, error, ...compatibility,
            frontendSha256: pkg.files.find(file => file.path === pkg.manifest.frontend.entry).sha256 });
        } catch { items.push({ id: id, installed: false, enabled: false, active: false, error: 'PLUGIN_UNAVAILABLE' }); }
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
        id = await checkedId(id);
        const { pkg } = await entry(id), previous = await config(id, pkg.manifest);
        const clean = validateSettings(settings, pkg.manifest.configuration.schema);
        await ssh.invalidate(id === 'rivetin-ssh-channel' ? null : id, 'CONFIGURATION_CHANGED');
        const next = { revision: previous.revision + 1, updatedAt: new Date().toISOString(), schemaVersion: pkg.manifest.configuration.version, settings: clean };
        await atomic(disk.plugin(id), next); return next;
      });
    },
    change(action, id, packageId, actor) {
      return recorded(actor, `plugin.${action}`, id, async () => {
        id = await checkedId(id); const previous = await state(id);
        if (['install', 'update', 'rollback', 'reset', 'disable', 'uninstall'].includes(action)) await ssh.invalidate(id === 'rivetin-ssh-channel' ? null : id, 'PLUGIN_LIFECYCLE_CHANGED');
        if (['install', 'update'].includes(action)) {
          if ((action === 'install' && previous.installed) || (action === 'update' && !previous.installed)) throw new Error('INVALID_TRANSITION');
          const pkg = await getPackage(packageId), manifest = pkg.manifest;
          assertCompatible(manifest, await compatibilityContext({ fresh: true }));
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
          const pkg = await getPackage(previous.previous.packageId); assertCompatible(pkg.manifest, await compatibilityContext({ fresh: true })); await config(id, pkg.manifest);
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
        if (action === 'enable') { const { pkg } = await entry(id); assertCompatible(pkg.manifest, await compatibilityContext({ fresh: true })); await config(id, pkg.manifest); }
        const next = { ...previous, enabled: action === 'enable', installed: action !== 'uninstall', updatedAt: new Date().toISOString() };
        await atomic(disk.plugin(id, 'state.json'), next); return next;
      });
    },
    async asset(id, digest, file) {
      const { item, pkg } = await entry(id);
      if (!(await this.runtime()).enabled || !item.enabled || item.packageId !== digest) throw new Error('PLUGIN_DISABLED');
      assertCompatible(pkg.manifest, await compatibilityContext());
      const target = pkg.files.find(value => value.path === file); if (!target) throw new Error('ASSET_NOT_FOUND');
      return target;
    },
    logs: options => audit.recent(options),

  };
}
