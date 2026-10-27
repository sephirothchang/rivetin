import { translator, vendorLabel } from '../../../framework/src/i18n.js';
import React, { useState } from 'react';
import catalog from '../data/hcl-catalog.json' with { type: 'json' };
import { BMC_VENDORS } from './vendor-registry.js';
const h = React.createElement;
export function BmcCatalog({ locale = 'zh-CN', t = translator(locale) } = {}) {
  const [vendorId, setVendorId] = useState('all');
  const vendors = BMC_VENDORS.filter(value => value.brand);
  const selected = vendors.find(value => value.id === vendorId);
  const records = catalog.records.filter(value => vendorId === 'all' || value.vendorId === vendorId);
  return h('details', { className: 'c89-catalog' },
    h('summary', null, t(`厂商接口与兼容机型 · ${catalog.brandCount} 家厂商 / ${catalog.recordCount} 条记录`, `Vendor APIs and models · ${catalog.brandCount} vendors / ${catalog.recordCount} records`)),
    h('div', { className: 'c89-catalog-body' },
      h('label', { htmlFor: 'c89-catalog-vendor' }, t('查阅厂商')),
      h('select', { id: 'c89-catalog-vendor', value: vendorId, onChange: event => setVendorId(event.target.value) },
        h('option', { value: 'all' }, t('全部厂商')), ...vendors.map(value => h('option', { key: value.id, value: value.id }, value.brand))),
      h('p', null, selected ? (selected.api ? t('Redfish 会话接口已实现。') : t('已收录兼容机型，当前提供登录页跳转。')) : t('服务器清单来自 SmartX 兼容性列表，BMC 协议支持需结合实际控制器与固件确认。')),
      selected?.coverageNote && h('p', null, (locale === 'en-US' ? selected.coverageNoteEn || 'Check controller generation, firmware and feature support against the vendor documentation.' : selected.coverageNote)),
      selected?.document && h('a', { href: selected.document, target: '_blank', rel: 'noopener noreferrer' }, t('厂商公开接口文档 ↗')),
      h('ul', { 'aria-label': t('兼容服务器型号') }, ...records.map(record => h('li', { key: record.id },
        vendorId === 'all' ? `${record.brand} · ${record.model}` : record.model))),
      h('small', null, t(`资料快照：${catalog.snapshotDate} · ${records.length} 条型号记录 · `, `Snapshot: ${catalog.snapshotDate} · ${records.length} models · `),
        h('a', { href: catalog.sourcePage, target: '_blank', rel: 'noopener noreferrer' }, t('SmartX 兼容性列表 ↗')))));
}
