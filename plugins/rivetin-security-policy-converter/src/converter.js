import { parseCsv, mapColumns, MAX_TEXT } from './csv.js';
import { PLUGIN_ID } from './configuration.js';

const cleanText = (value, max = 160) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function ipv4(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  return value.split('.').every(part => Number(part) <= 255) ? value : null;
}
export function parseInventory(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('INVENTORY_SIZE_LIMIT');
  let values; try { values = JSON.parse(text); } catch { throw new Error('INVENTORY_JSON'); }
  if (!Array.isArray(values) || !values.length || values.length > 5000) throw new Error('INVENTORY_SCHEMA');
  const ids = new Set();
  return values.map(value => {
    if (!object(value) || Object.keys(value).some(key => !['id', 'name', 'clusterId', 'ips', 'labels'].includes(key)) ||
        !['id', 'name', 'clusterId'].every(key => cleanText(value[key])) || ids.has(value.id) ||
        !Array.isArray(value.ips) || value.ips.length > 32 || value.ips.some(ip => !ipv4(ip)) || new Set(value.ips).size !== value.ips.length ||
        !Array.isArray(value.labels) || value.labels.length > 32 || value.labels.some(label => !object(label) || Object.keys(label).sort().join() !== 'key,value' || !cleanText(label.key, 80) || !cleanText(label.value, 80))) throw new Error('INVENTORY_SCHEMA');
    ids.add(value.id); return structuredClone(value);
  });
}
function externalAddresses(text) {
  if (typeof text !== 'string' || text.length > 20000) throw new Error('EXTERNAL_ADDRESSES');
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 1000 || parts.some(part => !ipv4(part))) throw new Error('EXTERNAL_ADDRESSES');
  return new Set(parts);
}

