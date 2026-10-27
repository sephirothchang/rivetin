// A standard GraphQL DocumentNode; this is a read-only metadata query, not a mutation.
const field = (name, children) => ({ kind: 'Field', name: { kind: 'Name', value: name },
  ...(children ? { selectionSet: { kind: 'SelectionSet', selections: children } } : {}) });
export const INVENTORY_QUERY = { kind: 'Document', definitions: [{ kind: 'OperationDefinition', operation: 'query',
  name: { kind: 'Name', value: 'C89IpmiConfigurationInventory' }, variableDefinitions: [], directives: [],
  selectionSet: { kind: 'SelectionSet', selections: [field('clusters', [field('id'), field('name')]),
    field('hosts', [field('id'), field('name'), field('cluster', [field('id'), field('name')])])] } }] };
export async function loadTowerInventory(apolloClient) {
  if (typeof apolloClient?.query !== 'function') throw new Error('当前环境没有可用的 Tower 查询客户端。');
  const abort = new AbortController(); let timer;
  try {
    const result = await Promise.race([
      apolloClient.query({ query: INVENTORY_QUERY, fetchPolicy: 'network-only', context: { fetchOptions: { signal: abort.signal } } }),
      new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('资产清单读取超时。')); }, 8000); }),
    ]);
    if (result.errors?.length || !Array.isArray(result.data?.hosts) || !Array.isArray(result.data?.clusters)) throw new Error('无法读取资产清单，请检查当前用户的查看权限。');
    return { clusters: result.data.clusters, hosts: result.data.hosts };
  } finally { clearTimeout(timer); }
}
