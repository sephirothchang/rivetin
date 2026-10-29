import { parseCsv, MAX_TEXT } from './csv.js';
import { message } from './i18n.js';

export const CSS = `
.pksp{color:#20314d;font:14px/1.6 system-ui,sans-serif;max-width:1100px;margin:auto}.pksp *{box-sizing:border-box}.pksp h2,.pksp h3{margin:12px 0}.pksp p{margin:8px 0}.pksp .pksp-banner{border-left:4px solid #187bb5;background:#eff8ff;padding:12px 16px}.pksp .pksp-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pksp label{display:block;font-weight:600;margin:12px 0 6px}.pksp textarea,.pksp input[type=text],.pksp select{font:13px/1.5 ui-monospace,monospace;width:100%;border:1px solid #c4d1df;border-radius:5px;padding:8px;background:white;color:#20314d}.pksp textarea{min-height:170px;resize:vertical}.pksp .pksp-small{min-height:86px}.pksp button{padding:8px 14px;border:1px solid #bacddd;border-radius:5px;background:white;color:#16416a;cursor:pointer}.pksp button.pksp-primary{background:#1468a0;color:white}.pksp button:disabled{opacity:.45;cursor:default}.pksp .pksp-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}.pksp .pksp-hint{font-size:12px;color:#536980}.pksp .pksp-warning{padding:12px;background:#fff8e7;border:1px solid #e9d19c;border-radius:5px}.pksp .pksp-error{color:#9f2020}.pksp .pksp-card{padding:14px;border:1px solid #dae3ed;border-radius:8px;margin:14px 0;background:white}.pksp table{width:100%;border-collapse:collapse;font-size:12px}.pksp th,.pksp td{text-align:left;padding:8px;border-bottom:1px solid #e0e8f0;vertical-align:top;overflow-wrap:anywhere}.pksp .pksp-scroll{overflow:auto}.pksp .pksp-check{font-weight:400;display:flex;gap:8px;align-items:flex-start}.pksp pre{font:12px/1.5 ui-monospace,monospace;overflow:auto;max-height:220px;background:#f4f7fa;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}.pksp a{color:#1264a1}.pksp input[type=file]{max-width:100%;font-size:12px}.pksp :focus-visible{outline:3px solid #3b9bc8;outline-offset:2px}@media(max-width:720px){.pksp .pksp-grid{grid-template-columns:1fr}.pksp th,.pksp td{padding:5px}}
`;

