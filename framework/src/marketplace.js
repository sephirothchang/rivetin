import { validId } from '../shared/identity.js';
const CSS = '.pk-market-header,.pk-market-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.pk-market-header h3{margin:0}.pk-market-current{font-size:12px;color:#71849b;overflow-wrap:anywhere;margin:10px 0 16px}.pk-market-note{border:1px solid #dce7f3;border-radius:7px;padding:12px 14px;background:#f5f8fc;line-height:1.7;margin:14px 0}.pk-market-error{background:#fff1f0;border-color:#ffd3ce;color:#a52c38}.pk-market-empty{padding:30px 12px;color:#71849b;text-align:center}.pk-market-card{border:1px solid #dce5ef;border-radius:9px;padding:17px;margin:14px 0}.pk-market-card h4{margin:0}.pk-market-card p{line-height:1.7;margin:10px 0}.pk-market-meta{font-size:12px;color:#71849b;overflow-wrap:anywhere}.pk-market-tag{font-size:12px;border-radius:10px;padding:2px 8px;background:#eef7f0;color:#237b42;white-space:nowrap}.pk-market-tag-muted{background:#f1f3f6;color:#62748c}.pk-market-card dl,.pk-market-confirm dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 14px;line-height:1.6}.pk-market-card dt,.pk-market-confirm dt{color:#71849b}.pk-market-card dd,.pk-market-confirm dd{margin:0;overflow-wrap:anywhere}.pk-market-confirm-backdrop{position:fixed;inset:0;background:#142c4b66;z-index:1600;display:grid;place-items:center;padding:24px}.pk-market-confirm{background:white;border-radius:12px;box-shadow:0 20px 70px #102b4a44;width:min(680px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:24px;color:#243650;font-size:13px}.pk-market-confirm h3{margin:0 0 16px}.pk-market-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.pk-market-confirm button{font:inherit;border:1px solid #d7e3f0;border-radius:6px;padding:8px 14px;cursor:pointer;background:#f1f3f5;color:#222}.pk-market-confirm .pk-market-install{background:#087ef5;border-color:#087ef5;color:white}.pk-market button:disabled,.pk-market-confirm button:disabled{opacity:.5;cursor:default}.pk-market button:focus-visible,.pk-market-confirm button:focus-visible{outline:2px solid #1385ee;outline-offset:3px}@media(max-width:620px){.pk-market-card dl,.pk-market-confirm dl{grid-template-columns:1fr;gap:3px}.pk-market-card dd,.pk-market-confirm dd{margin-bottom:8px}.pk-market-confirm{padding:18px}}';
const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const localized = (value, locale) => typeof value === 'string' ? text(value) : text(value?.[locale] || value?.[locale === 'en-US' ? 'enUS' : 'zhCN'] || value?.['en-US'] || value?.enUS);
const version = value => typeof value === 'string' && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value);
const checksum = item => [item?.sha256, item?.packageSha256, item?.packageId].find(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const builds = item => Array.isArray(item?.compatibility?.towerBuilds) ? item.compatibility.towerBuilds.filter(value => typeof value === 'string' && value.length > 0 && value.length < 300).slice(0, 100) : [];
const installable = (item, source, towerBuild) => typeof towerBuild === 'string' && towerBuild.length > 0 && source?.reachable === true && validId(item?.id) && version(item.version) && item.published === true && item.downloadable === true && item.compatible === true && item.installed !== true && Boolean(checksum(item)) && builds(item).length > 0;
const errors = {
  PLUGIN_INCOMPATIBLE: ['插件不兼容当前 CloudTower 或框架版本，已停止安装。', 'The plugin is incompatible with this CloudTower or framework version; installation was stopped.'],
  TOWER_BUILD_UNKNOWN: ['无法确认 CloudTower 版本，已停止安装。', 'The CloudTower version could not be verified; installation was stopped.'],
  PLUGIN_COMPATIBILITY_UNDECLARED: ['插件未声明已验证版本，已停止安装。', 'The plugin has no verified version declaration; installation was stopped.'],
  UPDATE_METADATA_MISMATCH: ['安装包与市场清单的元数据不一致，已拒绝使用。', 'Package metadata differs from the published catalog and was rejected.'],
  MARKETPLACE_UNAVAILABLE: ['暂时无法连接插件市场，请稍后重试。', 'The marketplace is unavailable. Please retry later.'],
  UPDATE_SOURCE_UNAVAILABLE: ['暂时无法连接插件市场，请稍后重试。', 'The marketplace is unavailable. Please retry later.'],
  UPDATE_SOURCE_ACCESS_REQUIRED: ['插件市场访问受限，请检查服务端更新源配置。', 'Marketplace access is restricted. Check the server-side source configuration.'],
  UPDATE_CATALOG_INVALID: ['市场清单无效，已停止安装。', 'The marketplace catalog is invalid; installation was stopped.'],
  MARKETPLACE_RESPONSE_INVALID: ['市场响应无法验证，请刷新后重试。', 'The marketplace response could not be verified. Refresh and retry.'],
  MARKETPLACE_INSTALL_UNCONFIRMED: ['安装结果尚未确认。请刷新状态进行核对，不要重复提交安装。', 'Installation is not yet confirmed. Refresh to verify the result instead of submitting it again.'],
  MARKETPLACE_INSTALL_NOT_DISABLED: ['插件状态与预期不一致，请到插件管理核对；不会自动更改其启用状态。', 'The plugin state differs from the expected disabled installation. Review it in Plugin management; its enabled state will not be changed automatically.'],
  UPDATE_CHECKSUM_FAILED: ['安装包摘要校验失败，已停止安装。', 'Package integrity verification failed; installation was stopped.'],
  MARKETPLACE_INCOMPATIBLE: ['此插件未通过当前 CloudTower 构建的兼容性验证。', 'This plugin has not been verified for the current CloudTower build.'],
  MARKETPLACE_PACKAGE_UNPUBLISHED: ['该版本尚无可下载安装包。', 'This version has no published downloadable package.'],
  UPDATE_PACKAGE_UNPUBLISHED: ['该版本尚无可下载安装包。', 'This version has no published downloadable package.'],
  PLUGIN_INCOMPATIBLE: ['此插件与当前 CloudTower 或框架版本不兼容，已停止安装。', 'This plugin is incompatible with the current CloudTower or framework version; installation was stopped.'],
  PLUGIN_COMPATIBILITY_UNDECLARED: ['此插件未声明已验证的 CloudTower 构建，已停止安装。', 'This plugin declares no tested CloudTower builds; installation was stopped.'],
  TOWER_BUILD_UNKNOWN: ['无法识别当前 CloudTower 构建，已停止安装。', 'The current CloudTower build is unknown; installation was stopped.'],
  PLUGIN_ALREADY_INSTALLED: ['该插件已安装，请通过插件管理进行升级。', 'The plugin is already installed. Use Plugin management to upgrade it.'],
  REQUEST_FAILED: ['请求未完成，请刷新后重试。', 'The request could not be completed. Refresh and retry.'],
};

export function createMarketplace(React) {
  const h = React.createElement, { useEffect, useRef, useState } = React;
  return function Marketplace({ client, locale = 'zh-CN', onInstalled, onError }) {
    const en = locale === 'en-US', t = (zh, english) => en ? english : zh;
    const [catalog, setCatalog] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [selection, setSelection] = useState(null), [uncertain, setUncertain] = useState(false), [message, setMessage] = useState('');
    const alive = useRef(false), generation = useRef(0), dialog = useRef(null), previousFocus = useRef(null);
    function fail(failure) {
      const code = Object.hasOwn(errors, failure?.message) ? failure.message : 'REQUEST_FAILED';
      if (alive.current) { setError(code); onError?.(code); }
    }
    async function readCatalog() {
      const value = await client('/marketplace');
      if (!value || !Array.isArray(value.items) || typeof value.source?.reachable !== 'boolean' || !(value.towerBuild === null || typeof value.towerBuild === 'string')) throw new Error('MARKETPLACE_RESPONSE_INVALID');
      return { ...value, items: value.items.filter(item => item && typeof item === 'object').slice(0, 200) };
    }
    async function refresh() {
      if (busy) return;
      setBusy(true); setError(''); const current = ++generation.current;
      try {
        const value = await readCatalog();
        if (alive.current && current === generation.current) { setCatalog(value); setSelection(null); setUncertain(false); }
      } catch (failure) { if (alive.current && current === generation.current) { setCatalog(previous => previous ? { ...previous, source: { reachable: false } } : null); fail(failure); } }
      finally { if (alive.current && current === generation.current) setBusy(false); }
    }
    useEffect(() => {
      alive.current = true; const current = ++generation.current; setBusy(true);
      readCatalog().then(value => { if (alive.current && current === generation.current) setCatalog(value); }).catch(failure => { if (alive.current && current === generation.current) fail(failure); }).finally(() => { if (alive.current && current === generation.current) setBusy(false); });
      return () => { alive.current = false; generation.current++; };
    }, [client]);
    useEffect(() => {
      if (!selection) return;
      const root = dialog.current; previousFocus.current = document.activeElement;
      (root?.querySelector('button:not(:disabled)') || root)?.focus();
      function keydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setSelection(null); }
        if (event.key === 'Tab') {
          event.stopPropagation(); const nodes = [...root.querySelectorAll('button:not(:disabled)')], first = nodes[0], last = nodes.at(-1);
          if (!nodes.length) { event.preventDefault(); root.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      root?.addEventListener('keydown', keydown);
      return () => { root?.removeEventListener('keydown', keydown); previousFocus.current?.focus?.(); };
    }, [selection, busy, uncertain]);
    async function install() {
      if (busy || uncertain || !installable(selection, catalog?.source, catalog?.towerBuild)) return;
      setBusy(true); setError(''); const current = ++generation.current, item = selection;
      let failure;
      try { await client('/marketplace', 'POST', { action: 'install', pluginId: item.id, version: item.version }); }
      catch (error) { failure = error; }
      if (!alive.current || current !== generation.current) return;
      try {
        const listing = await client('/plugins'), installed = listing?.items?.find(record => record.id === item.id && record.installed === true);
        if (!installed || installed.version !== item.version) throw failure || new Error('MARKETPLACE_INSTALL_UNCONFIRMED');
        if (installed.enabled !== false || installed.active === true || installed.error) throw new Error('MARKETPLACE_INSTALL_NOT_DISABLED');
        if (!alive.current || current !== generation.current) return;
        setCatalog(previous => ({ ...previous, items: previous.items.map(candidate => candidate.id === item.id ? { ...candidate, installed: true, installedVersion: item.version } : candidate) }));
        setSelection(null); setUncertain(false); setMessage(item.id);
        try { await onInstalled?.(installed); } catch { fail(new Error('REQUEST_FAILED')); }
      } catch (verificationFailure) {
        if (alive.current && current === generation.current) { setUncertain(true); fail(verificationFailure); }
      } finally { if (alive.current && current === generation.current) setBusy(false); }
    }
    function metadata(item) {
      const testedBuilds = builds(item), permissions = Array.isArray(item.permissions) ? item.permissions.filter(value => typeof value === 'string').slice(0, 20) : [];
      return h('dl', null,
        h('dt', null, t('版本', 'Version')), h('dd', null, text(item.version)),
        h('dt', null, t('权限声明', 'Declared permissions')), h('dd', null, permissions.length ? permissions.map(text).join(', ') : t('无额外权限声明', 'No additional permissions declared')),
        h('dt', null, t('已验证构建', 'Tested builds')), h('dd', null, testedBuilds.length ? testedBuilds.join('\n') : t('尚未提供', 'Not provided')),
        h('dt', null, 'SHA-256'), h('dd', null, checksum(item) || t('尚未发布有效摘要', 'No valid published digest')));
    }
    function unavailableReason(item) {
      if (item.installed === true) return t('已安装的插件请通过插件管理进行升级。', 'Upgrade installed plugins through Plugin management.');
      if (!catalog?.towerBuild) return t('无法识别当前 CloudTower 构建，禁止安装。', 'The current CloudTower build is unknown; installation is disabled.');
      if (item.compatible !== true || !builds(item).length) return t('未验证与当前 CloudTower 构建兼容，暂不可安装。', 'Compatibility with this CloudTower build is not verified; installation is unavailable.');
      if (item.published !== true || item.downloadable !== true || !checksum(item)) return t('该版本尚无可验证的已发布安装包。', 'This version has no verifiable published package.');
      if (catalog?.source.reachable !== true) return t('无法连接到插件市场，请重试。', 'Cannot connect to the marketplace. Retry to continue.');
      return '';
    }
    const errorMessage = error && errors[error]?.[en ? 1 : 0];
    return h('div', { className: 'pk-market' }, h('style', null, CSS),
      h('div', { className: 'pk-market-header' }, h('h3', null, t('插件市场', 'Plugin marketplace')), h('button', { disabled: busy, onClick: refresh }, busy ? t('正在读取…', 'Loading…') : t('刷新市场', 'Refresh marketplace'))),
      errorMessage && !selection && h('p', { className: 'pk-market-note pk-market-error', role: 'alert' }, errorMessage),
      catalog && h('p', { className: 'pk-market-current' }, t('当前 CloudTower 构建：', 'Current CloudTower build: ') + (text(catalog.towerBuild) || t('未知，禁止安装', 'Unknown; installation disabled'))),
      catalog?.source.reachable === false && h('p', { className: 'pk-market-note pk-market-error', role: 'status' }, t('暂时无法连接插件市场，安装已停用。可点击“刷新市场”重试；已安装插件不受此连接状态影响。', 'The marketplace cannot be reached; installation is disabled. Select Refresh marketplace to retry. Installed plugins are unaffected by this connection status.')),
      message && h('p', { className: 'pk-market-note', role: 'status' }, t(`${message} 已安装，当前保持禁用。请到插件管理核对后启用。`, `${message} was installed and remains disabled. Review it in Plugin management before enabling.`)),
      !catalog ? h('p', { className: 'pk-market-empty' }, busy ? t('正在连接插件市场…', 'Connecting to the marketplace…') : t('暂无可显示的市场数据。', 'No marketplace data is available.')) : !catalog.items.length ? h('p', { className: 'pk-market-empty' }, t('当前市场暂无已发布的插件条目。', 'The marketplace currently lists no published plugins.')) : catalog.items.map(item => h('article', { className: 'pk-market-card', key: `${item.id}-${item.version}` },
        h('div', { className: 'pk-market-row' }, h('h4', null, localized(item.name, locale) || text(item.id)), h('span', { className: `pk-market-tag ${item.installed || item.compatible ? '' : 'pk-market-tag-muted'}` }, item.installed ? t('已安装', 'Installed') : item.compatible ? t('兼容', 'Compatible') : t('未验证兼容', 'Compatibility unverified'))),
        h('div', { className: 'pk-market-meta' }, text(item.id)), h('p', null, localized(item.description, locale) || t('暂无插件描述。', 'No plugin description available.')),
        metadata(item), item.installedVersion && h('p', { className: 'pk-market-meta' }, t('已安装版本：', 'Installed version: ') + text(item.installedVersion)),
        unavailableReason(item) && h('p', { className: 'pk-market-meta' }, unavailableReason(item)),
        h('button', { className: 'pk-market-select', disabled: busy || !installable(item, catalog.source, catalog.towerBuild), onClick: () => { if (installable(item, catalog.source, catalog.towerBuild)) { setSelection(item); setUncertain(false); setError(''); } } }, item.installed ? t('已安装', 'Installed') : t('安装', 'Install')))),
      selection && h('div', { className: 'pk-market-confirm-backdrop' }, h('section', { ref: dialog, tabIndex: -1, className: 'pk-market-confirm', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'pk-market-confirm-title' },
        h('h3', { id: 'pk-market-confirm-title' }, t('确认安装插件', 'Confirm plugin installation')),
        h('strong', null, localized(selection.name, locale) || text(selection.id)), h('p', { className: 'pk-market-meta' }, text(selection.id)), metadata(selection),
        h('p', { className: 'pk-market-note' }, t('安装后默认禁用。安装不会自动授权 SSH 能力，也不会自动启用插件，请在插件管理中核对后操作。', 'The plugin will be installed disabled. Installation grants no SSH access and does not activate the plugin; review it in Plugin management before enabling it.')),
        errorMessage && h('p', { className: 'pk-market-note pk-market-error', role: 'alert' }, errorMessage),
        h('div', { className: 'pk-market-actions' }, h('button', { disabled: busy, onClick: () => setSelection(null) }, t('取消', 'Cancel')), h('button', { className: 'pk-market-install', disabled: busy || uncertain || !installable(selection, catalog?.source, catalog?.towerBuild), onClick: install }, busy ? t('正在安装…', 'Installing…') : t('确认安装', 'Confirm install'))))));
  };
}
