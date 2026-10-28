import { createSshConnectionSettings } from './ssh-connection-settings.js';

const supportedOperations = new Set(['host.identity', 'disk.smart.read']);
const rejectedExamples = [
  ['rm -rf /', '删除系统和业务数据，可能无法恢复。', 'Deletes operating-system and business data, potentially irreversibly.'],
  ['mkfs /dev/<device>', '格式化设备并破坏现有文件系统。', 'Formats a device and destroys its existing filesystem.'],
  ['reboot / shutdown', '重启或关闭主机，中断主机承载的服务。', 'Restarts or powers off a host, interrupting its workloads.'],
  ['dd … of=/dev/<device>', '覆盖设备数据，可能破坏分区和业务数据。', 'Overwrites device data and can destroy partitions and workloads.'],
  ['ip link set <interface> down', '关闭网络接口，可能中断管理、存储或业务连接。', 'Disables a network interface and may interrupt management, storage or workload traffic.'],
  ['curl <url> | sh', '下载并执行未经审核的远程代码。', 'Downloads and executes unreviewed remote code.'],
];
const CSS = `
.pk-ssh{font-size:13px;color:#243650}.pk-ssh h3{margin:0}.pk-ssh-header,.pk-ssh-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.pk-ssh-header{margin-bottom:18px}.pk-ssh small,.pk-ssh-muted{color:#71849b}.pk-ssh-note{padding:12px 14px;border:1px solid #dce7f3;border-radius:7px;background:#f5f8fc;line-height:1.7;margin:14px 0}.pk-ssh-warning{background:#fff8e8;border-color:#f1d59e;color:#80551b}.pk-ssh-error{color:#ae2434;background:#fff1f0;padding:10px 12px;border-radius:6px;margin:12px 0}.pk-ssh-card{border:1px solid #dce5ef;border-radius:8px;padding:16px;margin:14px 0}.pk-ssh-status{display:inline-block;font-size:12px;border-radius:12px;padding:3px 9px;background:#f1f3f6;color:#62748c;white-space:nowrap}.pk-ssh-approved{background:#edf9f1;color:#237b42}.pk-ssh-card h4{margin:0 0 4px}.pk-ssh-card p{margin:9px 0}.pk-ssh-command{background:#f7f9fc;border:1px solid #e4ebf4;border-radius:6px;padding:12px;margin:12px 0}.pk-ssh-command code,.pk-ssh pre{font:12px/1.65 monospace;white-space:pre-wrap;overflow-wrap:anywhere}.pk-ssh-command pre{margin:8px 0}.pk-ssh-meta{display:grid;grid-template-columns:minmax(70px,max-content) minmax(0,1fr);gap:6px 12px;line-height:1.6}.pk-ssh-meta dt{color:#71849b}.pk-ssh-meta dd{margin:0;overflow-wrap:anywhere}.pk-ssh-action{margin-top:12px}.pk-ssh-category h5{font-size:12px;margin:18px 0 8px;color:#526c89}.pk-ssh-resolved-plans summary{cursor:pointer;color:#096dd9}.pk-ssh-resolved-plans summary:focus-visible{outline:2px solid #1385ee;outline-offset:2px}.pk-ssh-template strong{font-size:12px;color:#526c89}.pk-ssh-empty{padding:20px 0;color:#71849b}.pk-ssh table{border-collapse:collapse;width:100%;font-size:12px;margin-top:12px}.pk-ssh td,.pk-ssh th{text-align:left;border-bottom:1px solid #e8eef6;padding:8px;overflow-wrap:anywhere}.pk-ssh-risk-examples summary{cursor:pointer;font-weight:600}.pk-ssh-risk-examples code{color:#a32938}.pk-ssh-review-backdrop{position:fixed;inset:0;background:#142c4b66;z-index:1600;display:grid;place-items:center;padding:24px}.pk-ssh-review{background:white;border-radius:12px;box-shadow:0 20px 70px #102b4a44;width:min(760px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:24px;color:#243650;font-size:13px}.pk-ssh-review h3{margin:0 0 14px}.pk-ssh-review .pk-ssh-ack{display:flex;align-items:flex-start;gap:10px;padding:14px 0;line-height:1.65}.pk-ssh-ack input{flex:0 0 auto;margin-top:4px}.pk-ssh-review-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}.pk-ssh-review button{font:inherit;border:1px solid #d7e3f0;border-radius:6px;padding:8px 14px;cursor:pointer;background:#f1f3f5;color:#222}.pk-ssh-review button.pk-ssh-confirm{background:#087ef5;border-color:#087ef5;color:white}.pk-ssh button:disabled,.pk-ssh-review button:disabled{opacity:.5;cursor:default}@media(max-width:620px){.pk-ssh-review{padding:18px}.pk-ssh table{display:block;overflow:auto}.pk-ssh-meta{grid-template-columns:1fr;gap:3px}.pk-ssh-meta dd{margin-bottom:8px}}
`;
const bounded = value => typeof value === 'string' ? value.slice(0, 1200) : '';
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const commandIdentifier = value => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commands = value => Array.isArray(value?.commands) ? value.commands.slice(0, 20) : [];
const commandReady = item => commandIdentifier(item?.id) && supportedOperations.has(item.operation) && (item.hostScope === undefined || item.hostScope === 'configured') && (item.deviceScope === undefined || item.deviceScope === 'configured') && !item.missingHosts?.length && !item.missingDevices?.length && Array.isArray(item.preview) && item.preview.length > 0 && item.preview.length <= 100 && item.preview.every(line => typeof line === 'string' && line.length > 0 && line.length <= 1200);
const ready = registration => identity(registration?.pluginId) && digest(registration?.digest) && registration.enabled !== false && !registration.reason && commands(registration).length > 0 && commands(registration).every(commandReady);
const expiry = value => typeof value === 'number' ? value : Date.parse(value);