export function createWorkbench(React, win, session) {
  const h = React.createElement;
  return function Workbench({ locale = 'zh-CN', savedLabelKey, surface = 'settings' }) {
    const [, render] = React.useState(0), [page, setPage] = React.useState(0);
    React.useEffect(() => session.subscribe(() => render(value => value + 1)), []);
    const state = session.view(), en = locale === 'en-US', t = (zh, english) => en ? english : zh;
    let headers = []; try { headers = parseCsv(state.trafficText).headers; } catch { /* Detailed errors are shown on conversion. */ }
    const textInput = (key, label, multiline = true, extra = {}) => h('label', { key }, label,
      h(multiline ? 'textarea' : 'input', { 'data-field': key, ...(multiline ? {} : { type: 'text' }), value: state[key], maxLength: key === 'externalText' ? 20000 : multiline ? MAX_TEXT : 160,
        onChange: event => session.set({ [key]: event.target.value, ...(key === 'trafficText' ? { columnMap: {} } : {}) }), ...extra }));
    async function readFile(event, field) {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const ticket = session.beginRead();
      if (file.size > MAX_TEXT) { session.failRead(ticket); return; }
      try { const text = await file.text(); session.finishRead(ticket, field, text); } catch { session.failRead(ticket); }
    }
    function download() {
      const text = session.export(), blob = new win.Blob([text], { type: 'application/json;charset=utf-8' });
      const url = win.URL.createObjectURL(blob), link = win.document.createElement('a');
      link.href = url; link.download = 'security-policy-review.json';
      win.document.body.append(link); link.click(); link.remove(); win.URL.revokeObjectURL(url);
    }
    const result = state.result, pages = Math.max(1, Math.ceil((result?.policies.length || 0) / 100)), currentPage = Math.min(page, pages - 1);
    return h('div', { className: 'pksp', lang: locale }, h('style', null, CSS),
      h('div', { className: 'pksp-banner' }, h('h2', null, t(surface === 'workpage' ? '安全策略转换' : '安全策略自动转化工具', 'Security policy converter')),
        h('strong', null, t('离线预览 · 无真实下发', 'Offline preview · No live deployment')),
        h('p', null, t('导入清单与流量 → 检查匹配 → 审查 MONITOR 候选策略 → 导出审查稿', 'Import inventory and traffic → Check identity → Review MONITOR candidates → Export review draft'))),
      h('p', { className: 'pksp-hint' }, surface === 'workpage' ?
        t('所有导入数据只保留在当前工作页内存。离开时选择“丢弃并退出”、停用插件或刷新页面会清除；取消离开会保留。请先脱敏。此版本没有登录、AI 外发、标签写入或策略下发功能。', 'Imported data stays in this workpage memory and is cleared by discarding this workpage, stopping the plugin or reloading. Cancelling navigation keeps it. Redact before use. This version has no login, AI requests, label writes or policy deployment.') :
        t('所有导入数据只保留在本页内存，关闭插件面板、停用或刷新会清除。请先脱敏。此版本没有登录、AI 外发、标签写入或策略下发功能。', 'Imported data stays in page memory and is cleared when the panel closes, the plugin stops or the page reloads. Redact before use. This version has no login, AI requests, label writes or policy deployment.')),
      h('div', { className: 'pksp-actions' }, h('button', { type: 'button', 'data-action': 'sample', onClick: () => session.sample() }, t('载入脱敏演示', 'Load redacted sample')),
        h('button', { type: 'button', 'data-action': 'clear', onClick: () => session.set({ inventoryText: '', trafficText: '', clusterId: '', externalText: '', columnMap: {} }) }, t('清空输入', 'Clear inputs'))),
      h('div', { className: 'pksp-grid' },
        h('section', null, h('h3', null, t('1. VM 清单与人工标签', '1. VM inventory and manual labels')),
          textInput('inventoryText', t('清单 JSON', 'Inventory JSON')),
          h('label', null, t('选择 JSON 文件', 'Choose JSON file'), h('input', { type: 'file', accept: '.json,application/json', onChange: event => readFile(event, 'inventoryText') })),
          h('p', { className: 'pksp-hint' }, t('每条记录必须包含 id、name、clusterId、ips、labels。点击演示查看格式；可在 JSON 中人工编辑标签。', 'Each record needs id, name, clusterId, ips and labels. Load the sample to see the format; labels can be edited manually in JSON.'))),
        h('section', null, h('h3', null, t('2. 流量 CSV', '2. Traffic CSV')),
          textInput('trafficText', t('流量内容', 'Traffic content')),
          h('label', null, t('选择 CSV 文件', 'Choose CSV file'), h('input', { type: 'file', accept: '.csv,text/csv', onChange: event => readFile(event, 'trafficText') })),
          h('p', { className: 'pksp-hint' }, t('推荐列名 src_ip,dst_ip,dst_port,protocol。TCP/UDP 单端口，ICMP 端口留空。暂支持 IPv4。', 'Recommended headers: src_ip,dst_ip,dst_port,protocol. TCP/UDP requires one port; leave ICMP port empty. IPv4 only.')))),
      headers.length > 0 && h('div', { className: 'pksp-grid' }, ...[['srcIp', '源 IP', 'Source IP'], ['dstIp', '目标 IP', 'Destination IP'], ['dstPort', '目标端口', 'Destination port'], ['protocol', '协议', 'Protocol']].map(([key, zh, english]) =>
        h('label', { key }, t(zh, english), h('select', { 'aria-label': t(zh, english), value: state.columnMap[key] ?? '', onChange: event => {
          const next = { ...state.columnMap }; if (event.target.value === '') delete next[key]; else next[key] = Number(event.target.value); session.set({ columnMap: next });
        } }, h('option', { value: '' }, t('按标题自动识别', 'Detect from header')), ...headers.map((header, index) => h('option', { key: index, value: index }, header)))))),
      h('div', { className: 'pksp-grid' }, textInput('clusterId', t('清单中的集群 ID（不是 Everoute ID）', 'Inventory cluster ID (not an Everoute ID)'), false),
        textInput('externalText', t('人工确认的外部 IPv4（每行一个）', 'Manually confirmed external IPv4 (one per line)'), true, { className: 'pksp-small' })),
      h('p', { className: 'pksp-warning' }, t(`已保存的标签键：${savedLabelKey}。按标签键值对生成策略，所有清单内同值 VM 都进入选择器；组内互信固定关闭。未匹配 IP 必须核实为外部地址，不能用外部声明绕过已知 VM 的标签或集群问题。`, `Saved label key: ${savedLabelKey}. Policies use label pairs and include every listed VM sharing that pair; group trust is off. Verify unmatched IPs before declaring them external. External declarations cannot bypass known VM label or cluster errors.`)),
      h('div', { className: 'pksp-actions' }, h('button', { type: 'button', className: 'pksp-primary', 'data-action': 'convert', onClick: () => { setPage(0); session.run(); } }, t('检查并生成候选策略', 'Check and generate candidates'))),
      state.error && h('p', { role: 'alert', className: 'pksp-error' }, message(locale, state.error)),
      result && h('section', { className: 'pksp-card', 'aria-label': t('审查结果', 'Review result') }, h('h3', null, t('3. 候选策略审查', '3. Candidate policy review')),
        h('p', { role: 'status', 'data-summary': true }, t(`共 ${result.summary.totalRows} 行，${result.summary.uniqueFlows} 条唯一流量，${result.summary.duplicateRows} 行重复；${result.summary.policies} 个候选策略，${result.summary.rules} 条规则；${result.summary.errorCount} 个阻断项。`, `${result.summary.totalRows} rows, ${result.summary.uniqueFlows} unique flows, ${result.summary.duplicateRows} duplicate rows; ${result.summary.policies} candidate policies, ${result.summary.rules} rules; ${result.summary.errorCount} blocking issues.`)),
        result.summary.errorCount > 0 && h('div', { className: 'pksp-error', role: 'alert' }, h('p', null, t('存在阻断项，禁止导出。以下最多显示 200 项；行号为 CSV 逻辑记录行号。', 'Export is blocked. Showing up to 200 issues; row numbers refer to logical CSV records.')),
          ...result.diagnostics.map((item, index) => h('div', { key: index }, `${item.row}: ${message(locale, item.code)}`))),
        h('div', { className: 'pksp-scroll' }, h('table', null, h('thead', null, h('tr', null, ...[t('选择器 / 范围', 'Selector / scope'), t('成员 ID', 'Member IDs'), t('入站 / 出站规则', 'Ingress / egress rules')].map(label => h('th', { key: label }, label)))),
          h('tbody', null, ...result.policies.slice(currentPage * 100, (currentPage + 1) * 100).map(policy => h('tr', { key: policy.name }, h('td', null, `${policy.applyTo.key}=${policy.applyTo.value}`, h('br'), `${policy.scope} · MONITOR`), h('td', null, policy.memberIds.join(', ')), h('td', null, `${policy.ingress.length} / ${policy.egress.length}`, h('details', null, h('summary', null, t('查看精确规则', 'Show exact rules')), h('pre', null, JSON.stringify({ ingress: policy.ingress, egress: policy.egress }, null, 2))))))))),
        pages > 1 && h('div', { className: 'pksp-actions' },
          h('button', { type: 'button', 'data-action': 'previous-page', disabled: currentPage === 0, onClick: () => setPage(currentPage - 1) }, t('上一页', 'Previous page')),
          h('span', null, t(`第 ${currentPage + 1} / ${pages} 页，每页 100 个策略；审查稿包含全部候选。`, `Page ${currentPage + 1} of ${pages}, 100 policies per page; the review draft contains all candidates.`)),
          h('button', { type: 'button', 'data-action': 'next-page', disabled: currentPage >= pages - 1, onClick: () => setPage(currentPage + 1) }, t('下一页', 'Next page'))),
        h('p', { className: 'pksp-warning' }, t('这不是完整业务白名单。流量采样和清单可能不完整；ICMP 未限定 type/code。没有观察统计或实际生效证据；禁止据此直接切换 WORK。导出文件不是 Everoute API/导入格式。', 'This is not a complete business allowlist. Capture and inventory may be incomplete; ICMP type/code is unrestricted. There is no observation or enforcement evidence. Do not use this to switch to WORK. The export is not an Everoute API/import payload.')),
        h('label', { className: 'pksp-check' }, h('input', { type: 'checkbox', 'data-action': 'review', checked: state.reviewed, disabled: result.summary.errorCount > 0 || !result.policies.length, onChange: event => session.review(event.target.checked) }), t('我已核对成员及精确规则，理解以上限制；仅导出人工审查稿。', 'I reviewed members and exact rules, understand the limits and want a manual review draft only.')),
        h('button', { type: 'button', 'data-action': 'export', disabled: !state.reviewed || result.summary.errorCount > 0 || !result.policies.length, onClick: download }, t('导出审查 JSON', 'Export review JSON'))),
      h('p', { className: 'pksp-hint' }, t('社区独立开发，非 SmartX 官方产品。', 'Independent community project; not an official SmartX product.'), ' ',
        h('a', { href: 'https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-security-policy-converter', target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'), ' · ',
        h('a', { href: 'https://github.com/sephirothchang/rivetin/blob/main/LICENSE', target: '_blank', rel: 'noopener noreferrer' }, 'MIT')));
  };
}
