const STATES = ['ok', 'warning', 'failed', 'unknown', 'disabled'];
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'COMPONENT_UNVERIFIED';
const text = (value, fallback = '—') => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : fallback;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const labels = {
  '组件状态': 'Component status', '检查 / 刷新': 'Check / refresh', '正在检查…': 'Checking…', '暂无组件': 'No components', '暂无插件': 'No plugins',
  '组件': 'Component', '状态': 'Status', '依赖': 'Dependencies', '详情': 'Details', '插件兼容性': 'Plugin compatibility', '兼容性声明': 'Compatibility declaration',
  '已核验': 'Verified', '需关注': 'Warning', '失败': 'Failed', '未知': 'Unknown', '已停用': 'Disabled', '兼容': 'Compatible', '不兼容': 'Incompatible',
  '修复': 'Repair', '重置': 'Reset', '取消': 'Cancel', '下载支持包': 'Download support bundle', '检查时间': 'Checked at', '版本': 'Version',
  '框架': 'Framework', '声明': 'Declared', '观测': 'Observed', '限制': 'Limitations', '启用': 'Enabled', '运行中': 'Active', '未运行': 'Inactive',
  '确认修复？': 'Confirm repair?', '确认重置？': 'Confirm reset?', '操作完成': 'Operation completed', '部分完成': 'Partially completed',
  '请刷新页面以加载变更。': 'Reload the page to load the changes.', '无依赖': 'None', '支持包已下载。': 'Support bundle downloaded.',
  'Web 修复将停用所有子插件，仅处理自身数据与缓存，并保留安装包、配置、凭据与历史；代码、Deployment、Ingress 或不可用后端需要使用 CLI。': 'Web repair disables every subplugin and only handles Rivetin data and caches. Packages, configuration, credentials and history are retained. Code, Deployment, Ingress or an unavailable backend requires the CLI.',
  '重置将停用所有子插件，保留安装包、配置、凭据与历史。': 'Reset disables every subplugin and retains packages, configuration, credentials and history.',
  '接口已注册不代表端到端功能已经验证；未知状态不视为正常。': 'A registered API is not proof of end-to-end validation. Unknown status is not healthy.',
  '操作结果尚未确认，已停止重复提交。请检查状态或使用 CLI 核实。': 'The operation outcome is unconfirmed. Repeated submission is blocked. Check status or verify with the CLI.',
};
const reasons = {
  ADMIN_REQUIRED: ['需要管理员权限。', 'Administrator permission is required.'],
  AUTHENTICATION_REQUIRED: ['登录状态不可用，请重新登录。', 'Authentication is unavailable. Sign in again.'],
  REQUEST_FAILED: ['无法完成请求，请检查服务状态。', 'The request failed. Check service status.'],
  COMPONENT_STATUS_INVALID: ['状态响应无效，未将其视为正常。', 'The status response is invalid and was not treated as healthy.'],
  COMPONENT_UNVERIFIED: ['尚未完成验证。', 'Verification is incomplete.'],
  TOWER_BUILD_UNKNOWN: ['无法确认 CloudTower 版本。', 'The CloudTower version could not be confirmed.'],
  PLUGIN_INCOMPATIBLE: ['当前版本不在插件兼容范围内。', 'The current version is outside plugin compatibility.'],
  PLUGIN_COMPATIBILITY_UNDECLARED: ['插件未声明机器可验证的兼容范围。', 'The plugin has no machine-verifiable compatibility declaration.'],
  SUPPORT_BUNDLE_INVALID: ['支持包校验失败，未下载文件。', 'Support bundle validation failed. No file was downloaded.'],
  COMPONENT_ACTION_INVALID: ['操作响应无法核实。', 'The operation response could not be verified.'],
  COMPONENT_ACTION_UNAVAILABLE: ['此操作当前不可用，请使用 CLI。', 'This action is unavailable. Use the CLI.'],
};
for (const [codes, zh, en] of [
  [['API_REGISTERED_UNPROBED', 'API_PROBE_UNCONFIRMED', 'COMPONENT_UNCHECKED', 'COMPATIBILITY_UNKNOWN', 'SUPPORT_API_UNCONFIRMED'], '接口或组件尚未完成实际探测，不能据此判定功能正常。', 'The API or component has not been successfully probed. Its functionality is unverified.'],
  [['API_NOT_REGISTERED', 'API_REGISTRY_INVALID'], '接口注册信息缺失或无效，请核对框架部署。', 'API registration is missing or invalid. Check the framework deployment.'],
  [['CODE_MANIFEST_UNAVAILABLE', 'CODE_MANIFEST_INVALID', 'CODE_INTEGRITY_MISMATCH'], '本地代码清单不可用或完整性不符，请通过可信 CLI 制品核对修复。', 'The local code manifest is unavailable or integrity differs. Verify and repair using a trusted CLI release.'],
  [['LOCAL_MANIFEST_NOT_SIGNATURE_PROOF'], '本地摘要清单仅用于一致性检查，不构成发布者签名证明。', 'The local digest manifest checks consistency; it is not publisher-signature verification.'],
  [['PACKAGE_POINTER_INVALID', 'PACKAGE_POINTER_MISMATCH', 'PACKAGE_INVALID', 'PACKAGE_INTEGRITY_MISMATCH'], '插件包或活动指针校验失败，相关插件应保持停用。', 'Package or active-pointer validation failed. Keep the affected plugin disabled.'],
  [['FILESYSTEM_CHECK_FAILED', 'STORAGE_PATH_UNSAFE', 'AUDIT_PATH_UNSAFE', 'INSPECTION_PATH_INVALID', 'INSPECTION_PATH_UNSAFE', 'COMPONENT_MAINTENANCE_UNSAFE_PATH'], '存储路径或访问条件不安全，已停止相关检查或操作，请使用 CLI 核实。', 'Storage paths or access conditions are unsafe. The check or action was stopped. Verify with the CLI.'],
  [['READ_ONLY_STORAGE_ACCESS_CHECK'], '仅检查存储访问条件，未执行写入验证。', 'Only storage access conditions were checked; no write test was performed.'],
  [['READER_FAILED', 'READER_UNAVAILABLE', 'RUNTIME_INVALID', 'CONFIGURATION_STATUS_UNAVAILABLE', 'CONFIGURATION_METADATA_INVALID', 'PLUGIN_INVENTORY_UNAVAILABLE', 'UPDATE_STATUS_INVALID', 'AUDIT_UNAVAILABLE', 'INSPECTION_FAILED'], '组件状态读取或元数据校验失败，其他独立检查仍会保留。', 'Component reading or metadata validation failed. Independent check results remain available.'],
  [['READER_TIMEOUT', 'INSPECTION_TIMEOUT'], '组件检查已超时，结果尚未确认。', 'The component check timed out; its result is unconfirmed.'],
  [['INSPECTION_BUSY', 'STORE_BUSY'], '服务正在处理其他操作，请稍后重新检查。', 'The service is processing another operation. Check again later.'],
  [['INSPECTION_LIMIT', 'COMPONENT_MAINTENANCE_BACKUP_LIMIT', 'COMPONENT_MAINTENANCE_OPERATION_LIMIT', 'COMPONENT_MAINTENANCE_METADATA_LIMIT'], '检查或维护已达到资源上限，未继续扩大处理范围。', 'An inspection or maintenance resource limit was reached. Processing was not expanded.'],
  [['INSPECTION_FILE_CHANGED'], '检查期间文件发生变化，未将本次结果视为完整验证。', 'A file changed during inspection. This result is not a complete verification.'],
  [['ISLAND_UNOBSERVABLE'], '当前无法确认 Island 注册状态，请通过受支持的管理流程核实。', 'Island registration could not be observed. Verify through the supported management flow.'],
  [['ISLAND_REGISTRATION_MISMATCH'], 'Island 注册与预期不符，需要通过 CLI 核对恢复。', 'Island registration differs from the expected state. Verify and restore with the CLI.'],
  [['CLI_OR_MAINTENANCE_REQUIRED', 'CLI_REQUIRED_FOR_DEPLOYMENT_REPAIR', 'CLI_REPAIR_REQUIRED', 'NO_KUBERNETES_AUTHORITY'], 'Web 无权修复部署资源，请使用 CLI；本页不修改官方组件。', 'Web repair cannot change deployment resources. Use the CLI; this page does not modify official components.'],
  [['NO_BROKER_STATUS_OR_SYNC', 'NO_HOST_COMMANDS'], '此检查不执行主机命令，也不触发命令审批或计划同步。', 'This check runs no host commands and does not synchronize command approvals or schedules.'],
  [['FRAMEWORK_TOWER_INCOMPATIBLE'], '当前 CloudTower 版本不在框架已验证范围内，执行已受限。', 'The current CloudTower version is outside the framework verified range. Execution is restricted.'],
  [['FRAMEWORK_VERSION_UNKNOWN', 'PLUGIN_COMPATIBILITY_INVALID'], '无法确认有效的版本或兼容性声明，未授予运行权限。', 'A valid version or compatibility declaration could not be confirmed. Execution was not granted.'],
  [['SMTX_SNAPSHOT_UNAVAILABLE', 'SMTX_SNAPSHOT_INVALID', 'SMTX_SNAPSHOT_EXPIRED', 'SMTX_VERSION_UNKNOWN', 'SMTX_SCOPE_UNTRUSTED', 'SMTX_SCOPE_INCOMPLETE', 'SMTX_AUTHORITY_REQUIRED', 'SMTX_CLUSTER_UNAVAILABLE', 'SMTX_INVENTORY_INVALID', 'SMTX_INVENTORY_UNAVAILABLE', 'SMTX_CHECK_CANCELLED'], 'SMTX 版本证据缺失、过期或不完整，兼容性仍为未知。', 'SMTX version evidence is missing, stale or incomplete. Compatibility remains unknown.'],
  [['SMTX_CHECK_TIMEOUT', 'SMTX_INVENTORY_LIMIT'], 'SMTX 库存检查超时或超过上限，未使用部分结果放行。', 'SMTX inventory checking timed out or exceeded a limit. Partial results were not used to grant access.'],
  [['SMTX_INCOMPATIBLE', 'SMTX_SCOPE_EMPTY'], '受管 SMTX 产品不符合已声明的版本或适用范围。', 'Managed SMTX products do not match the declared version or applicability scope.'],
  [['UPDATE_SOURCE_UNAVAILABLE'], '无法连接更新源，无法确认当前可用版本。', 'The update source is unavailable. Available versions could not be confirmed.'],
  [['MAINTENANCE_UNAVAILABLE', 'COMPONENT_MAINTENANCE_UNAVAILABLE'], 'Web 维护当前不可用，请使用 CLI 核实框架状态。', 'Web maintenance is unavailable. Verify the framework using the CLI.'],
  [['COMPONENT_MAINTENANCE_REQUEST_INVALID', 'COMPONENT_MAINTENANCE_OPERATION_CONFLICT'], '维护请求无效或操作编号冲突，未重复执行。', 'The maintenance request is invalid or its operation ID conflicts. It was not replayed.'],
  [['COMPONENT_MAINTENANCE_JOURNAL_INVALID', 'COMPONENT_MAINTENANCE_JOURNAL_UNAVAILABLE', 'MAINTENANCE_OUTCOME_UNKNOWN'], '无法核实维护记录或最终结果，已停止自动重试，请使用 CLI 排查。', 'The maintenance journal or outcome could not be verified. Automatic retry was stopped. Investigate with the CLI.'],
  [['MAINTENANCE_BACKUP_FAILED'], '备份未获确认，后续维护步骤未获安全放行。', 'Backup was not confirmed. Subsequent maintenance was not safely authorized.'],
  [['MAINTENANCE_DISABLE_FAILED'], '未能确认全部插件已停用，不能视为维护成功。', 'Disabling every plugin was not confirmed. Maintenance is not considered successful.'],
  [['MAINTENANCE_REPAIR_FAILED', 'MAINTENANCE_RESET_FAILED', 'MAINTENANCE_INSPECTION_FAILED', 'MAINTENANCE_AUDIT_FAILED'], '本项维护、检查或审计未完成，请结合操作编号核实；不会自动重复提交。', 'This maintenance, check or audit step did not complete. Verify using the operation ID; it will not be automatically resubmitted.'],
  [['BACKUP_CONFIRMED'], '维护前备份已确认。', 'The pre-maintenance backup was confirmed.'],
  [['DISABLE_CONFIRMED'], '全部子插件已确认停用。', 'Every subplugin was confirmed disabled.'],
  [['REPAIR_CONFIRMED'], '已确认完成允许范围内的数据修复。', 'Data repair within the permitted scope was confirmed.'],
  [['CACHE_RESET_CONFIRMED'], '允许范围内的缓存重置已确认，业务配置和历史保留。', 'Permitted cache reset was confirmed. Configuration and history were retained.'],
  [['INSPECTION_CONFIRMED'], '维护后的状态检查已完成；独立未知项仍需核实。', 'The post-maintenance inspection completed; independently unknown items still require verification.'],
  [['AUDIT_RECORDED'], '本项操作记录已保存。', 'This operation record was saved.'],
]) for (const key of codes) reasons[key] = [zh, en];
function validStatus(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.checkedAt !== 'string' || value.checkedAt.length > 64 || !Number.isFinite(Date.parse(value.checkedAt)) || !STATES.includes(value.overall) || !value.framework || !Array.isArray(value.components) || value.components.length > 100 || !Array.isArray(value.plugins) || value.plugins.length > 500 || !Array.isArray(value.limitations) || value.limitations.length > 50) throw new Error('COMPONENT_STATUS_INVALID');
  if (typeof value.framework.enabled !== 'boolean' || typeof value.framework.version !== 'string' || !value.actions || !['repair', 'reset', 'support'].every(key => typeof value.actions[key]?.available === 'boolean')) throw new Error('COMPONENT_STATUS_INVALID');
  const ids = new Set();
  for (const row of value.components) {
    if (!id(row?.id) || ids.has(row.id) || !STATES.includes(row.status) || !Array.isArray(row.dependsOn) || row.dependsOn.length > 100 || row.dependsOn.some(value => !id(value)) || row.checks !== undefined && (!Array.isArray(row.checks) || row.checks.length > 100 || row.checks.some(check => !check || !STATES.includes(check.status)))) throw new Error('COMPONENT_STATUS_INVALID');
    ids.add(row.id);
  }
  if (value.plugins.some(row => !id(row?.id))) throw new Error('COMPONENT_STATUS_INVALID');
  return value;
}
export async function decodeComponentsSupport(value, cryptoImpl = globalThis.crypto, decode = globalThis.atob) {
  const limit = 1024 * 1024;
  if (!value || !/^\d{8}-(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.rivetin-support\.json\.gz$/.test(value.filename || '') || value.contentType !== 'application/gzip' || !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > limit || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || typeof value.data !== 'string' || value.data.length > Math.ceil(limit / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('SUPPORT_BUNDLE_INVALID');
  try {
    const binary = decode(value.data), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.length !== value.bytes || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error();
    const digest = Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== value.sha256) throw new Error();
    return bytes;
  } catch { throw new Error('SUPPORT_BUNDLE_INVALID'); }
}
function browserDownload(value, bytes) {
  const url = window.URL.createObjectURL(new window.Blob([bytes], { type: value.contentType }));
  const link = window.document.createElement('a'); link.href = url; link.download = value.filename;
  try { window.document.body.append(link); link.click(); }
  finally { link.remove(); window.setTimeout(() => window.URL.revokeObjectURL(url), 0); }
}
export function createComponentsStatus(React, helpers = {}) {
  const h = React.createElement;
  return function ComponentsStatus({ client, locale = 'zh-CN', t, onRefresh }) {
    const en = locale === 'en-US', tr = value => labels[value] && en ? labels[value] : t ? t(value) : value;
    const [data, setData] = React.useState(null), [loading, setLoading] = React.useState(false), [error, setError] = React.useState(null), [dialog, setDialog] = React.useState(null), [result, setResult] = React.useState(null), [busy, setBusy] = React.useState(false), [uncertain, setUncertain] = React.useState(false), [downloaded, setDownloaded] = React.useState(false);
    const life = React.useRef({ mounted: false, epoch: 0, generation: 0, controller: null, mutating: false });
    const localized = (value, fallback = '—') => text(typeof value === 'string' ? value : value?.[locale] || value?.['en-US'] || value?.['zh-CN'], fallback);
    const explanation = value => { const key = code(value); return `${reasons[key]?.[en ? 1 : 0] || reasons.COMPONENT_UNVERIFIED[en ? 1 : 0]} [${key}]`; };
    const status = value => h('span', { className: `rv-components-status rv-components-${STATES.includes(value) ? value : 'unknown'}` }, tr({ ok: '已核验', warning: '需关注', failed: '失败', unknown: '未知', disabled: '已停用' }[value] || '未知'));
    async function load(fresh = false) {
      const state = life.current, epoch = ++state.epoch; state.controller?.abort(); const controller = new AbortController(); state.controller = controller;
      setLoading(true); setError(null);
      try { const next = validStatus(await client(`/components/status${fresh ? '?fresh=true' : ''}`, 'GET', undefined, { signal: controller.signal })); if (state.mounted && epoch === state.epoch) setData(next); }
      catch (failed) { if (state.mounted && epoch === state.epoch && !controller.signal.aborted) setError(failed.status === 403 ? 'ADMIN_REQUIRED' : failed.status === 401 ? 'AUTHENTICATION_REQUIRED' : code(failed.code || failed.message)); }
      finally { if (state.mounted && epoch === state.epoch) setLoading(false); }
    }
    React.useEffect(() => { const state = life.current; state.mounted = true; state.generation++; setData(null); load(); return () => { state.mounted = false; state.generation++; state.epoch++; state.controller?.abort(); }; }, [client]);
    const observedSmtx = () => {
      const observed = data?.framework.compatibility?.observed;
      if (Array.isArray(observed?.smtxVersions)) {
        const versions = [...new Set(observed.smtxVersions.slice(0, 500).filter(value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(value) && value.length <= 100))];
        return versions.join(', ') || tr('未知');
      }
      return text(observed?.smtxVersion, tr('未知'));
    };
    const fields = value => {
      if (!value || typeof value !== 'object') return h('span', null, '—');
      const allowed = ['towerBuilds', 'towerVersion', 'towerBuild', 'smtxVersion', 'smtxVersions', 'frameworkApi', 'frameworkVersion', 'frameworkMinVersion', 'frameworkMaxVersionExclusive'];
      return h('dl', { className: 'rv-components-fields' }, ...allowed.filter(key => Object.hasOwn(value, key)).map(key => {
        const raw = value[key], values = Array.isArray(raw) ? raw.slice(0, 20) : [raw];
        return h(React.Fragment, { key }, h('dt', null, key), h('dd', null, values.map(item => typeof item === 'number' && Number.isSafeInteger(item) ? String(item) : text(item)).join(', ') || '—'));
      }));
    };
    const compatibility = value => {
      const state = value?.status === 'unknown' ? 'unknown' : value?.status === 'incompatible' ? 'failed' : value?.status === 'compatible' ? value.compatible === true ? 'ok' : 'unknown' : value?.status !== undefined ? 'unknown' : value?.compatible === true ? 'ok' : value?.compatible === false ? 'failed' : 'unknown';
      return h('div', { className: 'rv-components-compat' }, status(state),
        h('span', null, tr(state === 'ok' ? '兼容' : state === 'failed' ? '不兼容' : '未知')), value?.reason && h('small', null, explanation(value.reason)),
        h('details', null, h('summary', null, tr('兼容性声明')), h('strong', null, tr('声明')), fields(value?.declared), h('strong', null, tr('观测')), fields(value?.observed)));
    };
    async function mutate() {
      const state = life.current, action = dialog, generation = state.generation;
      if (!action || state.mutating || uncertain || !data?.actions[action]?.available) return;
      state.mutating = true; setBusy(true); setError(null);
      let submitted = false;
      try {
        const operationId = (helpers.randomUUID || (() => globalThis.crypto.randomUUID()))();
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) throw new Error('COMPONENT_ACTION_INVALID');
        submitted = true;
        const response = await client(`/components/${action}`, 'POST', { operationId, acknowledged: true });
        if (response?.operationId !== operationId || !['success', 'partial'].includes(response.result) || !Array.isArray(response.outcomes) || response.outcomes.length > 100 || response.outcomes.some(outcome => !outcome || !id(outcome.id) || ![...STATES, 'skipped'].includes(outcome.status)) || typeof response.requiresReload !== 'boolean') throw new Error('COMPONENT_ACTION_INVALID');
        if (!state.mounted || generation !== state.generation) return;
        setResult(response); setDialog(null); await load(true);
        if (state.mounted && generation === state.generation) { try { await onRefresh?.(); } catch { if (state.mounted && generation === state.generation) setError('REQUEST_FAILED'); } }
      } catch (failed) { if (state.mounted && generation === state.generation) { setError(failed.status === 403 ? 'ADMIN_REQUIRED' : failed.status === 401 ? 'AUTHENTICATION_REQUIRED' : code(failed.code || failed.message)); if (submitted) setUncertain(true); } }
      finally { state.mutating = false; if (state.mounted && generation === state.generation) setBusy(false); }
    }
    async function support() {
      if (life.current.mutating) return;
      const generation = life.current.generation;
      life.current.mutating = true; setBusy(true); setError(null); setDownloaded(false);
      try {
        const response = await client('/components/support'), bytes = await decodeComponentsSupport(response, helpers.crypto || globalThis.crypto, helpers.atob || globalThis.atob);
        if (!life.current.mounted || generation !== life.current.generation) return;
        await (helpers.download || browserDownload)(response, bytes); if (life.current.mounted && generation === life.current.generation) setDownloaded(true);
      } catch (failed) { if (life.current.mounted && generation === life.current.generation) setError(failed.status === 403 ? 'ADMIN_REQUIRED' : failed.status === 401 ? 'AUTHENTICATION_REQUIRED' : code(failed.code || failed.message)); }
      finally { life.current.mutating = false; if (life.current.mounted && generation === life.current.generation) setBusy(false); }
    }
    const button = (action, label) => h('span', { title: data && !data.actions[action].available ? explanation(data.actions[action].reason || 'COMPONENT_ACTION_UNAVAILABLE') : undefined }, h('button', { className: `rv-components-${action}`, disabled: busy || loading || uncertain || !data?.actions[action]?.available, onClick: () => action === 'support' ? support() : setDialog(action) }, tr(label)));
    const componentRow = row => h('tr', { key: row.id },
      h('td', null, localized(row.label, row.id), h('small', null, row.id)),
      h('td', null, status(row.status)),
      h('td', null, row.dependsOn.length ? row.dependsOn.join(' → ') : tr('无依赖')),
      h('td', null, h('details', null,
        h('summary', null, tr('详情')), h('p', null, explanation(row.code)), h('small', null, text(row.kind)),
        ...(row.checks || []).map((check, index) => h('p', { key: index }, localized(check.label, text(check.id)), ' ', status(check.status), ' ', explanation(check.code))))));
    return h('section', { className: 'rv-components', 'aria-label': tr('组件状态') },
      h('div', { className: 'rv-components-toolbar' }, h('h3', null, tr('组件状态')), h('button', { className: 'rv-components-refresh', disabled: loading || busy, onClick: () => load(true) }, tr(loading ? '正在检查…' : '检查 / 刷新'))),
      h('p', { className: 'rv-components-note' }, tr('接口已注册不代表端到端功能已经验证；未知状态不视为正常。')),
      error && h('div', { role: 'alert' }, explanation(error)), uncertain && h('p', { role: 'alert' }, tr('操作结果尚未确认，已停止重复提交。请检查状态或使用 CLI 核实。')),
      data && h(React.Fragment, null,
        h('div', { className: 'rv-components-summary' }, status(data.overall), h('strong', null, `${tr('框架')} ${text(data.framework.version)}`), h('span', null, tr(data.framework.enabled ? '启用' : '已停用')),
          h('span', null, `CloudTower ${text(data.framework.compatibility?.observed?.towerVersion || data.framework.compatibility?.observed?.towerBuild, tr('未知'))}`),
          h('span', null, `SMTX OS ${observedSmtx()}`), h('small', null, `${tr('检查时间')} ${text(data.checkedAt)}`)),
        compatibility(data.framework.compatibility),
        data.components.length ? h('div', { className: 'rv-components-scroll', tabIndex: 0 }, h('table', null,
          h('thead', null, h('tr', null, ...['组件', '状态', '依赖', '详情'].map(value => h('th', { key: value }, tr(value))))),
          h('tbody', null, ...data.components.map(componentRow)))) : h('p', null, tr('暂无组件')),
        h('h4', null, tr('插件兼容性')), data.plugins.length ? data.plugins.map(row => h('article', { key: row.id, className: 'rv-components-plugin' }, h('strong', null, `${localized(row.name, row.id)} · ${tr('版本')} ${text(row.version)}`), h('small', null, row.id), h('p', null, `${tr('启用')}: ${row.enabled === true ? '✓' : '—'} · ${tr(row.active === true ? '运行中' : '未运行')}`), compatibility(row.compatibility))) : h('p', null, tr('暂无插件')),
        data.limitations.length > 0 && h('details', null, h('summary', null, tr('限制')), ...data.limitations.map((value, index) => h('p', { key: index }, explanation(value))))),
      h('p', { className: 'rv-components-note' }, tr('Web 修复将停用所有子插件，仅处理自身数据与缓存，并保留安装包、配置、凭据与历史；代码、Deployment、Ingress 或不可用后端需要使用 CLI。')),
      h('div', { className: 'rv-components-toolbar' }, button('repair', '修复'), button('reset', '重置'), button('support', '下载支持包')),
      result && h('div', { role: 'status', className: 'rv-components-result' }, h('strong', null, tr(result.result === 'success' ? '操作完成' : '部分完成')), h('code', null, result.operationId), ...result.outcomes.map((outcome, index) => h('p', { key: index }, id(outcome.id) ? outcome.id : '—', ' ', status(outcome.status), ' ', explanation(outcome.code))), result.requiresReload && h('p', null, tr('请刷新页面以加载变更。'))),
      downloaded && h('p', { role: 'status' }, tr('支持包已下载。')),
      dialog && h('div', { className: 'rv-components-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr(dialog === 'reset' ? '确认重置？' : '确认修复？') }, h('h4', null, tr(dialog === 'reset' ? '确认重置？' : '确认修复？')), h('p', null, tr(dialog === 'reset' ? '重置将停用所有子插件，保留安装包、配置、凭据与历史。' : 'Web 修复将停用所有子插件，仅处理自身数据与缓存，并保留安装包、配置、凭据与历史；代码、Deployment、Ingress 或不可用后端需要使用 CLI。')), h('button', { className: 'rv-components-cancel', disabled: busy, onClick: () => setDialog(null) }, tr('取消')), h('button', { className: `rv-components-confirm-${dialog}`, disabled: busy || uncertain, onClick: mutate }, tr(dialog === 'reset' ? '重置' : '修复'))));
  };
}
export const COMPONENTS_CSS = `
.rv-components { color:#253858; font-size:13px; }
.rv-components .rv-components-toolbar,.rv-components .rv-components-summary { display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0; }
.rv-components h3 { margin:0;flex:1; }
.rv-components .rv-components-note,.rv-components small { color:#61748e;line-height:1.6; }
.rv-components small { display:block; }
.rv-components .rv-components-scroll { overflow:auto; }
.rv-components table { border-collapse:collapse;width:100%;text-align:left; }
.rv-components th,.rv-components td { border-bottom:1px solid #e8edf5;padding:10px 8px;vertical-align:top;overflow-wrap:anywhere; }
.rv-components .rv-components-status { display:inline-flex;align-items:center;gap:5px;border-radius:10px;padding:2px 8px;font-size:12px;background:#eef1f5;color:#56667c; }
.rv-components .rv-components-status:before { content:'';display:inline-block;width:6px;height:6px;background:currentColor;border-radius:50%; }
.rv-components .rv-components-ok { color:#18794e;background:#e8f7ee; }.rv-components .rv-components-warning { color:#946200;background:#fff4d6; }.rv-components .rv-components-failed { color:#c42336;background:#fff0f1; }
.rv-components .rv-components-compat,.rv-components .rv-components-plugin { margin:12px 0;padding:12px;border:1px solid #e8edf5;border-radius:6px; }
.rv-components .rv-components-fields { display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:6px;overflow-wrap:anywhere; }.rv-components dd { margin:0; }
.rv-components .rv-components-reset,.rv-components .rv-components-confirm-reset { color:#d92338;background:#fff;border:1px solid #f1c3c9; }
.rv-components .rv-components-cancel { color:#222;background:#f1f3f6;border:1px solid #d6dce5; }.rv-components .rv-components-confirm-repair { color:white;background:#1683ff;border:1px solid #1683ff; }
.rv-components .rv-components-confirm { padding:16px;border:1px solid #c6d2e4;border-radius:8px;background:white;box-shadow:0 8px 24px #2538581a;margin-top:12px; }.rv-components .rv-components-confirm button { margin-right:8px; }
.rv-components [role=alert] { color:#b91c35;padding:8px 0; }.rv-components button:disabled { opacity:.5;cursor:not-allowed; }
`;
