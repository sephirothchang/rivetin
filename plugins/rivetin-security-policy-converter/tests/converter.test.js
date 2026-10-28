import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ipv4, parseInventory, convert, exportReview } from '../src/converter.js';
import { parseCsv, mapColumns, MAX_TEXT } from '../src/csv.js';
import { sampleInventory, sampleTraffic, sampleExternal } from '../src/sample.js';
import { configuration } from '../src/configuration.js';
import { hash, validateManifest, validatePackage, validateSettings } from '../../../framework/server/manifest.js';
import { checkCompatibility } from '../../../framework/server/compatibility.js';
const input = (overrides = {}) => ({ inventoryText: JSON.stringify(sampleInventory), trafficText: sampleTraffic, externalText: sampleExternal, clusterId: 'demo-cluster', labelKey: 'application', ...overrides });
const traffic = rows => 'src_ip,dst_ip,dst_port,protocol\n' + rows.join('\n');
const inventory = fn => { const values = structuredClone(sampleInventory); fn(values); return JSON.stringify(values); };

test('sample creates exact directional rules, separates external scope, deduplicates and lists selector members', () => {
  const result = convert(input());
  assert.deepEqual(result.summary, { totalRows: 4, acceptedRows: 4, duplicateRows: 1, uniqueFlows: 3, errorCount: 0, policies: 3, rules: 4 });
  const web = result.policies.find(p => p.applyTo.value === 'web' && p.scope === 'internal');
  assert.deepEqual(web.memberIds, ['vm-web', 'vm-web-2']);
  assert.deepEqual(web.egress, [{ peer: { type: 'selector', key: 'application', value: 'database' }, protocol: 'TCP', port: 5432 }]);
  const external = result.policies.find(p => p.scope === 'external');
  assert.equal(external.ingress[0].peer.cidr, '198.51.100.5/32');
  assert.equal(external.egress[0].port, 53);
  assert.ok(result.policies.every(p => p.mode === 'MONITOR' && p.communicable === false));
  assert.equal(result.canDeploy, false);
});
test('CSV supports BOM, CRLF, quoted commas, escaped quotes and multiline cells', () => {
  const result = parseCsv('\uFEFFa,b\r\n"hello,\r\nworld","say ""hi"""\r\n');
  assert.deepEqual(result, { headers: ['a', 'b'], rows: [['hello,\r\nworld', 'say "hi"']] });
});
test('malformed CSV cannot silently skip records or guess duplicate headers', () => {
  for (const text of ['a,b\n"unfinished,b', 'a,b\n"a"junk,b', 'a,a\na,b', 'a,b\na,b,c', 'a,b\n']) assert.throws(() => parseCsv(text));
});
test('CSV limits size, columns and records', () => {
  assert.throws(() => parseCsv('a'.repeat(MAX_TEXT + 1)), /CSV_SIZE_LIMIT/);
  assert.throws(() => parseCsv(Array(41).fill('x').join(',') + '\n1'), /CSV_COLUMN_LIMIT/);
  assert.throws(() => parseCsv('a\n' + '1\n'.repeat(20001)), /CSV_ROW_LIMIT/);
});
test('column mapping uses exact names and requires four distinct columns', () => {
  assert.deepEqual(mapColumns(['源ip', '目标ip', '目标端口', '协议']), { srcIp: 0, dstIp: 1, dstPort: 2, protocol: 3 });
  assert.throws(() => mapColumns(['src_ip', 'source_ip', 'dst_ip', 'dst_port', 'protocol']), /COLUMN_MAPPING/);
  assert.throws(() => mapColumns(['a', 'b', 'c', 'd'], { srcIp: 0, dstIp: 0, dstPort: 2, protocol: 3 }), /COLUMN_MAPPING/);
  assert.deepEqual(mapColumns(['a', 'b', 'c', 'd'], { srcIp: 0, dstIp: 1, dstPort: 2, protocol: 3 }), { srcIp: 0, dstIp: 1, dstPort: 2, protocol: 3 });
});
test('custom mapping preserves direction rather than using column position', () => {
  const result = convert(input({ trafficText: 'to,proto,from,p\n192.0.2.20,TCP,192.0.2.10,5432', columnMap: { dstIp: 0, protocol: 1, srcIp: 2, dstPort: 3 } }));
  assert.equal(result.summary.rules, 2); assert.equal(result.summary.errorCount, 0);
});
test('IPv4 is strict; IPv6 and numeric suffixes are not reduced to permissive matches', () => {
  for (const ip of ['256.1.1.1', '192.00.2.1', '::1', '192.0.2.1/24', '192.0.2.1:443', '192.0.2.1x']) assert.equal(ipv4(ip), null);
  assert.equal(ipv4('192.0.2.1'), '192.0.2.1');
  assert.equal(convert(input({ trafficText: traffic(['::1,192.0.2.20,80,TCP']) })).diagnostics[0].code, 'INVALID_IPV4');
});
test('inventory rejects duplicate IDs, unexpected fields, malformed labels and invalid IPs', () => {
  for (const mutate of [v => { v[1].id = v[0].id; }, v => { v[0].password = 'not-a-secret-fixture'; }, v => { v[0].labels = ['application']; }, v => { v[0].ips = ['bad']; }]) assert.throws(() => parseInventory(inventory(mutate)), /INVENTORY_SCHEMA/);
  assert.throws(() => parseInventory('{}'), /INVENTORY_SCHEMA/);
  assert.throws(() => parseInventory('['), /INVENTORY_JSON/);
});
test('missing ports, ranges, wildcard, non-numeric ports and unknown protocols block export', () => {
  for (const [port, protocol] of [['', 'TCP'], ['0', 'UDP'], ['65536', 'TCP'], ['80-90', 'TCP'], ['*', 'UDP'], ['80x', 'TCP'], ['443', ''], ['443', 'SCTP'], ['8', 'ICMP']]) {
    const result = convert(input({ trafficText: traffic([`192.0.2.10,192.0.2.20,${port},${protocol}`]) }));
    assert.ok(result.summary.errorCount > 0); assert.throws(() => exportReview(result, true), /REVIEW_REQUIRED/);
  }
});
test('ICMP is explicit with no artificial port; type/code limitation is recorded', () => {
  const result = convert(input({ trafficText: traffic(['192.0.2.10,192.0.2.20,,ICMP']) }));
  assert.equal(result.summary.errorCount, 0); assert.equal(result.policies[0].ingress[0].port, undefined);
  assert.ok(result.warnings.includes('ICMP_TYPE_CODE_NOT_RESTRICTED'));
});
test('ambiguous IP is never resolved by VM name, order or external approval', () => {
  const result = convert(input({ inventoryText: inventory(v => { v[2].ips = ['192.0.2.10']; }), externalText: '192.0.2.10' }));
  assert.ok(result.diagnostics.some(d => d.code === 'AMBIGUOUS_IP')); assert.throws(() => exportReview(result, true));
});
test('known untagged VM cannot become an external IP', () => {
  const result = convert(input({ inventoryText: inventory(v => { v[0].labels = []; }), externalText: '192.0.2.10' }));
  assert.ok(result.diagnostics.some(d => d.code === 'VM_LABEL_NOT_UNIQUE'));
});
test('multiple label values are not arbitrarily selected', () => {
  const result = convert(input({ inventoryText: inventory(v => { v[0].labels.push({ key: 'application', value: 'other' }); }) }));
  assert.ok(result.diagnostics.some(d => d.code === 'VM_LABEL_NOT_UNIQUE'));
});
test('cross-cluster endpoint and same selector membership both block', () => {
  for (const index of [0, 2]) {
    const result = convert(input({ inventoryText: inventory(v => { v[index].clusterId = 'other-cluster'; }) }));
    assert.ok(result.diagnostics.some(d => d.code === (index === 0 ? 'CROSS_CLUSTER_VM' : 'CROSS_CLUSTER_SELECTOR')));
  }
});
test('unmatched IP requires explicit approval and only exact external /32 is generated', () => {
  const blocked = convert(input({ externalText: '' }));
  assert.ok(blocked.diagnostics.some(d => d.code === 'UNAPPROVED_EXTERNAL_IP'));
  assert.throws(() => convert(input({ externalText: '198.51.100.0/24' })), /EXTERNAL_ADDRESSES/);
  assert.ok(convert(input()).policies.flatMap(p => [...p.ingress, ...p.egress]).filter(r => r.peer.type === 'ip_block').every(r => r.peer.cidr.endsWith('/32')));
});
test('external to external traffic cannot create an unmanaged policy', () => {
  const result = convert(input({ trafficText: traffic(['198.51.100.5,203.0.113.53,80,TCP']) }));
  assert.equal(result.diagnostics[0].code, 'NO_MANAGED_ENDPOINT'); assert.equal(result.policies.length, 0);
});
test('one bad row prevents exporting even when other rows produce valid candidates', () => {
  const result = convert(input({ trafficText: sampleTraffic + '192.0.2.10,192.0.2.20,,TCP\n' }));
  assert.ok(result.policies.length > 0); assert.throws(() => exportReview(result, true));
});
test('diagnostics are bounded while total error count is retained', () => {
  const result = convert(input({ trafficText: traffic(Array(210).fill('bad,192.0.2.20,80,TCP')) }));
  assert.equal(result.summary.errorCount, 210); assert.equal(result.diagnostics.length, 200);
});
test('export requires acknowledgement, has no live payload and is stable for reordered input', () => {
  const result = convert(input()); assert.throws(() => exportReview(result, false));
  const exported = JSON.parse(exportReview(result, true));
  assert.equal(exported.reviewerAcknowledged, true); assert.equal(exported.canDeploy, false);
  for (const field of ['everoute_cluster_id', 'label_groups', 'policy_mode']) assert.equal(exportReview(result, true).includes(field), false);
  const lines = sampleTraffic.trim().split('\n');
  assert.deepEqual(convert(input({ trafficText: [lines[0], ...lines.slice(1).reverse()].join('\n') })).policies, result.policies);
});
test('configuration and manifest agree and no live Tower build is claimed', () => {
  const manifest = JSON.parse(readFileSync(new URL('../rivetin.json', import.meta.url)));
  assert.equal(validateManifest(manifest).id, configuration.id);
  assert.deepEqual(configuration.defaults(), manifest.configuration.defaults);
  assert.deepEqual(validateSettings(configuration.defaults(), manifest.configuration.schema), configuration.defaults());
  assert.throws(() => configuration.validate({ version: 1, labelKey: 'a', credential: 'fixture' }));
  assert.equal(checkCompatibility(manifest, { towerBuild: '4.9.0' }).compatible, false);
  assert.equal(manifest.compatibility.schemaVersion, 1);
  assert.deepEqual(manifest.compatibility.towerBuilds, []);
  assert.equal(checkCompatibility(manifest, { towerBuild: '4.9.0', frameworkVersion: '0.2.0' }).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
  assert.throws(() => validateManifest({ ...manifest, compatibility: { ...manifest.compatibility, schemaVersion: 2 } }), /INVALID_MANIFEST/);
});
test('review export accepts only the Rivetin draft format and current plugin ID', () => {
  const result = convert(input());
  assert.equal(result.format, 'rivetin-policy-review-v1');
  assert.equal(result.pluginId, 'rivetin-security-policy-converter');
  assert.throws(() => exportReview({ ...result, format: 'pluginkit-policy-review-v1' }, true), /REVIEW_REQUIRED/);
  assert.throws(() => exportReview({ ...result, pluginId: 'pluginkit-security-policy-converter' }, true), /REVIEW_REQUIRED/);
  assert.throws(() => exportReview({ ...result, format: 'unknown-review-v1' }, true), /REVIEW_REQUIRED/);
});
test('package contract accepts Rivetin and rejects legacy IDs, frontend and container formats', () => {
  const manifest = JSON.parse(readFileSync(new URL('../rivetin.json', import.meta.url)));
  const files = [['web/plugin.js', '/* local contract fixture */'], ['LICENSE', 'MIT fixture']].map(([path, text]) => {
    const bytes = Buffer.from(text); return { path, sha256: hash(bytes), data: bytes.toString('base64') };
  });
  const packageBytes = value => Buffer.from(JSON.stringify(value));
  assert.equal(validatePackage(packageBytes({ format: 'rivetin-package-v1', manifest, files })).manifest.id, configuration.id);
  assert.throws(() => validateManifest({ ...manifest, id: 'pluginkit-security-policy-converter' }), /INVALID_MANIFEST/);
  assert.throws(() => validateManifest({ ...manifest, frontend: { ...manifest.frontend, format: 'pluginkit-global-v1' } }), /INVALID_MANIFEST/);
  assert.throws(() => validatePackage(packageBytes({ format: 'pluginkit-package-v1', manifest, files })), /INVALID_PACKAGE/);
});
