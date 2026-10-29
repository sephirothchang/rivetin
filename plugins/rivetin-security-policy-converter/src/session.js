import { convert, exportReview } from './converter.js';
import { sampleInventory, sampleTraffic, sampleExternal } from './sample.js';

export function createSession(initialLabelKey = 'application') {
  const blank = () => ({ inventoryText: '', trafficText: '', clusterId: '', externalText: '', columnMap: {}, result: null, reviewed: false, error: '', reading: false });
  let state = blank(), revision = 0, active = false, labelKey = initialLabelKey;
  const listeners = new Set(), emit = () => { for (const listener of listeners) listener(); };
  const invalidate = () => { revision++; state = { ...state, result: null, reviewed: false, error: '', reading: false }; };
  return {
    view: () => structuredClone(state), isActive: () => active,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    activate() { active = true; },
    clear() { revision++; state = blank(); emit(); },
    stop() { active = false; revision++; state = blank(); emit(); },
    configure(value) { if (labelKey !== value) { labelKey = value; invalidate(); emit(); } },
    set(patch) {
      if (!active) return;
      invalidate();
      for (const key of ['inventoryText', 'trafficText', 'clusterId', 'externalText', 'columnMap']) if (Object.hasOwn(patch, key)) state[key] = structuredClone(patch[key]);
      if (Object.hasOwn(patch, 'trafficText') && !Object.hasOwn(patch, 'columnMap')) state.columnMap = {};
      emit();
    },
    sample() {
      this.set({ inventoryText: JSON.stringify(sampleInventory, null, 2), trafficText: sampleTraffic, clusterId: 'demo-cluster', externalText: sampleExternal, columnMap: {} });
    },
    beginRead() { invalidate(); state.reading = true; emit(); return revision; },
    finishRead(ticket, field, text) { if (active && ticket === revision) this.set({ [field]: text }); },
    failRead(ticket) { if (active && ticket === revision) { state.reading = false; state.error = 'FILE_READ'; emit(); } },
    run() {
      if (!active) return;
      invalidate();
      try { state.result = convert({ ...state, labelKey }); }
      catch (error) { state.error = error.message; }
      emit();
    },
    review(value) { if (active && state.result) { state.reviewed = value === true; emit(); } },
    export() { if (!active) throw new Error('PLUGIN_INACTIVE'); return exportReview(state.result, state.reviewed); }
  };
}
