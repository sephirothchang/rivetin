export const text = (locale, zh, en) => locale === 'en-US' ? en : zh;
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
    SMART_COLLECTION_FAILED: ['本次采集失败，健康状态未知。', 'Collection failed; health is unknown.'],
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
