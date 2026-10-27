import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BMC_VENDORS } from '../src/vendor-registry.js';
const sourceUrl = 'https://oocgate.smartx.com/api/hcl/servers?product=SMTXOS&locale=ZH_CN';
const rawPath = new URL('../research/smartx-servers-raw.json', import.meta.url);
const refresh = process.argv.includes('--refresh');
let raw = await readFile(rawPath);
if (refresh) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('HCL_DOWNLOAD_FAILED');
  raw = Buffer.from(await response.arrayBuffer());
}
const payload = JSON.parse(raw);
if (!payload.success || payload.total !== payload.data?.length || !payload.data.length) throw new Error('HCL_INCOMPLETE');
const ids = new Set(), records = payload.data.map(item => {
  const vendor = BMC_VENDORS.find(value => value.brand === item.brand?.name);
  if (!vendor || !item.id || !item.name || ids.has(item.id)) throw new Error('HCL_SCHEMA_OR_VENDOR_CHANGED');
  ids.add(item.id);
  return { id: item.id, brand: item.brand.name, vendorId: vendor.id, model: item.name,
    aliases: item.aliases, active: item.isActive };
});
const catalog = {
  sourcePage: 'https://www.smartx.com/smtxos-compatibility/?tab=0', sourceUrl,
  snapshotDate: refresh ? new Date().toISOString().slice(0, 10) : '2026-10-27',
  sha256: createHash('sha256').update(raw).digest('hex'), product: 'SMTXOS',
  brandCount: new Set(records.map(item => item.brand)).size, recordCount: records.length, records,
};
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
if (refresh) await writeFile(rawPath, raw);
await writeFile(new URL('../data/hcl-catalog.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
const csv = value => '"' + String(value).replaceAll('"', '""') + '"';
await writeFile(new URL('../data/hcl-models.csv', import.meta.url), '\ufeff' +
  [['厂商', '服务器型号', '协议标识', 'HCL 记录 ID', '设备实测'],
    ...records.map(item => [item.brand, item.model, item.vendorId, item.id, '尚未验证'])]
    .map(row => row.map(csv).join(',')).join('\r\n') + '\r\n');
console.log(`HCL: ${catalog.brandCount} brands / ${records.length} records; SHA256 ${catalog.sha256}`);