function executionText(run, locale) {
  const t = (zh, en) => locale === 'en-US' ? en : zh;
  if (run.result === 'success' && !run.code) return {
    label: t('远程命令已完成', 'Remote command completed'),
    detail: t('命令完成不等于磁盘健康；请以有效的 SMART 数据及其健康评估为准。', 'Command completion does not establish disk health. Review valid SMART data and its health assessment.'),
  };
  // The broker emits this code only after the transport returns a remote exit status.
  if (run.result === 'failed' && run.code === 'SSH_REMOTE_COMMAND_FAILED') return {
    label: t('SSH 认证已完成 · 远程命令失败', 'SSH authenticated · Remote command failed'),
    detail: t('远程命令返回失败状态，未取得有效采集结果。设备健康状态未知，不能据此判定磁盘损坏。', 'The remote command returned a failure status without a valid collection result. Device health is unknown; this does not establish disk damage.'),
  };
  if (run.result === 'failed' && run.code === 'SSH_AUTHENTICATION_FAILED') return {
    label: t('SSH 认证失败', 'SSH authentication failed'),
    detail: t('未取得远程命令结果，设备健康状态未知。', 'No remote command result is available; device health is unknown.'),
  };
  if (run.result === 'failed' && run.code === 'SSH_HOST_KEY_MISMATCH') return {
    label: t('主机指纹不匹配', 'Host key mismatch'),
    detail: t('主机身份核验未通过，设备健康状态未知。', 'Host identity verification failed; device health is unknown.'),
  };
  return {
    label: t('执行结果未完成或待确认', 'Execution incomplete or unconfirmed'),
    detail: t('未确认本次 SSH 认证及远程命令是否完成；此记录不能用于判定设备健康。', 'Completion of SSH authentication and the remote command is unconfirmed. This record cannot establish device health.'),
  };
}

