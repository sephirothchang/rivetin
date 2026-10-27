export function createTowerVersionProvider({ request, now = Date.now } = {}) {
  if (typeof request !== 'function') throw new Error('TOWER_TRANSPORT_REQUIRED');
  let cached, pending;
  return async ({ fresh = false } = {}) => {
    if (!fresh && cached && now() - cached.at < 30000) return cached.version;
    if (!pending) pending = (async () => {
      let version = null;
      try {
        const value = await request('/api', { query: 'query cloudTowerVersion { deploys(first: 1) { version } }' });
        const deploys = value?.data?.deploys;
        if (!value?.errors?.length && Array.isArray(deploys) && deploys.length === 1 && typeof deploys[0].version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(deploys[0].version)) version = deploys[0].version;
      } catch { /* Unknown host version must not authorize a plugin. */ }
      cached = { at: now(), version }; return version;
    })().finally(() => { pending = null; });
    return pending;
  };
}
