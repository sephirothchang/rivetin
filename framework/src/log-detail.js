const errors = {
  UPDATE_SOURCE_ACCESS_REQUIRED: ['更新源访问被拒绝；私有仓库需要服务端访问凭据。', 'Update-source access was denied. A private repository requires server-side credentials.'],
  UPDATE_SOURCE_UNAVAILABLE: ['无法连接 GitHub 更新源，请稍后重试或手动上传。', 'GitHub could not be reached. Retry or upload a package manually.'],
  UPDATE_CHECKSUM_FAILED: ['下载内容的 SHA-256 与发布清单不一致，已拒绝使用。', 'The downloaded content does not match the catalog SHA-256 and was rejected.'],
  UPDATE_CATALOG_INVALID: ['GitHub 版本清单格式无效。', 'The GitHub version catalog is invalid.'],
  UPDATE_PACKAGE_UNPUBLISHED: ['该版本没有已发布的升级包。', 'This version has no published upgrade package.'],
  INVALID_SETTINGS: ['配置内容不符合插件的配置规则。', 'Settings do not match the plugin schema.'],
  CONFIGURATION_INVALID: ['已保存的配置无效，请检查或备份后重置。', 'Stored settings are invalid. Review or back up and reset them.'],
  STORE_BUSY: ['配置存储正忙，请稍后重试。', 'The settings store is busy. Retry shortly.'],
  MIGRATION_REQUIRED: ['配置格式发生变化，需要受支持的迁移流程。', 'The configuration schema changed and requires a supported migration.'],
  UPDATE_VERSION_MUST_INCREASE: ['升级包版本必须高于当前版本。', 'The upgrade version must be newer than the installed version.'],
  VERSION_ALREADY_INSTALLED: ['该版本已经安装。', 'This version is already installed.'],
  PLUGIN_ID_MISMATCH: ['安装包所属插件与目标插件不一致。', 'The package belongs to a different plugin.'],
  NO_PREVIOUS_VERSION: ['没有可回滚的历史版本。', 'No previous version is available.'],
  INVALID_PACKAGE: ['无法解析插件包。', 'The plugin package could not be parsed.'],
  INVALID_MANIFEST: ['插件描述文件无效。', 'The plugin manifest is invalid.'],
  INVALID_PACKAGE_FILE: ['插件包包含无效的文件路径或内容。', 'The package contains an invalid file path or content.'],
  PACKAGE_INTEGRITY_FAILED: ['插件包摘要校验失败。', 'Package integrity verification failed.'],
  PACKAGE_TOO_LARGE: ['插件包超过大小限制。', 'The package exceeds the size limit.'],
  DATA_UNAVAILABLE: ['无法读取持久化数据。', 'Persistent data could not be read.'],
  EACCES: ['存储访问被拒绝，请检查服务账户权限。', 'Storage access was denied. Check service-account permissions.'],
  ENOSPC: ['存储空间不足。', 'Storage space is exhausted.'],
  EIO: ['存储读写失败。', 'A storage I/O operation failed.'],
  OPERATION_FAILED: ['操作失败；未保存可能包含敏感内容的底层诊断。请结合记录编号排查。', 'The operation failed. Potentially sensitive low-level diagnostics were omitted. Use the record ID to investigate.'],
  TOWER_AUDIT_SYSTEM_USER_REQUIRED: ['原生日志接口仅允许 Tower 内部系统身份写入。原文：The current user does not have permissions for this operation, only allow by system user', 'Tower audit requires an internal system identity. Original: The current user does not have permissions for this operation, only allow by system user'],
  TOWER_AUDIT_TIMEOUT: ['向 Tower 写入日志超时，尚未确认成功。', 'The Tower audit request timed out; delivery is unconfirmed.'],
  TOWER_AUDIT_TASK_PENDING: ['Tower 日志任务尚未确认完成。', 'The Tower audit task has not been confirmed complete.'],
};
export function logDetail(event, locale, label) {
  const en = locale === 'en-US', parts = [];
  if (event.result === 'failed') {
    const code = /^[A-Z_]{1,100}$/.test(event.code || '') ? event.code : 'OPERATION_FAILED';
    parts.push(`${errors[code]?.[en ? 1 : 0] || (en ? 'The operation was rejected.' : '操作被拒绝。')} [${code}]`);
  } else parts.push(`${label} · ${en ? event.result === 'started' ? 'Request accepted for processing' : 'Completed' : event.result === 'started' ? '开始处理请求' : '操作已完成'}`);
  const delivery = event.towerDelivery;
  if (['failed', 'permission-denied'].includes(delivery?.state)) {
    const code = /^[A-Z_]{1,100}$/.test(delivery.code || '') ? delivery.code : 'TOWER_AUDIT_FAILED';
    parts.push(`${en ? 'Audit copy' : '原生日志副本'}：${errors[code]?.[en ? 1 : 0] || code} [${code}]`);
  }
  return parts.join('\n');
}
