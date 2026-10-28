export const normalizeLocale = value => /^en(?:-|$)/i.test(value || '') ? 'en-US' : 'zh-CN';
export function towerLocale(win, supplied) {
  if (supplied) return normalizeLocale(supplied);
  try { const value = JSON.parse(win.localStorage.getItem('language') || 'null')?.value; if (['zh-CN', 'en-US'].includes(value)) return value; } catch { /* Use the host document language. */ }
  return normalizeLocale(win.document.documentElement.lang);
}
export function watchTowerLocale(win, onChange, supplied) {
  const read = () => onChange(towerLocale(win, supplied));
  const observer = new win.MutationObserver(read);
  observer.observe(win.document.documentElement, { attributes: true, attributeFilter: ['lang'] }); read();
  win.addEventListener('storage', read); const timer = win.setInterval(read, 3000);
  return () => { observer.disconnect(); win.removeEventListener('storage', read); win.clearInterval(timer); };
}
const en = {
  FRAMEWORK_TOWER_INCOMPATIBLE: 'This CloudTower version is outside the framework verified range. Framework execution is disabled.',
  FRAMEWORK_VERSION_UNKNOWN: 'The framework version could not be verified. Compatibility remains unknown.',
  PLUGIN_COMPATIBILITY_INVALID: 'The plugin compatibility declaration is invalid. Installation and activation are blocked.',
  SMTX_SNAPSHOT_UNAVAILABLE: 'SMTX version evidence is unavailable. Compatibility remains unknown.',
  SMTX_SNAPSHOT_INVALID: 'SMTX version evidence is invalid. Compatibility remains unknown.',
  SMTX_SNAPSHOT_EXPIRED: 'SMTX version evidence has expired. Refresh trusted inventory before proceeding.',
  SMTX_SCOPE_UNTRUSTED: 'The completeness and authority of SMTX inventory could not be verified. Compatibility remains unknown.',
  SMTX_SCOPE_INCOMPLETE: 'SMTX inventory is incomplete. Partial inventory cannot establish compatibility.',
  SMTX_SCOPE_EMPTY: 'No managed SMTX product matches the plugin declared applicability scope.',
  SMTX_VERSION_UNKNOWN: 'The managed SMTX product version could not be verified. Compatibility remains unknown.',
  SMTX_INCOMPATIBLE: 'A managed SMTX product version is outside the plugin declared verified range. Plugin execution is blocked.',
  '组件状态': 'Component status',
  '插件市场': 'Plugin marketplace',
  '未声明已验证的兼容版本': 'No verified compatible versions declared', '与当前 CloudTower 版本不兼容': 'Incompatible with the current CloudTower version', '已验证版本': 'Verified versions',
  'PLUGIN_INCOMPATIBLE': 'This plugin does not support the current CloudTower or framework version.', 'TOWER_BUILD_UNKNOWN': 'The CloudTower version could not be verified; installation and activation were blocked.', 'PLUGIN_COMPATIBILITY_UNDECLARED': 'The plugin has no machine-readable verified version declaration.',
  'UPDATE_METADATA_MISMATCH': 'The downloaded package metadata does not match the published catalog.',
  '正在检测更新源…': 'Checking update source…', '无法连接到更新源': 'Cannot connect to the update source',
  '检查更新': 'Check for updates', '有新版本': 'New version', '已是最新版本': 'Up to date', '选择升级方式': 'Choose upgrade method', '自动联网升级': 'Upgrade online', '手动上传升级': 'Upload upgrade package',
  'UPDATE_SOURCE_ACCESS_REQUIRED': 'Access to the website update source was denied. Retry or upload a package manually.',
  'UPDATE_SOURCE_RATE_LIMITED': 'The update source is rate limited. Retry later.',
  'UPDATE_SOURCE_UNAVAILABLE': 'The update source is unavailable. Please retry or upload a package manually.', 'UPDATE_PACKAGE_UNPUBLISHED': 'The update package has not been published.', 'UPDATE_NOT_AVAILABLE': 'No newer version is available.', 'UPDATE_CHECKSUM_FAILED': 'The downloaded package failed integrity verification.',
  '内容': 'Details', '记录详情': 'Record details', '记录编号': 'Record ID', '错误码': 'Error code',
  '升级': 'Upgrade', '关于': 'About', '正在检查插件状态': 'Checking plugin status', '插件状态不可用': 'Plugin status unavailable', '插件已启用': 'Plugins enabled', '插件已停用': 'Plugins disabled',
  'PLUGIN_ID_MISMATCH': 'The package belongs to a different plugin.',
  '插件中心': 'Plugin Center', '插件配置': 'Plugin settings', '插件设置': 'Plugin settings', '插件管理': 'Plugin management', '操作日志': 'Activity log', '全局偏好': 'Preferences',
  '个人偏好设置仅在当前浏览器生效。': 'Personal preferences apply to this browser only.',
  '显示右下角插件按钮': 'Show floating plugin button', '关闭后，仍可通过主菜单 → 插件配置打开本面板。': 'You can also open settings from the main menu.',
  '当前菜单结构尚未识别，临时保留悬浮入口，避免无法打开设置。': 'The main-menu entry is unavailable. The floating button remains visible.',
  '保存': 'Save', '保存中…': 'Saving…', '完成': 'Done', '取消': 'Cancel', '丢弃并退出': 'Discard and exit', '保存并退出': 'Save and exit', '存在未保存的更改': 'Unsaved changes', '是否保存当前修改后退出？': 'Save your changes before exiting?',
  '免责声明': 'Disclaimer', '关闭插件配置': 'Close plugin settings', '关闭提示': 'Dismiss', '重新读取': 'Reload', '重试': 'Retry',
  '已启用': 'Enabled', '已禁用': 'Disabled', '已暂停': 'Suspended', '成功': 'Success', '失败': 'Failed', '开始': 'Started', '已安装': 'Installed', '未安装': 'Not installed', '版本': 'Version', '状态': 'Status', '操作': 'Actions', '时间': 'Time', '操作者': 'Operator', '对象': 'Target', '结果': 'Result',
  '上传插件包': 'Upload plugin package', '安装': 'Install', '更新': 'Update', '回滚': 'Roll back', '启用': 'Enable', '禁用': 'Disable', '重置': 'Reset', '卸载': 'Uninstall', '刷新': 'Refresh', '加载更多': 'Load more',
  '确认操作': 'Confirm action', '确认': 'Confirm', '处理中…': 'Processing…', '暂无日志': 'No activity yet', '暂无插件': 'No plugins available',
  '紧急禁用全部插件': 'Disable all plugins', '恢复插件运行': 'Resume plugins', '框架运行': 'Framework running', '插件已全部停用': 'All plugins suspended',
  '故障隔离：TODO': 'Fault isolation: TODO', '本地演示身份': 'Local demo identity', '仅本地日志': 'Local log only', 'Tower 审计待接入': 'Tower audit integration pending',
  '关闭': 'Close', '插件包': 'Plugin package', '权限': 'Permissions', '卸载保留配置；重置前自动备份。': 'Uninstall retains settings. Reset creates a backup first.',
  '重置将恢复默认配置，并备份当前配置。': 'Reset restores defaults and backs up the current settings.',
  '卸载将停用并移除插件注册，保留配置与安装包。': 'Uninstall removes the active registration and retains settings and packages.',
  '更新或回滚后插件保持禁用，请核对后重新启用。': 'Updates and rollbacks leave the plugin disabled. Review it before enabling.',
  '全部插件将停止运行，插件中心仍可用于恢复。': 'All plugins will stop. Plugin Center remains available for recovery.',
  '安装后默认禁用，请核对后启用。': 'New installations are disabled until explicitly enabled.',
  '确认启用此插件？': 'Enable this plugin?', '确认禁用此插件？': 'Disable this plugin?', '确认恢复已启用插件的运行？': 'Resume enabled plugins?',
  '请先保存或丢弃配置修改。': 'Save or discard configuration changes first.', '请求失败，请刷新后重试。': 'The request failed. Refresh and try again.',
  '资产清单暂不可用，请检查读取权限后重试。': 'Inventory is unavailable. Check read permissions and retry.',
  '共享配置读取失败，请重试。': 'Shared settings could not be loaded. Please retry.', '未能确认保存成功，修改已保留，请重试。': 'The save could not be confirmed. Your draft has been retained.',
  '集群数量超过配置容量，未自动补全规则。': 'The cluster count exceeds the settings limit. Rules were not generated.',
  'IPMI 跳转': 'IPMI Redirection', '点击主机概览中的 IPMI 地址，打开对应 BMC。': 'Open the BMC from the IPMI address on a host overview.',
  '启用 IPMI 地址跳转': 'Enable IPMI redirection', '在新标签页打开': 'Open in a new tab', '登录方式': 'Login method', '打开 BMC 登录页': 'Open BMC login page',
  '厂商自动登录 · 模拟': 'Vendor auto-login · simulated', '厂商自动登录 · 待接入': 'Vendor auto-login · unavailable',
  'BMC 全局与例外': 'BMC defaults and exceptions', '全局默认厂商协议': 'Default BMC protocol', '未命中例外时使用此配置。': 'Used when no exception matches.',
  '例外规则': 'Exceptions', '+ 添加例外': '+ Add exception', '正在读取可见的集群与主机…': 'Loading accessible clusters and hosts…',
  '尚无例外。所有主机继承全局默认。': 'No exceptions. All hosts use the default.', '删除例外': 'Delete exception', '范围': 'Scope', '集群': 'Cluster', '特定主机': 'Specific host', '主机': 'Host',
  '选择集群': 'Select cluster', '选择主机': 'Select host', '原配置对象暂不可见': 'Configured object is currently unavailable', '厂商协议': 'Vendor protocol',
  '主机例外': 'Host exception', '集群例外': 'Cluster exception', '全局默认': 'Global default', '待确认': 'Unknown', '等待集群归属信息': 'Waiting for cluster information',
  'MegaRAC 当前仅支持本地模拟自动登录。': 'MegaRAC auto-login is currently simulated locally.',
  '优先级：主机例外 → 集群例外 → 全局默认。空对象规则不生效。': 'Priority: host → cluster → global. Rules without a target do not apply.',
  '查阅厂商': 'Vendor', '全部厂商': 'All vendors', 'Redfish 会话接口已实现。': 'Redfish session API implemented.',
  '已收录兼容机型，当前提供登录页跳转。': 'Compatible models listed; login-page redirection is available.',
  '服务器清单来自 SmartX 兼容性列表，BMC 协议支持需结合实际控制器与固件确认。': 'The model list comes from SmartX. Confirm BMC support against the controller and firmware.',
  '厂商公开接口文档 ↗': 'Public vendor API documentation ↗', '兼容服务器型号': 'Compatible server models', 'SmartX 兼容性列表 ↗': 'SmartX compatibility list ↗',
  '打开此主机的 IPMI 登录页': 'Open the IPMI login page for this host', '浏览器阻止了新窗口，请允许弹出窗口后重试。': 'The browser blocked the window. Allow pop-ups and retry.',
  '无法建立登录会话，请使用普通跳转重试。': 'Could not create a login session. Open the login page instead.',
  '通用 BMC · 仅跳转': 'Generic BMC · redirection only',
};
const errorChinese = {
  FRAMEWORK_TOWER_INCOMPATIBLE: '当前 CloudTower 版本不在框架已验证范围内，框架执行已停用。',
  FRAMEWORK_VERSION_UNKNOWN: '无法确认框架版本，兼容性仍为未知。',
  PLUGIN_COMPATIBILITY_INVALID: '插件兼容性声明无效，已阻止安装和启用。',
  SMTX_SNAPSHOT_UNAVAILABLE: '无法获取 SMTX 版本证据，兼容性仍为未知。',
  SMTX_SNAPSHOT_INVALID: 'SMTX 版本证据无效，兼容性仍为未知。',
  SMTX_SNAPSHOT_EXPIRED: 'SMTX 版本证据已过期，请刷新可信库存后再操作。',
  SMTX_SCOPE_UNTRUSTED: '无法确认 SMTX 库存的完整性和可信范围，兼容性仍为未知。',
  SMTX_SCOPE_INCOMPLETE: 'SMTX 库存不完整，不能使用部分库存判定兼容。',
  SMTX_SCOPE_EMPTY: '没有受管 SMTX 产品符合插件声明的适用范围。',
  SMTX_VERSION_UNKNOWN: '无法确认受管 SMTX 产品版本，兼容性仍为未知。',
  SMTX_INCOMPATIBLE: '受管 SMTX 产品版本不在插件声明的已验证范围内，已阻止插件执行。',
  SSH_PERMISSION_REQUIRED: '插件未声明 SSH 通道使用权限，已拒绝注册。', SSH_OPERATION_REJECTED: '该操作不在框架允许的只读采集目录中，已拒绝注册。', SSH_REGISTRATION_INVALID: 'SSH 注册声明无效，不接受任意命令、脚本或参数。', SSH_TARGET_LIMIT: '展开后的采集目标超过限制，请缩小范围后重新审核。',
  PLUGIN_INCOMPATIBLE: '该插件不兼容当前 CloudTower 或框架版本，已停止操作。', TOWER_BUILD_UNKNOWN: '无法确认 CloudTower 版本，已阻止安装和启用。', PLUGIN_COMPATIBILITY_UNDECLARED: '该插件尚未声明可校验的已验证版本，已停止操作。', UPDATE_METADATA_MISMATCH: '下载包的元数据与已发布清单不一致，已拒绝使用。',
  INVALID_PACKAGE: '插件包格式无效，请选择有效的 Rivetin 插件包。',
  PLUGIN_ID_MISMATCH: '安装包所属插件与当前插件不一致。',
  UPDATE_SOURCE_ACCESS_REQUIRED: '官网更新源拒绝访问，请稍后重试或手动上传插件包。',
  UPDATE_SOURCE_RATE_LIMITED: '更新源请求过于频繁，请稍后重试。',
  UPDATE_SOURCE_UNAVAILABLE: '暂时无法连接更新源，请稍后重试或手动上传升级。',
  UPDATE_PACKAGE_UNPUBLISHED: '该版本的升级包尚未发布。', UPDATE_NOT_AVAILABLE: '当前没有可用的新版本。',
  UPDATE_CHECKSUM_FAILED: '升级包摘要校验失败，已停止升级。', UPDATE_IDENTITY_MISMATCH: '升级包的插件标识或版本与清单不一致。',
  UPDATE_CATALOG_INVALID: '更新清单格式无效，请联系项目维护者。', UPDATE_REDIRECT_REJECTED: '更新源返回了不受信任的下载地址。', UPDATE_DOWNLOAD_TOO_LARGE: '升级包超过大小限制。',
};
const actions = {
  'market.install': ['从插件市场安装', 'Install from marketplace'], 'ssh.approve': ['批准 SSH 采集权限', 'Approve SSH collection access'], 'ssh.revoke': ['撤销 SSH 采集权限', 'Revoke SSH collection access'], 'ssh.run': ['执行 SSH 采集', 'Run SSH collection'], 'ssh.schedule': ['处理 SSH 采集计划', 'Process SSH collection schedule'], 'ssh.host.save': ['保存 SSH 主机连接', 'Save SSH host connection'], 'ssh.host.remove': ['移除 SSH 主机连接', 'Remove SSH host connection'],
  'framework.migrate': ['迁移框架管理权', 'Migrate framework management'],
  'framework.update': ['更新框架', 'Update framework'], 'framework.uninstall': ['卸载框架', 'Uninstall framework'], 'framework.rollback': ['回滚框架', 'Roll back framework'],
  'framework.install': ['安装框架', 'Install framework'], 'framework.enable': ['恢复插件运行', 'Resume plugins'], 'framework.disable': ['紧急禁用全部插件', 'Disable all plugins'],
  'package.upload': ['上传插件包', 'Upload package'], 'plugin.install': ['安装插件', 'Install plugin'], 'plugin.update': ['更新插件', 'Update plugin'],
  'updates.check': ['检查插件更新', 'Check plugin updates'], 'plugin.download': ['下载升级包', 'Download upgrade package'],
  'plugin.enable': ['启用插件', 'Enable plugin'], 'plugin.disable': ['禁用插件', 'Disable plugin'], 'plugin.reset': ['重置插件', 'Reset plugin'], 'plugin.uninstall': ['卸载插件', 'Uninstall plugin'],
  'plugin.rollback': ['回滚插件', 'Roll back plugin'], 'configuration.save': ['保存配置', 'Save settings'], 'configuration.migrate': ['迁移配置', 'Migrate settings'],
};
export function actionLabel(action, locale) {
  const start = action.endsWith('.started'), key = start ? action.slice(0, -8) : action, english = normalizeLocale(locale) === 'en-US';
  const label = actions[key]?.[english ? 1 : 0] || key;
  return start ? `${label} · ${english ? 'Started' : '开始'}` : label;
}
export function translator(locale) {
  const english = normalizeLocale(locale) === 'en-US';
  return (zh, fallback) => english ? (en[zh] || fallback || zh) : (errorChinese[zh] || zh);
}
export function vendorLabel(vendor, locale) {
  if (normalizeLocale(locale) !== 'en-US') return vendor.label;
  if (vendor.id === 'generic') return 'Generic BMC · redirection only';
  return vendor.label.replace('联想', 'Lenovo').replace('超聚变', 'xFusion').replace('浪潮', 'Inspur').replace('宁畅', 'Ningchang').replace('宝德', 'PowerLeader').replace('中科可控', 'Suma');
}
