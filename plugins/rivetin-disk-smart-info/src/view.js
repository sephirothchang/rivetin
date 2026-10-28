import { text, metricName, riskName, reasonText, errorText, gapText, collectionText, smartFailureGuidance } from './i18n.js';
import { withBaseline } from './provider.js';
function element(doc, tag, content, className) {
  const node = doc.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node;
}
export function renderPanel(panel, state, locale, refresh, loadMore, selectSample, collectNow) {
  const doc = panel.ownerDocument, t = (zh, en) => text(locale, zh, en), add = (tag, value, cls, parent = panel) => { const node = element(doc, tag, value, cls); parent.append(node); return node; };
  panel.replaceChildren(); panel.lang = locale;
  const card = add('div', undefined, 'pk-smart-card'), header = add('div', undefined, 'pk-smart-summary', card);
  add('h3', t('Smart 信息', 'SMART information'), '', header);
  const busy = state.collection?.status === 'running', virtual = state.result?.virtualDemo === true;
  const actions = add('div', undefined, 'pk-smart-actions', header);
  const retry = add('button', virtual ? t('刷新示例', 'Refresh example') : t('重新读取', 'Reload'), '', actions); retry.type = 'button'; retry.disabled = Boolean(state.loading || state.historyLoading || busy); retry.addEventListener('click', refresh);
  const collect = add('button', busy ? t('采集中…', 'Collecting…') : t('立即采集', 'Collect now'), '', actions);
  collect.type = 'button'; collect.dataset.smartCollect = ''; collect.disabled = Boolean(state.loading || state.historyLoading || busy || !state.result?.identity || !state.canCollect); collect.addEventListener('click', collectNow);
  add('p', virtual ? t('虚拟盘演示不执行真实采集；刷新只重新核验型号并生成本地示例。', 'Virtual disk demonstrations do not collect from a host. Refresh only verifies the model and generates local examples.') : t('重新读取只刷新已有采样；立即采集需已配置可信设备并完成人工审核。', 'Reload only reads existing samples. Collect now requires a trusted device and explicit administrator approval.'), 'pk-smart-meta', card);
  if (!state.canCollect && !virtual) add('p', collectionText({ status: 'failed', code: 'SMART_COLLECTION_UNAVAILABLE' }, locale), 'pk-smart-meta', card);
  if (state.collection) add('p', collectionText(state.collection, locale), 'pk-smart-notice pk-smart-collection', card).setAttribute('role', 'status');
  if (state.loading) { add('p', t('正在核验磁盘身份并读取数据…', 'Verifying disk identity and loading…'), '', card); return; }
  if (state.error) { add('p', errorText(state.error, locale), 'pk-smart-notice', card).setAttribute('role', 'status'); return; }
  const result = state.result; if (!result) return;
  const identity = virtual ? result.inventory : result.identity;
  const selected = virtual ? null : result.history.find(item => item.collectedAt === state.selectedAt);
  const { sample: latest, previous } = virtual ? { sample: result.example, previous: null } : withBaseline(selected || result.latest, result.history);
  add('p', identity.model || '—', 'pk-smart-meta', card);
  add('p', virtual ? t('虚拟磁盘模拟示例', 'Virtual disk demonstration') : selected ? t('正在查看历史采样', 'Viewing a historical sample') : t('最近采集结果', 'Latest collection result'), 'pk-smart-meta', card);
  if (virtual) add('p', t('虚拟磁盘模拟示例 · 以下数值为本地构造，非该盘实际 SMART、健康或寿命数据。真实健康状态未知；示例不写入采样历史。', 'VIRTUAL DISK EXAMPLE · Values below are generated locally, not this disk’s actual SMART, health or endurance data. Real health is unknown. Examples are not stored in sample history.'), 'pk-smart-banner pk-smart-virtual-banner', card).setAttribute('role', 'status');
  if (latest.source === 'mock') add('p', t('本地模拟数据 · 未连接真实主机 · 未启用每日采集', 'Local mock data · No live host connected · Daily collection is inactive'), 'pk-smart-banner', card);
  if (['unavailable', 'unsupported'].includes(latest.status)) {
    add('p', latest.status === 'unsupported' ? t('该设备不支持 SMART 或未透传；健康状态未知。', 'SMART is unsupported or not passed through; health is unknown.') : errorText(latest.code, locale), 'pk-smart-notice', card);
    if (latest.collectedAt) add('p', `${t('采集尝试时间（UTC）', 'Collection attempt (UTC)')}: ${latest.collectedAt}`, 'pk-smart-meta', card);
    if (latest.code !== 'SMART_NO_SAMPLE') add('p', smartFailureGuidance(locale), 'pk-smart-meta pk-smart-failure-guidance', card);
  } else {
    if (latest.gapCode) add('p', gapText(latest.gapCode, locale), 'pk-smart-notice pk-smart-recovered', card).setAttribute('role', 'status');
    add('span', `${virtual ? t('示例风险（非真实判断）', 'Example risk (not an actual assessment)') : t('展示风险', 'Display risk')}: ${riskName(latest.risk, locale)}`, `pk-smart-pill pk-smart-risk-${latest.risk}`, card);
    add('p', `${virtual ? t('示例生成时间（非采集时间，UTC）', 'Example generated (not collected, UTC)') : t('采样时间（UTC）', 'Sample time (UTC)')}: ${virtual ? latest.generatedAt : latest.collectedAt}`, 'pk-smart-meta', card);
    add('p', `${latest.protocol} · ${t('数据来源', 'Source')}: ${latest.source}`, 'pk-smart-meta', card);
    if (latest.status === 'stale') add('p', t('数据已过期（超过 36 小时或采集服务标记过期），无法据此判断当前健康状态。', 'Data is stale (over 36 hours old or marked stale by the provider); current health cannot be determined.'), 'pk-smart-notice', card);
    add('p', virtual ? t('示例不与真实历史对比，不计算该盘实际劣化。', 'Examples are not compared with real history and do not measure this disk’s actual deterioration.') : previous ? `${t('变化对比上一有效采样', 'Changes since previous valid sample')}: ${previous.collectedAt}` : t('无上一有效采样，尚不能计算劣化。', 'No previous valid sample; deterioration cannot yet be calculated.'), 'pk-smart-meta', card);
    if (result.historyUnavailable) add('p', t('历史读取失败，当前值仍可查看；未计算劣化。', 'History could not be loaded. Current values remain available; deterioration was not calculated.'), 'pk-smart-notice', card);
    add('h4', virtual ? t('SMART 模拟示例条目', 'Example SMART metrics') : t('SMART 条目 · 风险优先', 'SMART metrics · Risks first'));
    const scroll = add('div', undefined, 'pk-smart-scroll'), table = add('table', undefined, 'pk-smart-table', scroll);
    const thead = add('thead', undefined, '', table), tr = add('tr', undefined, '', thead);
    for (const name of [t('条目 / 原始名称', 'Metric / original name'), t('当前值', 'Current'), t('变化 / 劣化', 'Change / deterioration'), t('风险与依据', 'Risk and reason')]) add('th', name, '', tr).scope = 'col';
    const tbody = add('tbody', undefined, '', table);
    const ranks = { darkred: 4, red: 3, yellow: 2, unknown: 1, normal: 0 };
    for (const metric of [...latest.metrics].sort((a, b) => ranks[b.risk] - ranks[a.risk])) {
      const row = add('tr', undefined, `pk-smart-risk-${metric.risk}`, tbody);
      row.dataset.metric = metric.id;
      const name = add('td', metricName(metric.name, locale), '', row); add('span', `${metric.id} · ${metric.name}`, 'pk-smart-code', name);
      const shown = metric.id === 'health' ? metric.value === '1' ? t('通过', 'Passed') : t('失败', 'Failed') : `${metric.value ?? (metric.rawText || '—')}${metric.value === null ? '' : metric.unit}`;
      const value = add('td', shown, '', row);
      if (metric.normalized !== undefined) add('span', `${t('归一化 / 最差 / 阈值', 'Normalized / worst / threshold')}: ${metric.normalized ?? '—'} / ${metric.worst ?? '—'} / ${metric.threshold ?? '—'}`, 'pk-smart-code', value);
      else if (metric.threshold !== undefined) add('span', `${t('设备阈值', 'Device threshold')}: ${metric.threshold ?? '—'}%`, 'pk-smart-code', value);
      const unit = metric.unit === '%' ? t(' 个百分点', ' percentage points') : metric.unit ? ` ${metric.unit}` : '';
      const change = add('td', metric.delta === null ? '—' : `${BigInt(metric.delta) > 0n ? '+' : ''}${metric.delta}${unit}`, '', row);
      if (metric.deterioration !== null) add('span', `${t('劣化', 'Deteriorated')}: ${metric.deterioration}${metric.deteriorationKind === 'normalized' ? t(' 归一化点', ' normalized points') : unit}`, 'pk-smart-code', change);
      if (metric.trend === 'counter-reset') add('span', t('计数下降：可能重置；不当作改善', 'Counter decreased: possible reset; not treated as improvement'), 'pk-smart-code', change);
      const status = add('td', riskName(metric.risk, locale), '', row); add('span', reasonText(metric.reason, locale), 'pk-smart-code', status);
    }
    }
    if (virtual) {
      add('p', t('本页未读取或写入真实采样历史，示例不计为全局批次采集成功。全局采集仍只操作已绑定、已审核的真实目标。', 'This page did not read or write actual sample history. Examples do not count as successful global batch collections. Global collection still uses bound, approved real targets.'), 'pk-smart-meta');
      return;
    }
    add('h4', t('最近采样记录', 'Recent samples'));
    if (result.historyUnavailable && !latest.metrics.length) add('p', t('历史读取失败，请重新读取。', 'History could not be loaded. Reload to retry.'), 'pk-smart-notice');
    const latestButton = add('button', t('查看最近结果', 'View latest result')); latestButton.type = 'button'; latestButton.disabled = !selected; latestButton.onclick = () => selectSample(null);
    if (!result.history.length) add('p', t('暂无历史记录。', 'No history is available.'), 'pk-smart-meta');
    else {
    const list = add('ul', undefined, 'pk-smart-meta pk-smart-history');
      for (const item of result.history) {
        const row = add('li', undefined, '', list), sample = withBaseline(item, result.history).sample;
        const label = item.metrics.length ? riskName(sample.risk, locale) : item.status === 'unsupported' ? t('不支持 · 健康未知', 'Unsupported · Health unknown') : t('采集失败 · 健康未知', 'Collection failed · Health unknown');
      const recovered = item.gapCode ? t(' · 当日采集已恢复', ' · Collection recovered that day') : '';
      const button = add('button', `${item.collectedAt} · ${label}${recovered}`, '', row); button.type = 'button'; button.dataset.sampleTime = item.collectedAt;
        button.setAttribute('aria-pressed', String(item.collectedAt === state.selectedAt)); button.onclick = () => selectSample(item.collectedAt);
      }
    }
    if (state.historyError) add('p', errorText(state.historyError, locale), 'pk-smart-notice').setAttribute('role', 'status');
    if (result.hasMore) {
      const more = add('button', state.historyLoading ? t('读取中…', 'Loading…') : t('读取更早记录', 'Load older samples'));
    more.type = 'button'; more.dataset.smartMore = ''; more.disabled = Boolean(state.historyLoading || state.historyError || busy); more.onclick = loadMore;
    }
    add('p', `${t('已读取记录', 'Loaded records')}: ${result.history.length} / 365 · ${t('仅比较同一物理盘的有效采样；失败日不作基线。', 'Only valid samples from this disk generation are compared; failed days are excluded as baselines.')}`, 'pk-smart-meta');
    add('p', t('提示策略：NVMe 已用寿命 ≥80% 黄、≥90% 红、≥100% 深红；设备健康失败、严重警告或当前阈值越界为深红。错误计数和劣化另见条目依据。颜色用于辅助排查，不代表故障预测。厂商属性不通用推算寿命；温度、错误日志数和非正常关机数仅展示。', 'Display policy: NVMe endurance used ≥80% yellow, ≥90% red, ≥100% dark red. Failed health, critical warnings or current device threshold failures are dark red. See row reasons for errors and deterioration. Colors aid investigation and do not predict failures. Vendor attributes do not imply a universal lifespan. Temperature, error log entries and unsafe shutdowns are informational.'), 'pk-smart-policy');
  }
