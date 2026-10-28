import { text, collectionText, smartFailureGuidance } from './i18n.js';

const states = {
  queued: ['等待中', 'Queued'], running: ['采集中', 'Running'], succeeded: ['已完成', 'Succeeded'],
  failed: ['失败', 'Failed'], unknown: ['待确认', 'Unknown'], skipped: ['未执行', 'Skipped'],
};
const count = value => Number.isInteger(value) && value >= 0 && value <= 100 ? value : '—';
const validSummary = value => value && ['total', ...Object.keys(states)].every(key => count(value[key]) !== '—') &&
  Object.keys(states).reduce((sum, key) => sum + value[key], 0) === value.total;

// Presentation only. The confirmed framework batch contract supplies this view model.
export function createGlobalCollection(React) {
  const h = React.createElement;
  return function GlobalCollection({ locale = 'zh-CN', state = {}, onCollect, disabled = false }) {
    const t = (zh, en) => text(locale, zh, en), busy = state.status === 'running', available = typeof onCollect === 'function';
    const summary = validSummary(state.summary) ? state.summary : null, items = Array.isArray(state.items) ? state.items.slice(0, 100) : [];
    let notice;
    if (busy) notice = t('全局采集正在进行。关闭配置页只停止页面等待，后台任务可能继续。', 'Global collection is running. Closing settings only stops waiting; background work may continue.');
    else if (state.status === 'unknown') notice = state.code === 'SMART_COLLECTION_WAIT_CANCELLED'
      ? t('已停止页面等待，后台批次可能仍在执行，未自动重发请求。请核实后再发起新的采集。', 'Page waiting stopped. The background batch may still be running and was not resubmitted. Verify it before starting another collection.')
      : t('批次结果待确认，未自动重发请求。请核实后再发起新的采集。', 'The batch outcome is unknown. The request was not resent. Verify it before starting another collection.');
    else if (state.status === 'succeeded' && (!summary || summary.queued > 0 || summary.running > 0)) notice = t('批次结果信息不完整，请重新核实状态。', 'Batch result information is incomplete. Verify its status again.');
    else if (summary?.total === 0) notice = t('没有可执行的采集目标，请检查可信设备配置与审核。', 'No collection targets are available. Check trusted devices and approvals.');
    else if (state.status === 'succeeded') notice = summary && (summary.failed > 0 || summary.unknown > 0 || summary.skipped > 0)
      ? t('批次已结束，存在失败、待确认或未执行的目标，请查看逐盘结果。', 'The batch finished with failed, unknown or skipped targets. Review each disk below.')
      : t('批次采集已完成。', 'Batch collection completed.');
    else if (state.status === 'failed') notice = summary && summary.total > 0
      ? t('批次未全部成功，存在失败、待确认或未执行的目标，请查看逐盘结果。', 'The batch did not fully succeed. Review failed, unknown or skipped targets below.')
      : collectionText({ status: 'failed', code: state.code }, locale);
    return h('section', { className: 'pk-smart-global', 'aria-label': t('全局手动采集', 'Global manual collection') },
      h('h4', null, t('全局手动采集', 'Global manual collection')),
      h('p', null, t('采集所有已配置、已绑定且获授权的磁盘。未配置或未审核的目标不会执行；物理盘侧栏仍可单独采集。', 'Collect all configured, bound and authorized disks. Unconfigured or unapproved targets are not executed. Individual disks can still be collected from their sidebar.')),
      h('p', null, t('点击即发起一次采集，使用服务端已保存的目标与审核；无需保存本页设置，未保存草稿不参与采集。', 'Click to start one collection using saved server targets and approvals. No settings save is needed; unsaved drafts are not used.')),
      h('p', { className: 'pk-smart-meta' }, t('虚拟盘的本地模拟示例不计为采集成功，也不会写入真实历史。', 'Local virtual disk examples do not count as collected samples and are never written to actual history.')),
      h('button', { type: 'button', 'data-smart-collect-all': '', disabled: disabled || busy || !available, onClick: onCollect }, busy ? t('全局采集中…', 'Collecting all…') : t('全局立即采集', 'Collect all now')),
      !available && h('p', { role: 'status' }, t('当前框架尚未提供全局采集，请联系管理员更新。', 'Global collection is unavailable in this framework. Ask an administrator to update it.')),
      notice && h('p', { role: 'status', 'aria-live': 'polite' }, notice),
      items.some(item => item.status === 'failed' && ['SMART_COLLECTION_FAILED', 'SMART_EXECUTION_TIMEOUT', 'SMART_OUTPUT_INVALID', 'SMART_INVALID_DATA'].includes(item.code)) && h('p', { className: 'pk-smart-meta' }, smartFailureGuidance(locale)),
      summary && h('dl', { className: 'pk-smart-batch-summary', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '12px', margin: '16px 0' } },
        ...[['total', t('目标总数', 'Total targets')], ...Object.entries(states).map(([key, labels]) => [key, t(...labels)])].map(([key, label]) =>
          h('div', { key }, h('dt', null, label), h('dd', { style: { margin: '4px 0 0', fontSize: '18px', fontWeight: 600 } }, String(count(summary[key])))))),
      items.length > 0 && h('div', { className: 'pk-smart-scroll' }, h('table', { className: 'pk-smart-table' },
        h('thead', null, h('tr', null, ...[t('磁盘', 'Disk'), t('采集状态', 'Collection status'), t('说明', 'Details')].map(label => h('th', { key: label, scope: 'col' }, label)))),
        h('tbody', null, ...items.map((item, index) => h('tr', { key: item.key || String(index) },
          h('td', null, typeof item.label === 'string' ? item.label.slice(0, 200) : t('未知目标', 'Unknown target')),
          h('td', null, states[item.status] ? t(...states[item.status]) : t('待确认', 'Unknown')),
          h('td', null, item.code ? collectionText({ status: item.status === 'unknown' ? 'unknown' : 'failed', code: item.code }, locale) : '—')))))));
  };
}
