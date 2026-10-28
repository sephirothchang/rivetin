export const text = (locale, zh, en) => locale === 'en-US' ? en : zh;
export function collectionText(value, locale) {
  if (value.status === 'running') return text(locale, '正在采集当前磁盘…离开此页只停止页面等待，不保证远端任务取消。', 'Collecting this disk… Leaving this page only stops waiting; the remote task may continue.');
  if (value.status === 'succeeded') return text(locale, '采集任务已完成。', 'Collection completed.');
  if (value.code === 'SMART_COLLECTION_WAIT_CANCELLED') return text(locale, '已停止页面等待，后台采集可能继续；请重新读取或联系管理员核实。', 'Stopped waiting. Collection may continue in the background; reload or ask an administrator to verify.');
  const reasons = {
    SMART_BATCH_NO_TARGETS: ['没有已绑定的磁盘，未发起全局采集。请配置可信设备绑定。', 'No disks are bound. Global collection was not started. Configure trusted device bindings.'],
    SMART_BATCH_NO_APPROVED_TARGETS: ['没有获批的采集目标，未发起全局采集。请联系管理员审核。', 'No collection targets are approved. Global collection was not started. Ask an administrator to review approvals.'],
    SMART_BATCH_TARGET_LIMIT: ['采集目标超过 100 个，未发起批次；不会静默忽略超出部分。请联系管理员调整范围。', 'There are more than 100 targets. No batch was started or silently truncated. Ask an administrator to adjust the scope.'],
    SMART_BATCH_NOT_APPROVED: ['该目标未获得有效采集授权，未执行。', 'This target lacks a valid collection approval and was skipped.'],
    SMART_BATCH_AMBIGUOUS_COMMAND: ['该目标没有唯一的已批准采集声明，未执行。', 'This target has no unique approved collection declaration and was skipped.'],
    SMART_BATCH_SNAPSHOT_CHANGED: ['目标绑定或审批已变化，未跟随新目标执行。', 'The binding or approval changed. Execution did not follow a new target.'],
    SMART_COLLECTION_SNAPSHOT_CHANGED: ['目标绑定或审批已变化，本次采集未继续。', 'The binding or approval changed. This collection did not continue.'],
    SMART_BATCH_FORBIDDEN: ['没有读取该磁盘或批次的权限，请联系管理员。', 'Access to this disk or batch is denied. Contact an administrator.'],
    SMART_BATCH_ACCESS_CHANGED: ['磁盘绑定或读取权限已变化，已清空批次展示。请核实。', 'The disk binding or read access changed. Batch details were cleared. Verify access.'],
    SMART_BATCH_TARGET_UNAVAILABLE: ['采集目标暂不可用，未执行。', 'The collection target is unavailable and was skipped.'],
    SMART_BATCH_CONFLICT: ['与已有采集任务冲突，未自动重试。请先核实运行状态。', 'Another collection conflicts with this target. It was not retried. Check the active task.'],
    SMART_BATCH_BUSY: ['已有全局批次运行中，未发起新批次。请先核实运行状态。', 'A global batch is already running. No new batch was started. Check its status.'],
    SMART_BATCH_DEADLINE: ['批次达到后台等待时限，尚未开始的目标未执行。', 'The batch reached its background deadline. Targets that had not started were skipped.'],
    SMART_BATCH_INTERRUPTED: ['批次被中断，结果待确认。未自动重发命令。', 'The batch was interrupted and its outcome is unknown. Commands were not resent.'],
    SMART_BATCH_CHILD_UNKNOWN: ['该磁盘的采集结果待确认，未自动重发命令。', 'This disk’s collection outcome is unknown. The command was not resent.'],
    SMART_BATCH_CAPACITY_EXCEEDED: ['批次记录容量已满，未发起新批次。请联系管理员处理。', 'Batch record capacity is full. No new batch was started. Contact an administrator.'],
    SMART_BATCH_NOT_FOUND: ['批次记录不可用，未重新发起采集。请联系管理员核实。', 'The batch record is unavailable. Collection was not resubmitted. Contact an administrator.'],
    SSH_APPROVAL_REQUIRED: ['采集命令尚未审核或授权已失效，请联系管理员审核。', 'The collection command is not approved, or approval expired. Ask an administrator to review it.'],
    SSH_REGISTRATION_CHANGED: ['采集声明已变化，需要管理员重新审核授权。', 'The collection declaration changed and requires administrator approval again.'],
    SSH_CHANNEL_DISABLED: ['统一 SSH 通道未启用或未配置，请联系管理员。', 'The shared SSH channel is disabled or unconfigured. Contact an administrator.'],
    SSH_TARGET_UNAVAILABLE: ['尚未配置可用采集目标，请联系管理员。', 'No collection target is configured. Contact an administrator.'],
    SSH_DEVICE_UNAVAILABLE: ['采集设备尚未配置或已不可用，请联系管理员。', 'The collection device is unconfigured or unavailable. Contact an administrator.'],
    SMART_PROFILE_UNAVAILABLE: ['可信采集主机配置不可用，请联系管理员。', 'The trusted collection host profile is unavailable. Contact an administrator.'],
    SMART_DEVICE_UNAVAILABLE: ['可信采集设备不可用，请联系管理员。', 'The trusted collection device is unavailable. Contact an administrator.'],
    SMART_COLLECTION_UNAVAILABLE: ['当前框架尚未提供立即采集，请联系管理员。', 'Collect now is unavailable in this framework. Contact an administrator.'],
    SSH_CONCURRENCY_LIMIT: ['已有采集任务运行中，请稍后核实状态。', 'A collection is already running. Check its status before trying again.'],
    SMART_COLLECTION_BUSY: ['已有采集任务运行中，请稍后核实状态。', 'A collection is already running. Check its status before trying again.'],
    ADMIN_REQUIRED: ['立即采集需要管理员权限。', 'Collect now requires administrator access.'],
    SMART_UNSUPPORTED: ['该设备不支持 SMART 采集或未透传，健康状态未知。', 'SMART collection is unsupported or not passed through; health is unknown.'],
  };
  if (value.status === 'unknown') {
    const notice = text(locale, '采集结果待确认，任务可能仍在执行。未自动重发请求；请重新读取或联系管理员核实。', 'Collection outcome is unknown; the task may still be running. The request was not resent. Reload or ask an administrator to verify.');
    return reasons[value.code] ? `${notice} ${text(locale, ...reasons[value.code])}` : notice;
  }
  if (reasons[value.code]) return text(locale, ...reasons[value.code]);
  return value.code && value.code !== 'SMART_COLLECTION_UNKNOWN' ? errorText(value.code, locale) : text(locale, '采集任务失败，未提供详细原因。请重新读取并联系管理员核实。', 'Collection failed without a detailed reason. Reload and ask an administrator to verify.');
}
export function gapText(code, locale) {
  const reasons = {
    SMART_COLLECTION_FAILED: ['采集失败', 'collection failure'], SMART_UNAVAILABLE: ['数据不可用', 'data unavailable'],
    SMART_UNSUPPORTED: ['当时不支持 SMART', 'SMART was unsupported'], SMART_INVALID_DATA: ['数据无效', 'invalid data'],
    SMART_DEVICE_CHANGED: ['设备变化', 'device changed'], SMART_IDENTITY_MISMATCH: ['设备身份不符', 'device identity mismatch'],
    SMART_EXECUTION_TIMEOUT: ['采集超时', 'collection timed out'], SMART_EXECUTION_CANCELLED: ['采集取消', 'collection cancelled'],
    SMART_OUTPUT_INVALID: ['采集结果无效', 'invalid collection output'],
  };
  const reason = reasons[code];
  return reason ? text(locale, `当日曾采集失败，后恢复（${reason[0]}）。此前失败时刻未提供。`, `Collection failed earlier that UTC day, then recovered (${reason[1]}). The earlier failure time was not provided.`) : '';
}
export function errorText(code, locale) {
  const messages = {
    SMART_GENERATION_CHANGED: ['磁盘已更换或身份已变化，请重新读取。', 'The disk was replaced or its identity changed. Reload to verify it.'],
    SMART_HISTORY_CURSOR_STALE: ['历史记录已更新，请重新读取首页后继续翻页。', 'History changed. Reload the first page before continuing.'],
    SMART_DISK_UNBOUND: ['该磁盘尚未绑定可信采集设备，请联系管理员。', 'This disk has no trusted collection binding. Contact an administrator.'],
    SMART_NO_SAMPLE: ['尚无采样，等待已授权的后台采集。', 'No sample yet. Await authorized background collection.'],
    SMART_COLLECTION_FAILED: ['本次采集失败：SMART 数据不可用，健康状态未知。', 'Collection failed: SMART data is unavailable; health is unknown.'],
    SMART_EXECUTION_TIMEOUT: ['采集超时，健康状态未知。', 'Collection timed out; health is unknown.'],
    SMART_EXECUTION_CANCELLED: ['采集已取消，健康状态未知。', 'Collection was cancelled; health is unknown.'],
    SMART_IDENTITY_MISMATCH: ['采集设备身份不符，未使用该结果，健康状态未知。', 'Collected device identity did not match. The result was discarded; health is unknown.'],
    SMART_OUTPUT_INVALID: ['采集数据无效，健康状态未知。', 'Collected data is invalid; health is unknown.'],
    SMART_INVALID_DATA: ['采集数据无效，健康状态未知。', 'Collected data is invalid; health is unknown.'],
    SMART_DEVICE_CHANGED: ['采集设备已变化，健康状态未知。', 'The collected device changed; health is unknown.'],
    SMART_UNAVAILABLE: ['没有可用采样，健康状态未知。', 'No sample is available; health is unknown.'],
  };
  return text(locale, ...(messages[code] || ['SMART 信息暂不可用。请联系管理员检查采集服务和对象权限后重试。', 'SMART information is unavailable. Ask an administrator to check collection and object access, then retry.']));
}
export function smartFailureGuidance(locale) {
  return text(locale,
    'SMART 读取失败不等于 SSH 认证失败，也不能据此判定坏盘。认证结果请查看 SSH 通道的独立检查。可能原因包括工具或命令问题、设备不提供 SMART，或虚拟化层未透传（例如某些 VMware 虚拟盘）；本页未确认具体原因。',
    'A SMART read failure does not establish an SSH authentication failure or a damaged disk. See the SSH channel’s separate authentication check. Possible causes include tool or command issues, a device without SMART, or missing virtualization passthrough (for example, some VMware virtual disks). This page has not confirmed the cause.');
}
const names = {
  health: ['SMART 健康自检', 'SMART health assessment'],
  ata_threshold_status: ['SMART 退出状态：属性阈值告警', 'SMART exit status: attribute threshold alert'],
  self_test_errors: ['自检日志包含错误', 'Self-test log contains errors'],
  temperature: ['温度', 'Temperature'],
  power_on_hours: ['通电时间', 'Power-on hours'],
  power_cycles: ['通电次数', 'Power cycles'],
  critical_warning: ['严重警告位', 'Critical warning bits'],
  available_spare: ['可用备用空间', 'Available spare'],
  percentage_used: ['已消耗寿命', 'Endurance used'],
  media_errors: ['介质与数据完整性错误', 'Media and data integrity errors'],
  num_err_log_entries: ['错误日志条目', 'Error log entries'],
  unsafe_shutdowns: ['非正常关机次数', 'Unsafe shutdowns'],
  data_units_read: ['读取数据单元', 'Data units read'],
  data_units_written: ['写入数据单元', 'Data units written'],
  Reallocated_Sector_Ct: ['重映射扇区数', 'Reallocated sectors'],
  Reallocated_Event_Count: ['重映射事件数', 'Reallocation events'],
  Current_Pending_Sector: ['待处理扇区数', 'Current pending sectors'],
  Offline_Uncorrectable: ['离线不可纠正扇区', 'Offline uncorrectable sectors'],
  Reported_Uncorrect: ['已报告不可纠正错误', 'Reported uncorrectable errors'],
  UDMA_CRC_Error_Count: ['接口 CRC 错误数', 'Interface CRC errors'],
  Raw_Read_Error_Rate: ['原始读取错误率（厂商定义）', 'Raw read error rate (vendor defined)'],
  Seek_Error_Rate: ['寻道错误率（厂商定义）', 'Seek error rate (vendor defined)'],
  Power_On_Hours: ['通电时间', 'Power-on hours'],
  Power_Cycle_Count: ['通电次数', 'Power cycles'],
  Temperature_Celsius: ['温度（厂商原始格式）', 'Temperature (vendor raw format)'],
  Wear_Leveling_Count: ['磨损均衡计数（厂商定义）', 'Wear leveling count (vendor defined)'],
  Media_Wearout_Indicator: ['介质磨损指标（厂商定义）', 'Media wearout indicator (vendor defined)'],
  Percent_Lifetime_Remain: ['剩余寿命（厂商定义）', 'Remaining life (vendor defined)'],
  scsi_grown_defect_list: ['增长缺陷列表', 'Grown defect list'],
  scsi_read_errors: ['不可纠正读取错误', 'Uncorrected read errors'],
  scsi_write_errors: ['不可纠正写入错误', 'Uncorrected write errors'],
  scsi_verify_errors: ['不可纠正校验错误', 'Uncorrected verify errors'],
};
export function metricName(key, locale) { return names[key] ? text(locale, ...names[key]) : text(locale, '厂商属性', 'Vendor attribute'); }
export const riskName = (risk, locale) => text(locale, ...({ unknown: ['未知', 'Unknown'], normal: ['未触发规则', 'No rule triggered'], yellow: ['关注', 'Attention'], red: ['高风险', 'High risk'], darkred: ['严重风险', 'Critical risk'] }[risk] || ['未知', 'Unknown']));
const reasons = {
  failed: ['设备报告健康检查失败', 'Device reports failed health assessment'],
  critical: ['设备严重警告位非零', 'Device critical warning bits are nonzero'],
  threshold: ['已达到设备报告的阈值', 'Device-reported threshold reached'],
  historical: ['设备报告曾越过阈值', 'Device reports a previous threshold failure'],
  endurance: ['已消耗寿命达到展示策略阈值', 'Endurance used reached a display policy threshold'],
  counter: ['该错误或缺陷计数非零', 'This error or defect counter is nonzero'],
  increased: ['相较上一有效采样劣化', 'Deteriorated since the previous valid sample'],
  normalized: ['归一化值下降；原始值含义由厂商定义', 'Normalized value fell; raw semantics are vendor defined'],
  vendor: ['厂商属性原始值不做通用风险推断', 'No generic risk inference from vendor raw values'],
  informational: ['仅供参考，不据此推断寿命或故障', 'Informational; no lifespan or failure inference'],
};
export const reasonText = (key, locale) => reasons[key] ? text(locale, ...reasons[key]) : '—';
