import { normalizeSmart, compareMetrics, highestRisk } from './smart.js';

export const isVirtualDiskModel = model => typeof model === 'string' && /^(?:VMware|Virtual[_ ]disk)/i.test(model.trimStart());

// Presentation data only: no collection identity, generation or real sample time.
export function createVirtualDemo(inventory, now = Date.now()) {
  if (!inventory || typeof inventory.diskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(inventory.diskId) || !isVirtualDiskModel(inventory.model)) throw new Error('VIRTUAL_DEMO_MODEL_UNVERIFIED');
  const nvme = /nvme/i.test(inventory.model);
  const raw = { smartctl: { exit_status: 0 }, smart_status: { passed: true }, temperature: { current: 35 }, power_on_time: { hours: 2400 },
    ...(nvme ? { nvme_smart_health_information_log: { critical_warning: 0, available_spare: 100, available_spare_threshold: 10, percentage_used: 12, media_errors: 0 } }
      : { device: { protocol: 'ATA' }, ata_smart_attributes: { table: [
        { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, raw: { value: 0 } },
        { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw: { value: 0 } },
        { id: 199, name: 'UDMA_CRC_Error_Count', value: 200, worst: 200, thresh: 0, raw: { value: 0 } },
      ] } }) };
  const normalized = normalizeSmart(raw), metrics = compareMetrics(normalized.metrics, null);
  return { virtualDemo: true, inventory: { diskId: inventory.diskId, model: inventory.model.slice(0, 160) },
    example: { ...normalized, metrics, risk: highestRisk(metrics.map(metric => metric.risk)), status: 'ok', source: 'local-virtual-demo', generatedAt: new Date(now).toISOString() },
    hasMore: false };
}