export function createSshSettings(React) {
  const h = React.createElement, { useState, useEffect, useRef } = React, ConnectionSettings = createSshConnectionSettings(React);
  return function SshSettings({ client, locale = 'zh-CN', onError, connectionStore, preflightEnabled = false }) {
    const en = locale === 'en-US', t = (zh, english) => en ? english : zh;
    const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const [review, setReview] = useState(null), [acknowledged, setAcknowledged] = useState(false);
    const alive = useRef(false), request = useRef(0), reviewElement = useRef(null), previousFocus = useRef(null);
    function fail(failure) {
      const code = /^[A-Z_]{1,80}$/.test(failure?.message) ? failure.message : 'SSH_REQUEST_FAILED';
      if (alive.current) { setError(code); onError?.(code); }
    }
    async function load() {
      const value = await client('/ssh-channel');
      if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.registrations) || !Array.isArray(value.hosts)) throw new Error('SSH_RESPONSE_INVALID');
      if (alive.current) setState(value);
      return value;
    }
    async function refresh() {
      if (busy) return;
      setBusy(true); setError('');
      try { await load(); } catch (failure) { fail(failure); } finally { if (alive.current) setBusy(false); }
    }
    useEffect(() => {
      alive.current = true; setBusy(true);
      load().catch(fail).finally(() => { if (alive.current) setBusy(false); });
      return () => { alive.current = false; request.current++; };
    }, [client]);
    useEffect(() => {
      if (!review) return;
      const root = reviewElement.current;
      previousFocus.current = document.activeElement;
      (root?.querySelector('button:not(:disabled)') || root)?.focus();
      function keydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) { setReview(null); setAcknowledged(false); } }
        if (event.key === 'Tab') {
          event.stopPropagation();
          const elements = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled)')], first = elements[0], last = elements.at(-1);
          if (!elements.length) { event.preventDefault(); root.focus(); return; }
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }
      root?.addEventListener('keydown', keydown);
      return () => { root?.removeEventListener('keydown', keydown); previousFocus.current?.focus?.(); };
    }, [review, busy]);
    async function begin(registration) {
      if (busy || !state?.enabled || !state?.transportReady || !ready(registration)) return;
      setBusy(true); setError(''); const generation = ++request.current;
      try {
        const value = await client('/ssh-channel', 'POST', { action: 'review', pluginId: registration.pluginId });
        if (!alive.current || generation !== request.current) return;
        if (!identity(value?.challenge) || !digest(value.digest) || !Number.isFinite(expiry(value.expiresAt)) || expiry(value.expiresAt) <= Date.now() || !ready(value.registration) || value.registration.pluginId !== registration.pluginId || value.registration.digest !== value.digest) throw new Error('SSH_REVIEW_INVALID');
        setReview(value); setAcknowledged(false);
      } catch (failure) { fail(failure); } finally { if (alive.current) setBusy(false); }
    }
    async function approve() {
      if (!review || busy || !acknowledged || !state?.enabled || !state.transportReady) return;
      if (expiry(review.expiresAt) <= Date.now()) { fail(new Error('SSH_REVIEW_EXPIRED')); return; }
      setBusy(true); setError(''); const generation = ++request.current;
      try {
        await client('/ssh-channel', 'POST', { action: 'approve', pluginId: review.registration.pluginId, challenge: review.challenge, digest: review.digest, acknowledged: true });
        const current = await load();
        if (!alive.current || generation !== request.current) return;
        if (!current.registrations.some(item => item.pluginId === review.registration.pluginId && item.digest === review.digest && item.approved === true)) throw new Error('SSH_APPROVAL_NOT_ACTIVE');
        setReview(null); setAcknowledged(false);
      } catch (failure) { fail(failure); } finally { if (alive.current) setBusy(false); }
    }
    async function revoke(registration) {
      if (busy) return; setBusy(true); setError('');
      try { await client('/ssh-channel', 'POST', { action: 'revoke', pluginId: registration.pluginId }); await load(); }
      catch (failure) { fail(failure); } finally { if (alive.current) setBusy(false); }
    }
    function renderCommand(command, index, registration, reviewing = false) {
      const purpose = typeof command.purpose === 'object' ? command.purpose[locale] || command.purpose['en-US'] : '';
      const schedule = command.intervalSeconds === 86400 ? t('每天一次', 'Once daily') : command.intervalSeconds > 0 ? t(`每 ${command.intervalSeconds} 秒`, `Every ${command.intervalSeconds} seconds`) : t('仅按需执行', 'On demand only');
      const plans = Array.isArray(command.preview) ? command.preview.slice(0, 100) : [];
      const excluded = Array.isArray(command.excludedHosts) ? command.excludedHosts.slice(0, 500) : [];
      const source = { 'fresh-host-inventory': t('已核验的当前主机库存', 'Verified current host inventory'), 'configured-device-mappings': t('既有设备映射（不代表已核验当前库存）', 'Configured device mappings; current inventory is not established'), 'configured-hosts': t('已配置主机', 'Configured hosts') }[command.resolutionSource] || t('尚未解析', 'Unresolved');
      return h('div', { className: 'pk-ssh-command', key: `${bounded(command.id)}-${index}` },
        h('strong', null, bounded(command.id)), h('p', null, bounded(purpose)),
        h('div', { className: 'pk-ssh-template' }, h('strong', null, t('命令范式', 'Command template')), h('pre', null, bounded(command.template) || t('未提供范式，请核对具体执行计划。', 'No template provided; review the resolved execution plans.'))),
        h('dl', { className: 'pk-ssh-meta' }, h('dt', null, t('操作', 'Operation')), h('dd', null, bounded(command.operation)),
          h('dt', null, t('参数来源要求', 'Required argument source')), h('dd', null, command.argumentSource === 'fresh-host-inventory' ? t('目标主机的当前可信磁盘库存', 'Current trusted disk inventory of the target host') : t('已配置的目标主机', 'Configured target hosts')),
          h('dt', null, t('当前解析来源', 'Current resolution source')), h('dd', null, source),
          h('dt', null, t('展开方式', 'Expansion')), h('dd', null, command.operation === 'disk.smart.read' ? t('在全部或自选策略范围内逐个授权磁盘生成计划；不固定设备路径。', 'Create one plan per authorized disk under the all or custom policy; no fixed device path.') : t('逐个授权主机生成计划。', 'Create one plan per authorized host.')),
          h('dt', null, t('计划数量', 'Plan count')), h('dd', null, `${t('预期', 'Expected')} ${Number.isSafeInteger(command.expectedCount) && command.expectedCount >= 0 ? command.expectedCount : plans.length} / ${t('已解析', 'Resolved')} ${plans.length} / ${t('排除主机', 'Excluded hosts')} ${excluded.length}`),
          h('dt', null, t('主机范围', 'Host scope')), h('dd', null, command.hostScope === 'configured' ? t('所有已配置主机', 'All configured hosts') : t('指定主机', 'Explicit hosts')),
          h('dt', null, t('目标主机', 'Target hosts')), h('dd', null, (command.hostIds || []).map(bounded).join(', ') || '—'),
          command.operation === 'disk.smart.read' && h('dt', null, t('设备范围', 'Device scope')), command.operation === 'disk.smart.read' && h('dd', null, command.deviceScope === 'configured' ? t('所有已配置设备', 'All configured devices') : t('指定设备', 'Explicit devices')),
          h('dt', null, t('目标设备', 'Target devices')), h('dd', null, (command.deviceIds || []).map(bounded).join(', ') || '—'),
          h('dt', null, t('运行计划', 'Schedule')), h('dd', null, schedule),
          h('dt', null, t('风险类型', 'Risk class')), h('dd', null, t('允许列表中的只读采集操作', 'Allowlisted read-only collection operation'))),
        excluded.length > 0 && h('p', { className: 'pk-ssh-muted' }, t('明确排除磁盘目标的主机：', 'Hosts explicitly excluded from disk targets: ') + excluded.map(bounded).join(', ')),
        h('details', { className: 'pk-ssh-resolved-plans', open: reviewing }, h('summary', null, t('具体执行计划', 'Resolved execution plans') + ` · ${plans.length} · ` + t('已批准目标', 'Approved targets') + ` ${registration.approved ? plans.length : 0}`),
          h('pre', null, plans.map(bounded).join('\n') || t('无法获取可信命令预览，禁止授权。', 'No trusted command preview is available; approval is blocked.'))),
        (command.missingHosts?.length > 0 || command.missingDevices?.length > 0) && h('p', { className: 'pk-ssh-error' }, t('部分目标缺少可信连接或设备映射，禁止授权。', 'Some targets lack trusted connection or device mappings; approval is blocked.')));
    }
    function renderCommands(registration, reviewing = false) {
      const groups = new Map();
      for (const command of commands(registration)) {
        const category = command.operation === 'disk.smart.read' ? 'disk' : command.operation === 'host.identity' ? 'host' : 'unknown';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(command);
      }
      return [...groups].map(([category, items]) => h('section', { key: category, className: 'pk-ssh-category', 'data-command-category': category },
        h('h5', null, { disk: t('磁盘类命令', 'Disk commands'), host: t('主机类命令', 'Host commands'), unknown: t('未知命令类别', 'Unknown command category') }[category]),
        ...items.map((command, index) => renderCommand(command, index, registration, reviewing))));
    }
    const registrations = state?.registrations.slice(0, 100) || [];
    const examples = new Map(rejectedExamples.map(([example, zh, english]) => [example, { 'zh-CN': zh, 'en-US': english }]));
    for (const item of (Array.isArray(state?.rejectedExamples) ? state.rejectedExamples : []).slice(0, 30)) {
      const example = bounded(item.command || item.example), impact = item.impact || item.risk;
      if (example && impact && typeof impact === 'object') examples.set(example, impact);
    }
    return h('div', { className: 'pk-ssh' }, h('style', null, CSS),
      h('div', { className: 'pk-ssh-header' }, h('h3', null, t('SSH 通道', 'SSH channel')), h('button', { disabled: busy, onClick: refresh }, t('刷新', 'Refresh'))),
      error && !review && h('p', { className: 'pk-ssh-error', role: 'alert' }, t('操作未完成：', 'Operation incomplete: ') + error),
      !state ? h('p', null, busy ? t('正在加载…', 'Loading…') : t('无法读取 SSH 通道状态。', 'SSH channel state is unavailable.')) : h(React.Fragment, null,
        h('div', { className: `pk-ssh-note ${!state.enabled ? 'pk-ssh-warning' : ''}` }, h('strong', null, state.enabled ? t('通道已启用', 'Channel enabled') : t('通道未启用', 'Channel disabled')),
          h('div', null, t('默认安装不会建立 SSH 连接。请在插件管理中启用 SSH 通道并保存通道配置，再分别审核消费插件的命令。', 'The default installation establishes no SSH connections. Enable the SSH channel in Plugin management and save its channel configuration, then review each requesting plugin’s commands.'))),
        !state.transportReady && h('p', { className: 'pk-ssh-note pk-ssh-warning' }, t('SSH 传输尚未就绪，不能批准命令执行。', 'SSH transport is not ready; command execution cannot be approved.')),
        h('div', { className: 'pk-ssh-note' }, t('仅接受框架允许的结构化只读操作。子插件不能上传任意命令或脚本；安装后 SSH 权限默认关闭。命令、版本、目标范围或计划变化后需重新审核。', 'Only structured read-only operations allowed by the framework are accepted. Plugins cannot upload arbitrary commands or scripts; SSH access is off after installation. Changes to commands, versions, targets or schedules require a new review.')),
        connectionStore && h(ConnectionSettings, { store: connectionStore, client, locale, preflightEnabled }),
        h('h4', null, t('已保存主机连接摘要', 'Saved host connection profiles')),
        h('p', { className: 'pk-ssh-muted' }, connectionStore ? t('下表为已保存状态。新凭据只经受认证的连接设置接口提交并由后端加密，不进入普通插件配置；已保存的密码和私钥不会返回此页面。', 'The table shows saved state. New credentials go only to the authenticated connection-settings API and are encrypted by the backend, outside ordinary plugin configuration. Saved passwords and private keys are never returned.') : t('凭据通过便携 CLI 从受控敏感文件导入；此摘要不显示、接收或保存密码和私钥。', 'Credentials are imported from a controlled sensitive file through the portable CLI. This summary does not display, accept or store passwords or private keys.')),
        state.hosts.length ? h('table', null, h('thead', null, h('tr', null, ...[t('主机 / 集群', 'Host / cluster'), t('地址 / 账户', 'Address / account'), t('主机密钥', 'Host key'), t('凭据', 'Credentials')].map(label => h('th', { key: label }, label)))),
          h('tbody', null, ...state.hosts.slice(0, 100).map(host => h('tr', { key: host.hostId }, h('td', null, bounded(host.hostId), h('br'), bounded(host.clusterId)), h('td', null, bounded(host.address), h('br'), bounded(host.username)), h('td', null, bounded(host.hostKeySha256)), h('td', null, (host.credentialConfigured ?? Boolean(host.authType)) ? t('已配置', 'Configured') : t('未配置', 'Not configured')))))) : h('p', { className: 'pk-ssh-empty' }, t('尚未配置主机连接。', 'No host connections configured.')),
        h('h4', null, t('子插件命令注册与授权', 'Plugin command registration and approvals')),
        registrations.length ? registrations.map(registration => h('article', { className: 'pk-ssh-card', key: registration.pluginId },
          h('div', { className: 'pk-ssh-row' }, h('div', null, h('h4', null, bounded(typeof registration.pluginName === 'object' ? registration.pluginName[locale] : registration.pluginName) || bounded(registration.name?.[locale]) || bounded(registration.pluginId)), h('small', null, bounded(registration.pluginId))),
            h('span', { className: `pk-ssh-status ${registration.approved && registration.enabled !== false && state.enabled && state.transportReady ? 'pk-ssh-approved' : ''}` }, registration.approved ? registration.enabled !== false && state.enabled && state.transportReady ? t('已授权', 'Approved') : t('已授权 · 暂停', 'Approved · suspended') : t('SSH 权限关闭', 'SSH access off'))),
          registration.enabled === false && h('p', { className: 'pk-ssh-note pk-ssh-warning' }, t('消费插件未启用，不能授权或执行。', 'The requesting plugin is disabled; approval and execution are blocked.')),
          registration.reason && h('p', { className: 'pk-ssh-error' }, t('注册不可用：', 'Registration unavailable: ') + bounded(registration.reason)),
          ...renderCommands(registration),
          h('small', null, t('授权摘要：', 'Approval digest: ') + bounded(registration.digest)),
          h('div', { className: 'pk-ssh-action' }, registration.approved ? h('button', { disabled: busy, onClick: () => revoke(registration) }, t('关闭 SSH 权限', 'Revoke SSH access')) : h('button', { disabled: busy || !state.enabled || !state.transportReady || !ready(registration), onClick: () => begin(registration) }, t('审核并启用', 'Review and enable'))))) : h('p', { className: 'pk-ssh-empty' }, t('尚无子插件注册 SSH 命令。', 'No plugins have registered SSH commands.')),
        h('details', { className: 'pk-ssh-risk-examples' }, h('summary', null, t('禁止注册的高风险命令示例', 'Examples of prohibited high-risk commands')),
          h('p', null, t('以下仅为风险说明，不可执行。未列出的操作也不会自动获准；未知操作一律拒绝。', 'These examples explain risks and cannot be executed. Unlisted operations are not implicitly allowed; unknown operations are rejected.')),
          h('table', null, h('thead', null, h('tr', null, h('th', null, t('示例', 'Example')), h('th', null, t('风险影响', 'Impact')))), h('tbody', null, ...[...examples].map(([example, impact]) => h('tr', { key: example }, h('td', null, h('code', null, example)), h('td', null, bounded(impact[locale] || impact['en-US']))))))),
        h('h4', null, t('最近执行记录', 'Recent executions')),
        state.recentRuns?.length ? h('table', null, h('thead', null, h('tr', null, ...[t('插件 / 命令', 'Plugin / command'), t('时间', 'Time'), t('结果', 'Result')].map(label => h('th', { key: label }, label)))),
          h('tbody', null, ...state.recentRuns.slice(0, 30).map((run, index) => {
            const result = executionText(run, locale);
            return h('tr', { key: run.id || index }, h('td', null, bounded(run.pluginId), h('br'), bounded(run.commandId)), h('td', null, bounded(run.finishedAt || run.completedAt || run.startedAt)),
              h('td', { className: 'pk-ssh-run-result' }, h('strong', null, result.label), h('div', { className: 'pk-ssh-muted' }, result.detail), h('code', null, bounded(run.code || run.result || run.status))));
          }))) : h('p', { className: 'pk-ssh-empty' }, t('暂无执行记录。', 'No execution history.'))),
      review && h('div', { className: 'pk-ssh-review-backdrop' }, h('section', { ref: reviewElement, tabIndex: -1, className: 'pk-ssh-review', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'pk-ssh-review-title' },
        h('h3', { id: 'pk-ssh-review-title' }, t('确认启用子插件 SSH 权限', 'Confirm plugin SSH access')),
        error && h('p', { className: 'pk-ssh-error', role: 'alert' }, t('操作未完成：', 'Operation incomplete: ') + error),
        h('p', null, t('请逐项核对以下命令、目标和运行计划。确认后，该插件可在批准范围内通过统一通道执行采集。', 'Review every command, target and schedule below. Confirmation lets this plugin collect data through the shared channel within the approved scope.')),
        h('strong', null, bounded(review.registration.pluginId)),
        commands(review.registration).some(command => command.hostScope === 'configured' || command.deviceScope === 'configured') && h('p', { className: 'pk-ssh-note' }, t('下列清单是本次审核解析出的完整目标范围。新增主机或设备后，摘要变化，需重新审核并确认。', 'The lists below are the complete targets resolved for this review. Adding hosts or devices changes the digest and requires a new review and confirmation.')),
        ...renderCommands(review.registration, true),
        h('small', null, t('本次审核有效期至：', 'Review valid until: ') + new Date(expiry(review.expiresAt)).toLocaleString(locale)),
        h('label', { className: 'pk-ssh-ack' }, h('input', { type: 'checkbox', checked: acknowledged, disabled: busy, onChange: event => setAcknowledged(event.target.checked) }), t('我已审核命令、目标范围和运行计划，确认允许该插件使用上述 SSH 采集能力。', 'I have reviewed the commands, targets and schedule, and authorize this plugin to use the SSH collection operations above.')),
        h('div', { className: 'pk-ssh-review-actions' }, h('button', { disabled: busy, onClick: () => { setReview(null); setAcknowledged(false); } }, t('取消', 'Cancel')), h('button', { className: 'pk-ssh-confirm', disabled: busy || !acknowledged, onClick: approve }, busy ? t('正在处理…', 'Processing…') : t('确认启用', 'Confirm enable'))))));
  };
}
