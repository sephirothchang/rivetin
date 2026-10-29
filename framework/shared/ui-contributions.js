export const UI_CONTRIBUTIONS_MINIMUM = '0.2.6';
export const UI_SLOTS = Object.freeze(['everoute.navigation.tools', 'cluster-network-topology.toolbar.actions']);
export const UI_ICONS = Object.freeze(['none', 'tool', 'convert', 'edit', 'network', 'arrow-right']);
export const UI_LIMITS = Object.freeze({ pages: 8, actions: 16, contributions: 16, globalContributions: 128 });
const localId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const fields = (value, allowed, required = allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new Error('UI_CONTRIBUTIONS_INVALID'); };
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function supportsUiContributions(manifest) {
  const value = manifest?.compatibility?.frameworkMinVersion;
  if (manifest?.compatibility?.schemaVersion !== 2 || typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  const [major, minor, patch] = value.split('.').map(Number);
  return major > 0 || minor > 2 || minor === 2 && patch >= 6;
}

export function validateUiContributions(value, manifest) {
  if (!supportsUiContributions(manifest)) throw new Error('UI_FRAMEWORK_MINIMUM_REQUIRED');
  if (!fields(value, ['schemaVersion', 'pages', 'actions', 'contributions']) || value.schemaVersion !== 1) invalid();
  for (const key of ['pages', 'actions', 'contributions']) if (!Array.isArray(value[key]) || value[key].length > UI_LIMITS[key]) invalid();
  const pages = new Map(), actions = new Map(), ids = new Set(), pageSlots = new Map();
  for (const page of value.pages) {
    if (!fields(page, ['id', 'Component']) || !localId(page.id) || pages.has(page.id) || typeof page.Component !== 'function') invalid();
    pages.set(page.id, Object.freeze({ ...page }));
  }
  for (const action of value.actions) {
    if (!fields(action, ['id', 'run']) || !localId(action.id) || actions.has(action.id) || typeof action.run !== 'function') invalid();
    actions.set(action.id, Object.freeze({ ...action }));
  }
  const contributions = value.contributions.map(row => {
    if (!fields(row, ['id', 'slot', 'label', 'icon', 'order', 'visibility', 'target'], ['id', 'slot', 'label', 'target']) || !localId(row.id) || ids.has(row.id) || !UI_SLOTS.includes(row.slot) ||
        !fields(row.label, ['zh-CN', 'en-US']) || !Object.values(row.label).every(text) || row.icon !== undefined && !UI_ICONS.includes(row.icon) ||
        row.order !== undefined && (!Number.isInteger(row.order) || Math.abs(row.order) > 1000) || !fields(row.target, ['type', 'id']) || !localId(row.target.id)) invalid();
    const required = row.visibility?.requiresContext || [];
    if (row.visibility !== undefined && (!fields(row.visibility, ['requiresContext']) || !Array.isArray(row.visibility.requiresContext) || required.length > 1 || required.some(key => key !== 'clusterId'))) invalid();
    if (row.target.type === 'page') {
      if (!pages.has(row.target.id) || pageSlots.has(row.target.id) && pageSlots.get(row.target.id) !== row.slot) invalid();
      pageSlots.set(row.target.id, row.slot);
    } else if (row.target.type !== 'action' || !actions.has(row.target.id)) invalid();
    ids.add(row.id);
    return Object.freeze({ id: row.id, slot: row.slot, label: Object.freeze({ ...row.label }), icon: row.icon || 'none', order: row.order ?? 0,
      visibility: Object.freeze({ requiresContext: Object.freeze([...required]) }), target: Object.freeze({ ...row.target }) });
  });
  if ([...pages.keys()].some(id => !pageSlots.has(id))) invalid();
  return Object.freeze({ schemaVersion: 1, pages: Object.freeze([...pages.values()].map(page => Object.freeze({ ...page, slot: pageSlots.get(page.id) }))), actions: Object.freeze([...actions.values()]), contributions: Object.freeze(contributions) });
}

// UI errors do not cross the base plugin lifecycle/Settings boundary.
export function readUiContributions(definition, manifest) {
  try {
    if (definition.ui === undefined) return Object.freeze({ status: definition.workPage === undefined ? 'none' : 'unavailable', code: definition.workPage === undefined ? null : 'UI_LEGACY_WORKPAGE_UNAVAILABLE', ui: null });
    if (definition.workPage !== undefined) return Object.freeze({ status: 'invalid', code: 'UI_CONTRIBUTIONS_INVALID', ui: null });
    return Object.freeze({ status: 'registered', code: null, ui: validateUiContributions(definition.ui, manifest) });
  }
  catch (error) { return Object.freeze({ status: error?.message === 'UI_FRAMEWORK_MINIMUM_REQUIRED' ? 'unavailable' : 'invalid', code: error?.message === 'UI_FRAMEWORK_MINIMUM_REQUIRED' ? error.message : 'UI_CONTRIBUTIONS_INVALID', ui: null }); }
}

export function contributionVisible(contribution, context) {
  return contribution.visibility.requiresContext.every(key => typeof context?.[key] === 'string' && context[key].length > 0);
}

export function orderContributions(a, b) {
  return compare(a.contribution.slot, b.contribution.slot) || a.contribution.order - b.contribution.order || compare(a.pluginId, b.pluginId) || compare(a.contribution.id, b.contribution.id);
}
