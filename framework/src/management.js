import { actionLabel } from './i18n.js';
import { logDetail } from './log-detail.js';
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
function newerVersion(candidate, current) {
  if (!versionPattern.test(candidate || '') || !versionPattern.test(current || '')) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export function createManagement(React) {
  const h = React.createElement;
  return function Management({ tab, records, packages, runtime, logs, onAction, onUpload, onRefresh, onMore, onCheck, updates = {}, updateChecked, busy, t, locale }) {
    const name = item => item.manifest?.name?.[locale] || item.id;
    if (tab === 'logs') return h(React.Fragment, null,
      h('div', { className: 'pk-toolbar' }, h('h3', null, t('操作日志')), h('button', { onClick: onRefresh, disabled: busy }, t('刷新'))),
      logs.items.length ? h('table', { className: 'pk-table' },
        h('thead', null, h('tr', null, ...['时间', '操作者', '操作', '对象', '结果', '内容'].map(text => h('th', { key: text }, t(text))))),
        h('tbody', null, ...logs.items.map(event => h('tr', { key: event.id }, h('td', null, new Date(event.time).toLocaleString(locale)),
          h('td', null, event.actor.name), h('td', null, actionLabel(event.action, locale)), h('td', null, event.pluginId || 'PluginKit'),
          h('td', { className: event.result === 'failed' ? 'pk-danger-text' : '' }, t({ success: '成功', failed: '失败', started: '开始' }[event.result] || event.result)),
          h('td', { className: 'pk-log-detail' }, logDetail(event, locale, actionLabel(event.action, locale)),
            h('details', null, h('summary', null, t('记录详情')), h('code', null, event.id))))))) : h('p', null, t('暂无日志')),
      logs.next && h('button', { disabled: busy, onClick: onMore }, t('加载更多')));
    return h(React.Fragment, null,
      h('div', { className: 'pk-toolbar' }, h('h3', null, 'PluginKit'), h('span', { className: `c89-badge ${runtime.enabled ? 'c89-badge-enabled' : 'c89-badge-disabled'}` }, t(runtime.enabled ? '框架运行' : '插件已全部停用'))),
      h('div', { className: 'pk-framework' }, h('span', null, `${t('版本')} ${runtime.version || '0.1.0'}`),
        h('button', { disabled: busy, className: runtime.enabled ? 'pk-emergency' : '', onClick: () => onAction(runtime.enabled ? 'framework.disable' : 'framework.enable') }, t(runtime.enabled ? '紧急禁用全部插件' : '恢复插件运行'))),
      h('div', { className: 'pk-toolbar' }, h('h3', null, t('插件管理')),
        h('button', { className: 'pk-check-updates', disabled: busy, onClick: onCheck }, t('检查更新')),
        h('label', { className: `pk-upload ${busy ? 'pk-disabled' : ''}` }, t('上传插件包'), h('input', { type: 'file', accept: '.json,application/json', disabled: busy, 'aria-label': t('上传插件包'),
          onChange: async event => { const file = event.target.files[0]; event.target.value = ''; if (file) await onUpload(file); } })),
        h('button', { disabled: busy, onClick: onRefresh }, t('刷新'))),
      h('small', { className: 'pk-muted' }, t('卸载保留配置；重置前自动备份。')),
      ...records.map(item => h('article', { key: item.id, className: 'pk-plugin-card' },
        h('div', { className: 'pk-toolbar' }, h('div', null, h('strong', null, name(item)), h('span', { className: 'pk-version' }, ` · ${t('版本')} ${item.version || '—'}`),
          updates[item.id]?.available && h('span', { className: 'c89-badge pk-new-version' }, `${t('有新版本')} ${updates[item.id].version}`)),
          h('span', { className: `c89-badge ${item.enabled && !item.active ? 'pk-badge-suspended' : item.enabled ? 'c89-badge-enabled' : 'c89-badge-disabled'}` }, t(item.installed ? item.enabled ? item.active ? '已启用' : '已暂停' : '已禁用' : '未安装'))),
        h('div', { className: 'pk-muted' }, item.id),
        updateChecked && updates[item.id] && !updates[item.id].available && h('small', { className: 'pk-muted' }, t('已是最新版本')),
        item.error && h('p', { role: 'alert' }, item.error),
        item.manifest && h('p', null, item.manifest.description[locale]),
        item.manifest && h('small', null, `${t('权限')}：${item.manifest.permissions.join(', ')}`),
        item.installed && h('div', { className: 'pk-actions' },
          h('button', { disabled: busy || Boolean(item.error), onClick: () => onAction(item.enabled ? 'disable' : 'enable', item) }, t(item.enabled ? '禁用' : '启用')),
          h('button', { className: 'pk-upgrade', disabled: busy, onClick: () => onAction('upgrade', item) }, t('升级')),
          h('button', { disabled: busy, onClick: () => onAction('reset', item) }, t('重置')),
          h('button', { disabled: busy || !item.previous, onClick: () => onAction('rollback', item) }, t('回滚')),
          h('button', { disabled: busy, className: 'pk-danger-text', onClick: () => onAction('uninstall', item) }, t('卸载'))))),
      ...packages.filter(pkg => {
        if (!pkg.manifest) return false;
        const installed = records.find(item => item.installed && item.id === pkg.manifest.id);
        return !installed || installed.packageId !== pkg.packageId && newerVersion(pkg.manifest.version, installed.version);
      }).map(pkg => {
        const installed = records.find(item => item.id === pkg.manifest.id && item.installed);
        return h('article', { key: pkg.packageId, className: 'pk-package-card' }, h('strong', null, pkg.manifest.name[locale]), ' · ', pkg.manifest.version,
          h('div', { className: 'pk-muted' }, `${t('插件包')} SHA-256: ${pkg.packageId.slice(0, 16)}…`),
          h('button', { disabled: busy, onClick: () => onAction(installed ? 'update' : 'install', { id: pkg.manifest.id }, pkg.packageId) }, t(installed ? '更新' : '安装')));
      }),
      !records.length && !packages.length && h('p', null, t('暂无插件')));
  };
}
