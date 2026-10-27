import { isIP } from 'node:net';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { status }); };
export function createSshInventory({ request } = {}) {
  if (typeof request !== 'function') throw new Error('TOWER_TRANSPORT_REQUIRED');
  return async actor => {
    if (!actor?.admin || actor.source !== 'tower' || !actor.auth || !['Authorization', 'Cookie'].some(key => typeof actor.auth[key] === 'string' && actor.auth[key])) fail('ADMIN_REQUIRED', 403);
    let clusters, hosts;
    try { [clusters, hosts] = await Promise.all(['/get-clusters', '/get-hosts'].map(route => request('/v2/api' + route, { first: 501 }, actor))); }
    catch (error) { fail('SSH_INVENTORY_UNAVAILABLE', [401, 403].includes(error.status) ? error.status : 503); }
    if (![clusters, hosts].every(rows => Array.isArray(rows) && rows.length <= 500)) fail('SSH_INVENTORY_LIMIT');
    const clusterIds = new Set(), hostIds = new Set();
    const groups = clusters.map(row => {
      if (!identifier(row?.id) || !label(row.name) || clusterIds.has(row.id)) fail('SSH_INVENTORY_INVALID');
      clusterIds.add(row.id); return { id: row.id, name: row.name };
    });
    const targets = hosts.map(row => {
      if (!identifier(row?.id) || !label(row.name) || !clusterIds.has(row.cluster?.id) || hostIds.has(row.id) || !isIP(row.management_ip || '')) fail('SSH_INVENTORY_INVALID');
      hostIds.add(row.id); return { id: row.id, name: row.name, clusterId: row.cluster.id, address: row.management_ip };
    });
    return { clusters: groups, hosts: targets };
  };
}
