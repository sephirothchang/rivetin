export const KEY = 'rivetin.personal.v1';
export function createPreferenceStore(win) {
  let state = { showFloatingButton: true }, persistent = true;
  const listeners = new Set(), emit = () => { for (const listener of listeners) listener({ ...state }); };
  function read(value) {
    const parsed = JSON.parse(value || '{}'), point = parsed.floatingPosition;
    const floatingPosition = point && ['x', 'y'].every(key => Number.isFinite(point[key]) && point[key] >= 0 && point[key] <= 100000) ? { x: Math.round(point.x), y: Math.round(point.y) } : null;
    return { showFloatingButton: parsed.showFloatingButton !== false, floatingPosition };
  }
  try { state = read(win.localStorage.getItem(KEY)); } catch { persistent = false; }
  function onStorage(event) {
    if (event.key !== KEY && event.key !== null) return;
    try { state = read(event.newValue); emit(); } catch { /* Keep the last valid preference. */ }
  }
  win.addEventListener('storage', onStorage);
  return {
    get: () => ({ ...state }), persistent: () => persistent,
    update(patch) {
      state = read(JSON.stringify({ ...state, ...patch }));
      try { win.localStorage.setItem(KEY, JSON.stringify(state)); persistent = true; } catch { persistent = false; }
      emit(); return { ...state };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { win.removeEventListener('storage', onStorage); listeners.clear(); },
  };
}