// This model deliberately contains no Label IDs, Everoute payload builder or network client.
export function convert({ inventoryText, trafficText, clusterId, labelKey, externalText = '', columnMap = {} }) {
  if (!cleanText(clusterId) || !cleanText(labelKey, 80)) throw new Error('CONVERSION_SCOPE');
  const inventory = parseInventory(inventoryText), table = parseCsv(trafficText), columns = mapColumns(table.headers, columnMap);
  if (!inventory.some(vm => vm.clusterId === clusterId)) throw new Error('CONVERSION_SCOPE');
  const external = externalAddresses(externalText), byIp = new Map(), members = new Map();
  const pair = (key, value) => JSON.stringify([key, value]);
  for (const vm of inventory) {
    for (const ip of vm.ips) { const list = byIp.get(ip) || []; list.push(vm); byIp.set(ip, list); }
    for (const label of vm.labels.filter(label => label.key === labelKey)) {
      const key = pair(label.key, label.value), list = members.get(key) || []; list.push(vm); members.set(key, list);
    }
  }
  const diagnostics = []; let errorCount = 0;
  const issue = (row, code) => { errorCount++; if (diagnostics.length < 200) diagnostics.push({ row, code }); };
  function endpoint(ip, row) {
    const matches = byIp.get(ip) || [];
    if (matches.length > 1) { issue(row, 'AMBIGUOUS_IP'); return null; }
    if (!matches.length) {
      if (!external.has(ip)) { issue(row, 'UNAPPROVED_EXTERNAL_IP'); return null; }
      return { type: 'ip_block', cidr: `${ip}/32` };
    }
    const vm = matches[0], labels = vm.labels.filter(label => label.key === labelKey);
    if (vm.clusterId !== clusterId) { issue(row, 'CROSS_CLUSTER_VM'); return null; }
    if (labels.length !== 1) { issue(row, 'VM_LABEL_NOT_UNIQUE'); return null; }
    const label = labels[0];
    if (members.get(pair(label.key, label.value)).some(member => member.clusterId !== clusterId)) { issue(row, 'CROSS_CLUSTER_SELECTOR'); return null; }
    return { type: 'selector', key: label.key, value: label.value };
  }
  const policies = new Map(), ruleKeys = new Map(), flows = new Set(); let acceptedRows = 0, duplicateRows = 0, ruleCount = 0;
  function add(owner, peer, direction, protocol, port) {
    if (owner.type !== 'selector') return;
    const scope = peer.type === 'selector' ? 'internal' : 'external';
    const key = JSON.stringify([owner.key, owner.value, scope]);
    if (!policies.has(key)) { ruleKeys.set(key, { ingress: new Set(), egress: new Set() }); policies.set(key, {
      name: `${owner.key}=${owner.value} / ${scope}`, mode: 'MONITOR', scope,
      applyTo: { ...owner }, communicable: false,
      memberIds: [...new Set(members.get(pair(owner.key, owner.value)).map(vm => vm.id))].sort(),
      ingress: [], egress: []
    }); }
    const rules = policies.get(key)[direction], rule = { peer: { ...peer }, protocol, ...(port ? { port } : {}) };
    const encoded = JSON.stringify(rule);
    if (!ruleKeys.get(key)[direction].has(encoded)) { ruleKeys.get(key)[direction].add(encoded); rules.push(rule); ruleCount++; }
    if (ruleCount > 20000 || policies.size > 2000) throw new Error('POLICY_SIZE_LIMIT');
  }
  for (const [index, row] of table.rows.entries()) {
    const rowNumber = index + 2, srcIp = ipv4(row[columns.srcIp].trim()), dstIp = ipv4(row[columns.dstIp].trim());
    const protocol = row[columns.protocol].trim().toUpperCase(), portText = row[columns.dstPort].trim();
    if (!srcIp || !dstIp) { issue(rowNumber, 'INVALID_IPV4'); continue; }
    if (!['TCP', 'UDP', 'ICMP'].includes(protocol)) { issue(rowNumber, 'UNSUPPORTED_PROTOCOL'); continue; }
    if (protocol === 'ICMP' ? !['', '-'].includes(portText) : !/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) { issue(rowNumber, 'INVALID_PORT'); continue; }
    const src = endpoint(srcIp, rowNumber), dst = endpoint(dstIp, rowNumber);
    if (!src || !dst) continue;
    if (src.type !== 'selector' && dst.type !== 'selector') { issue(rowNumber, 'NO_MANAGED_ENDPOINT'); continue; }
    const port = protocol === 'ICMP' ? null : Number(portText), flow = JSON.stringify([srcIp, dstIp, protocol, port]);
    acceptedRows++;
    if (flows.has(flow)) { duplicateRows++; continue; } flows.add(flow);
    add(src, dst, 'egress', protocol, port); add(dst, src, 'ingress', protocol, port);
  }
  const candidates = [...policies.values()].sort((a, b) => JSON.stringify(a.applyTo).localeCompare(JSON.stringify(b.applyTo)) || a.scope.localeCompare(b.scope));
  for (const policy of candidates) for (const direction of ['ingress', 'egress']) policy[direction].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    format: 'rivetin-policy-review-v1', pluginId: PLUGIN_ID, mode: 'MONITOR', canDeploy: false, requiresManualReview: true,
    scope: { clusterId, labelKey, grouping: 'label-pair' },
    warnings: ['REVIEW_ONLY_NOT_EVEROUTE_PAYLOAD', 'INVENTORY_AND_CAPTURE_MAY_BE_INCOMPLETE', 'SELECTORS_INCLUDE_ALL_LISTED_MEMBERS', 'ICMP_TYPE_CODE_NOT_RESTRICTED', 'NO_OBSERVATION_OR_ENFORCEMENT_VALIDATION'],
    summary: { totalRows: table.rows.length, acceptedRows, duplicateRows, uniqueFlows: flows.size, errorCount, policies: candidates.length, rules: ruleCount },
    diagnostics, policies: candidates
  };
}

export function exportReview(result, reviewed) {
  if (!reviewed || result?.format !== 'rivetin-policy-review-v1' || result.pluginId !== PLUGIN_ID || result.mode !== 'MONITOR' || result.canDeploy !== false || result.summary.errorCount || !result.policies.length) throw new Error('REVIEW_REQUIRED');
  return JSON.stringify({ ...result, reviewerAcknowledged: true }, null, 2);
}
