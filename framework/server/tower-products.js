const TYPES = new Set(['SMTX_OS', 'SMTX_ELF', 'SMTX_ZBS', 'BLUESHARK']);
const identifier = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const version = value => typeof value === 'string' && value === value.trim() && value.length <= 100 && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(value);
const count = value => value && Object.keys(value).join() === 'aggregate' && value.aggregate && Object.keys(value.aggregate).join() === 'count' && Number.isSafeInteger(value.aggregate.count) && value.aggregate.count >= 0 ? value.aggregate.count : null;

export function createTowerProductsProvider({ request, now = Date.now, timeoutMs = 5000 } = {}) {
  if (typeof request !== 'function') throw new Error('TOWER_TRANSPORT_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('INVALID_PRODUCT_TIMEOUT');
  return async (actor, { signal } = {}) => {
    const snapshot = (reason, clusters = []) => ({ schemaVersion: 1, source: 'tower-clusters-root', trusted: reason === null, complete: reason === null, checkedAt: new Date(now()).toISOString(), clusters, reason });
    if (actor?.admin !== true || actor.source !== 'tower' || actor.role !== 'ROOT' || !actor.auth || !['Authorization', 'Cookie'].some(key => typeof actor.auth[key] === 'string' && actor.auth[key])) return snapshot('SMTX_AUTHORITY_REQUIRED');
    if (signal?.aborted) return snapshot('SMTX_CHECK_CANCELLED');
    let stopped = false, timer, cancel;
    const check = () => { if (stopped || signal?.aborted) throw new Error('SMTX_CHECK_CANCELLED'); };
    const work = async () => {
      // Empty filters count the entire ROOT-authorized local inventory, never a UI scope.
      check(); const before = count(await request('/v2/api/get-clusters-connection', {}, actor)); check();
      if (before === null) return snapshot('SMTX_INVENTORY_INVALID');
      if (before > 500) return snapshot('SMTX_INVENTORY_LIMIT');
      const rows = await request('/v2/api/get-clusters', { first: 501 }, actor); check();
      if (!Array.isArray(rows) || rows.length > 500) return snapshot('SMTX_INVENTORY_LIMIT');
      const ids = new Set(), clusters = [];
      for (const row of rows) {
        if (!identifier(row?.id) || ids.has(row.id) || !TYPES.has(row.type) || !version(row.version)) return snapshot('SMTX_INVENTORY_INVALID');
        if (row.connect_state !== 'CONNECTED') return snapshot('SMTX_CLUSTER_UNAVAILABLE');
        ids.add(row.id); clusters.push({ product: row.type, version: row.version });
      }
      const after = count(await request('/v2/api/get-clusters-connection', {}, actor)); check();
      if (after === null || before !== after || rows.length !== after) return snapshot('SMTX_SCOPE_INCOMPLETE');
      return snapshot(null, clusters);
    };
    try {
      return await Promise.race([
        work(),
        new Promise(resolve => { timer = setTimeout(() => { stopped = true; resolve(snapshot('SMTX_CHECK_TIMEOUT')); }, timeoutMs); }),
        new Promise(resolve => { cancel = () => { stopped = true; resolve(snapshot('SMTX_CHECK_CANCELLED')); }; signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel(); }),
      ]);
    } catch { return snapshot('SMTX_INVENTORY_UNAVAILABLE'); }
    finally { stopped = true; clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
  };
}
