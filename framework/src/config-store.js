import { createPreferenceStore } from './personal.js';
import { createClient } from './client.js';
import { assertId } from '../shared/identity.js';


function envelope(value, validateFunctionalSettings) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !(value.updatedAt === null || typeof value.updatedAt === 'string')) throw new Error('INVALID_CONFIG_RESPONSE');
  return { ...value, settings: validateFunctionalSettings(value.settings) };
}
export function createConfigurationStore(win, backend, definition) {
  const { defaults: sanitizeFunctionalSettings, equal: functionalEqual, seed: seedClusterExceptions, validate: validateFunctionalSettings } = definition;
  const personal = createPreferenceStore(win), listeners = new Set();
  let saved = sanitizeFunctionalSettings(), draft = sanitizeFunctionalSettings(), clusters = [];
  let state = { loaded: false, loading: false, saving: false, error: '', revision: 0, updatedAt: null };
  const copy = value => JSON.parse(JSON.stringify(value));
  const status = () => ({ ...state, dirty: !functionalEqual(saved, draft) });
  const get = () => ({ ...copy(saved), showFloatingButton: personal.get().showFloatingButton });
  const getDraft = () => ({ ...copy(draft), showFloatingButton: personal.get().showFloatingButton });
  const emit = () => { for (const listener of listeners) listener(get()); };
  const unsubPersonal = personal.subscribe(emit);
  function reconcile() { if (state.loaded) draft = seedClusterExceptions(draft, clusters); }
  function accept(value) {
    const response = envelope(value, validateFunctionalSettings), dirty = status().dirty;
    saved = response.settings;
    if (!dirty) draft = copy(saved);
    state = { ...state, loaded: true, revision: response.revision, updatedAt: response.updatedAt, error: '' };
    reconcile();
  }
  return {
    get, getDraft, status, persistent: personal.persistent,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update(patch) {
      if (state.saving) return getDraft();
      if (Object.hasOwn(patch, 'showFloatingButton')) personal.update({ showFloatingButton: patch.showFloatingButton });
      const functional = { ...patch }; delete functional.showFloatingButton;
      if (Object.keys(functional).length && state.loaded) draft = sanitizeFunctionalSettings({ ...draft, ...functional });
      emit(); return getDraft();
    },
    setClusters(values) {
      clusters = values;
      try { reconcile(); } catch { state.error = '集群数量超过配置容量，未自动补全规则。'; }
      emit();
    },
    async load() {
      if (state.loading || state.saving) return;
      state = { ...state, loading: true }; emit();
      try {
        if (!backend) throw new Error('BACKEND_UNAVAILABLE');
        accept(await backend.load());
      } catch { state.error = '共享配置读取失败，请重试。'; }
      finally { state.loading = false; emit(); }
    },
    async save() {
      if (!state.loaded || !backend || state.saving) return false;
      const candidate = copy(draft);
      state = { ...state, saving: true, error: '' }; emit();
      try {
        let response;
        try { response = envelope(await backend.save(candidate), validateFunctionalSettings); }
        catch {
          // Reconcile an uncertain PUT outcome without issuing a second write.
          response = envelope(await backend.load(), validateFunctionalSettings);
          if (!functionalEqual(response.settings, candidate)) throw new Error('SAVE_NOT_CONFIRMED');
        }
        if (!functionalEqual(response.settings, candidate)) throw new Error('SAVE_NOT_CONFIRMED');
        saved = response.settings; draft = copy(saved);
        state = { ...state, revision: response.revision, updatedAt: response.updatedAt };
        return true;
      } catch { state.error = '未能确认保存成功，修改已保留，请重试。'; return false; }
      finally { state.saving = false; emit(); }
    },
    discard() { if (!state.saving) { draft = copy(saved); state.error = ''; emit(); } },
    dispose() { unsubPersonal(); personal.dispose(); listeners.clear(); },
  };
}

export function createHttpConfigurationBackend(win, definition, endpoint = '/api/rivetin/v1/config') {
  const { defaults: sanitizeFunctionalSettings, validate: validateFunctionalSettings } = definition, PLUGIN_ID = assertId(definition.id);
  const target = new URL(endpoint, win.location.origin);
  if (target.origin !== win.location.origin) throw new Error('CONFIGURATION_ORIGIN_MISMATCH');
  if (target.pathname !== '/api/rivetin/v1/config' || target.search) throw new Error('INVALID_CONFIGURATION_ENDPOINT');
  const api = createClient(win);
  async function request(method, settings) {
    const document = await api('/config', method, settings ? { pluginId: PLUGIN_ID, settings } : undefined);
    if (document?.version !== 1 || !document.plugins || Array.isArray(document.plugins)) throw new Error('INVALID_CONFIG_RESPONSE');
    if (document.errors?.[PLUGIN_ID]) throw new Error('CONFIGURATION_UNAVAILABLE');
    return envelope(Object.hasOwn(document.plugins, PLUGIN_ID) ? document.plugins[PLUGIN_ID] :
      { revision: 0, updatedAt: null, settings: sanitizeFunctionalSettings() }, validateFunctionalSettings);
  }
  return { load: () => request('GET'), save: settings => request('PUT', settings) };
}
