import { sanitizeBmcProfiles } from './bmc-profiles.js';

export const STORAGE_KEY = 'c89.tower.plugins.personal.v2';
const LEGACY_KEY = 'c89.tower.plugins.preferences.v1';
export const DEFAULTS = Object.freeze({
  version: 1, showFloatingButton: true, ipmiEnabled: true,
  loginMode: 'direct', openInNewTab: true,
  defaultVendor: 'generic', bmcExceptions: [],
});
export function sanitizePreferences(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    showFloatingButton: typeof input.showFloatingButton === 'boolean' ? input.showFloatingButton : true,
    ipmiEnabled: typeof input.ipmiEnabled === 'boolean' ? input.ipmiEnabled : true,
    loginMode: input.loginMode === 'megarac' ? 'megarac' : 'direct',
    openInNewTab: typeof input.openInNewTab === 'boolean' ? input.openInNewTab : true,
    ...sanitizeBmcProfiles(input),
  };
}
export function createPreferenceStore(win) {
  let state = { ...DEFAULTS }, persistent = true;
  const listeners = new Set();
  try {
    const personal = JSON.parse(win.localStorage.getItem(STORAGE_KEY) || win.localStorage.getItem(LEGACY_KEY));
    state = sanitizePreferences({ showFloatingButton: personal?.showFloatingButton });
  }
  catch { persistent = false; }
  function snapshot() { return { ...state, bmcExceptions: state.bmcExceptions.map(rule => ({ ...rule })) }; }
  function emit() { for (const listener of listeners) listener(snapshot()); }
  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try { const value = JSON.parse(event.newValue); state = { ...state, showFloatingButton: value?.showFloatingButton !== false }; emit(); } catch { /* Keep valid current values. */ }
  }
  win.addEventListener('storage', onStorage);
  return {
    get: snapshot,
    persistent: () => persistent,
    update(patch) {
      state = sanitizePreferences({ ...state, ...patch });
      try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, showFloatingButton: state.showFloatingButton })); persistent = true; }
      catch { persistent = false; }
      emit(); return snapshot();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { win.removeEventListener('storage', onStorage); listeners.clear(); },
  };
}
