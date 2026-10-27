import { translator, vendorLabel } from '../../../framework/src/i18n.js';
import React from 'react';
import { VENDORS, MAX_BMC_RULES } from './bmc-profiles.js';
import { BmcCatalog } from './bmc-catalog.js';
import { LICENSE_ID, LICENSE_URL, REPOSITORY_URL } from './identity.js';
const h = React.createElement;
export function BmcSettings({ preferences, store, inventory, onReload, locale = 'zh-CN', t = translator(locale) }) {
  function vendorOptions() {
    const generic = VENDORS.find(vendor => vendor.id === 'generic');
    return [h('option', { key: generic.id, value: generic.id }, vendorLabel(generic, locale)),
      h('option', { key: 'vendor-separator', value: '__separator', disabled: true, 'aria-hidden': true }, '────────────────────'),
      ...VENDORS.filter(vendor => vendor.id !== 'generic').map(vendor => h('option', { key: vendor.id, value: vendor.id }, vendorLabel(vendor, locale)))];
  }
  function updateRule(id, patch) { store.update({ bmcExceptions: preferences.bmcExceptions.map(rule => rule.id === id ? { ...rule, ...patch } : rule) }); }
  return h('section', { className: 'c89-bmc-settings', 'aria-label': t('BMC 全局与例外') },
    h('div', { className: 'c89-section-heading' }, h('h3', null, t('BMC 全局与例外'))),
    h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' },
      h('label', { htmlFor: 'c89-default-vendor' }, t('全局默认厂商协议')),
      h('select', { id: 'c89-default-vendor', value: preferences.defaultVendor,
        onChange: e => store.update({ defaultVendor: e.target.value }) }, vendorOptions())),
      h('small', null, t('未命中例外时使用此配置。'))),
    h('div', { className: 'c89-exception-heading' }, h('strong', null, t('例外规则'), ' ',
      h('span', { className: 'c89-disclaimer c89-rule-help' },
        h('button', { type: 'button', className: 'c89-disclaimer-icon', 'aria-label': t('规则优先级', 'Rule priority'), 'aria-describedby': 'pk-bmc-priority' },
          h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 11v6M12 7v1' }))),
        h('span', { className: 'c89-disclaimer-popup', id: 'pk-bmc-priority', role: 'tooltip' }, t('优先级：主机例外 → 集群例外 → 全局默认。空对象规则不生效。')))),
      h('button', { className: 'c89-add-rule', disabled: preferences.bmcExceptions.length >= MAX_BMC_RULES,
        onClick: () => store.update({ bmcExceptions: [...preferences.bmcExceptions,
          { id: window.crypto.randomUUID(), scope: 'cluster', targetId: '', vendor: preferences.defaultVendor }] }) }, t('+ 添加例外'))),
    inventory.loading && h('p', { role: 'status' }, t('正在读取可见的集群与主机…')),
    inventory.error && h('p', { role: 'alert' }, t(inventory.error), ' ', h('button', { className: 'c89-text-button', onClick: onReload }, t('重试'))),
    !preferences.bmcExceptions.length && h('div', { className: 'c89-empty-rules' }, t('尚无例外。所有主机继承全局默认。')),
    ...preferences.bmcExceptions.map((rule, index) => {
      const objects = rule.scope === 'cluster' ? inventory.clusters : inventory.hosts;
      const used = new Set(preferences.bmcExceptions.filter(other => other.id !== rule.id && other.scope === rule.scope).map(other => other.targetId));
      return h('div', { className: 'c89-rule', key: rule.id },
        h('div', { className: 'c89-rule-top' }, h('span', null, t(`例外 ${index + 1}`, `Exception ${index + 1}`)),
          h('button', { className: 'c89-remove-rule', 'aria-label': t(`删除例外 ${index + 1}`, `Delete exception ${index + 1}`), title: t('删除例外'),
            style: { color: '#d9363e', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 4, borderRadius: 5 },
            onClick: () => store.update({ bmcExceptions: preferences.bmcExceptions.filter(other => other.id !== rule.id) }) },
          h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
            h('path', { d: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6' })))),
        h('div', { className: 'c89-rule-fields' },
          h('label', null, t('范围'), h('select', { 'aria-label': t(`例外 ${index + 1} 范围`, `Exception ${index + 1} scope`), value: rule.scope,
            onChange: e => updateRule(rule.id, { scope: e.target.value, targetId: '' }) }, h('option', { value: 'cluster' }, t('集群')), h('option', { value: 'host' }, t('特定主机')))),
          h('label', null, t(rule.scope === 'cluster' ? '集群' : '主机'), h('select', { 'aria-label': t(`例外 ${index + 1} 对象`, `Exception ${index + 1} target`), value: rule.targetId,
            onChange: e => updateRule(rule.id, { targetId: e.target.value }) }, h('option', { value: '' }, rule.scope === 'cluster' ? t('选择集群') : t('选择主机')),
          rule.targetId && !objects.some(value => value.id === rule.targetId) && h('option', { value: rule.targetId }, t('原配置对象暂不可见')),
          ...objects.map(value => h('option', { key: value.id, value: value.id, disabled: used.has(value.id) }, value.name)))),
          h('label', null, t('厂商协议'), h('select', { 'aria-label': t(`例外 ${index + 1} 厂商协议`, `Exception ${index + 1} protocol`), value: rule.vendor,
            onChange: e => updateRule(rule.id, { vendor: e.target.value }) }, vendorOptions()))));
    }),
    h(BmcCatalog, { locale, t }),
    h('div', { className: 'c89-project-meta' },
      h('a', { href: REPOSITORY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'),
      h('span', { 'aria-hidden': true }, '·'),
      h('a', { href: LICENSE_URL, target: '_blank', rel: 'noopener noreferrer' }, `${LICENSE_ID} License`)));
}
