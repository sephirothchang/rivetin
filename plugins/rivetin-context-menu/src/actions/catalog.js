// Tower 4.9: smartxworks/cloudtower-node-sdk v2.23.0, generated/Vm.ts,
// VmSnapshot.ts, UsbDevice.ts and data-contracts.ts. This is metadata, never a
// request builder or executor. REST availability does not expose native dialogs.
// capabilities[actionId] must be an authoritative {allowed:true|false|null,
// reason?:string|{'zh-CN':string,'en-US':string}} result from the host adapter.
// snapshot is a fresh VM read, not DOM text: {id,status,entityAsyncStatus?,
// protected?,internal?,in_recycle_bin?,...}. Its id must equal resource.id.
// Optional snapshot.migration is NOT a Tower API field. A verified host adapter
// normalizes independently read task/object evidence into:
// {verified:true,vmId,taskId,taskStatus:'EXECUTING',kind:'CROSS_CLUSTER',
// phase:'TRANSFERRING'|'AWAITING_CUTOVER',controls:{abort:true?,cutover:true?},
// ownsVmUpdate:true?}. controls describe task applicability, NOT user permission.
// ownsVmUpdate is true only if this task is verified to own the VM's UPDATING
// state; no other busy state is bypassed. Missing or uncertain evidence disables
// task controls. An allowed capability never manufactures migration evidence.
const text = (zh, en) => ({ 'zh-CN': zh, 'en-US': en });
const operation = (operationId, path, schema) => ({ operationId, method: 'POST', path: `/v2/api/${path}`, schema });
const group = (id, zh, en, items) => ({ id, labels: text(zh, en), items });
function action(id, zh, en, op, form, danger = 'warning', rules = {}) {
  return { id: `vm.${id}`, labels: text(zh, en), operation: op, form, danger,
    mutation: true, targetType: 'vm', recycle: 'out', ...rules };
}
const stopped = { statuses: ['STOPPED'] };
const active = { statuses: ['RUNNING', 'STOPPED'] };
const running = { statuses: ['RUNNING'] };
const unverifiedNativeBinding = { unsupportedReason: text(
  '已在原生侧栏观察到此入口，但公开操作与表单契约尚未核实。',
  'Observed in the native sidebar, but its public operation and form contract are not verified.'),
  bindingSource: 'tower-4.9-readonly-sidebar-observation' };
const op = operation;
const groups = [
  group('vm.power', '电源', 'Power', [
    action('power.start', '开机', 'Power on', op('StartVm', 'start-vm', 'VmStartParams'), 'power-confirm', 'warning', stopped),
    action('power.shutdown', '关闭客户机', 'Shut down guest', op('ShutDownVm', 'shutdown-vm', 'VmOperateParams'), 'guest-shutdown-confirm', 'warning', running),
    action('power.poweroff', '强制断电', 'Force power off', op('PoweroffVm', 'poweroff-vm', 'VmOperateParams'), 'force-poweroff-confirm', 'danger', { statuses: ['RUNNING', 'SUSPENDED'] }),
    action('power.restart', '重启客户机', 'Restart guest', op('RestartVm', 'restart-vm', 'VmOperateParams'), 'guest-restart-confirm', 'warning', running),
    action('power.forceRestart', '强制重启', 'Force restart', op('ForceRestartVm', 'force-restart-vm', 'VmOperateParams'), 'force-restart-confirm', 'danger', running),
    action('power.suspend', '暂停', 'Suspend', op('SuspendVm', 'suspend-vm', 'VmOperateParams'), 'suspend-confirm', 'warning', running),
    action('power.resume', '恢复运行', 'Resume', op('ResumeVm', 'resume-vm', 'VmOperateParams'), 'resume-confirm', 'warning', { statuses: ['SUSPENDED'] }),
  ]),
  group('vm.console', '控制台与客户机', 'Console and guest', [
    action('console.open', '打开控制台', 'Open console', op('GetVmVncInfo', 'get-vm-vnc-info', 'GetVmVncInfoParams'), 'native-console', 'none', { mutation: false, ...running }),
    action('guest.installTools', '安装 VM Tools', 'Install VM Tools', op('InstallVmtools', 'install-vmtools', 'InstallVmtoolsParams'), 'vm-tools-confirm', 'warning', active),
    // InstallVmtools exists publicly, but that alone does not prove it has the
    // same semantics as the independently observed mount/unmount image entries.
    action('guest.toolsImage.mount', '挂载虚拟机工具映像', 'Mount VM tools image', null, 'vm-tools-image-mount', 'warning', unverifiedNativeBinding),
    action('guest.toolsImage.unmount', '卸载虚拟机工具映像', 'Unmount VM tools image', null, 'vm-tools-image-unmount', 'warning', unverifiedNativeBinding),
    action('network.links', '查看网络链路', 'View network links', null, 'vm-network-links', 'none', { mutation: false, ...unverifiedNativeBinding }),
    action('guest.hostOptions', '配置客户机网络与主机名', 'Configure guest network and hostname', op('UpdateVmHostOptions', 'update-vm-host-options', 'VmUpdateHostOptionsParams'), 'guest-host-options', 'warning', { ...running, requiresGuestAgent: true }),
    action('guest.resetPassword', '重置客户机密码', 'Reset guest password', op('ResetVmGuestOsPassword', 'reset-vm-guest-os-password', 'VmResetGuestOsPasswordParams'), 'guest-password', 'danger', { ...running, requiresGuestAgent: true }),
  ]),
  group('vm.hardware', '基本信息与硬件', 'General and hardware', [
    action('general.edit', '编辑基本信息', 'Edit basic information', op('UpdateVm', 'update-vm-basic-info', 'VmUpdateParams'), 'vm-general'),
    action('hardware.cpu', '配置 CPU', 'Configure CPU', op('UpdateVm', 'update-vm-basic-info', 'VmUpdateParams'), 'vm-cpu', 'warning', stopped),
    action('hardware.memory', '配置内存', 'Configure memory', op('UpdateVm', 'update-vm-basic-info', 'VmUpdateParams'), 'vm-memory', 'warning', stopped),
    action('hardware.disk.add', '添加磁盘', 'Add disk', op('AddVmDisk', 'add-vm-disk', 'VmAddDiskParams'), 'vm-disk-add', 'warning', { ...stopped, selectionType: 'vmVolume' }),
    action('hardware.disk.edit', '编辑磁盘', 'Edit disk', op('UpdateVmDisk', 'update-vm-disk', 'VmUpdateDiskParams'), 'vm-disk-edit', 'warning', { ...stopped, selectionType: 'vmDisk' }),
    action('hardware.disk.expand', '扩容磁盘', 'Expand disk', op('ExpandVmDisk', 'expand-vm-disk', 'VmExpandVmDiskParams'), 'vm-disk-expand', 'warning', { ...active, targetType: 'vmDisk' }),
    action('hardware.disk.cache', '设置磁盘常驻缓存', 'Set disk cache residency', op('SetVmDiskResidentInCache', 'set-vm-disk-resident-in-cache', 'VmSetVmDiskResidentInCacheParams'), 'vm-disk-cache', 'warning', { ...active, targetType: 'vmDisk' }),
    action('hardware.disk.remove', '卸载磁盘', 'Detach disk', op('RemoveVmDisk', 'remove-vm-disk', 'VmRemoveDiskParams'), 'vm-disk-detach', 'danger', { ...stopped, selectionType: 'vmDisk' }),
    action('hardware.nic.add', '添加网卡', 'Add NIC', op('AddVmNic', 'add-vm-nic', 'VmAddNicParams'), 'vm-nic-add', 'warning', stopped),
    action('hardware.nic.edit', '编辑网卡', 'Edit NIC', op('UpdateVmNic', 'update-vm-nic', 'VmUpdateNicParams'), 'vm-nic-edit', 'warning', { ...stopped, selectionType: 'vmNic' }),
    action('hardware.nic.remove', '移除网卡', 'Remove NIC', op('RemoveVmNic', 'remove-vm-nic', 'VmRemoveNicParams'), 'vm-nic-remove', 'danger', { ...stopped, selectionType: 'vmNic' }),
    action('hardware.nic.qos', '配置网卡 QoS', 'Configure NIC QoS', op('UpdateVmNicQosOption', 'update-vm-nic-qos-option', 'VmUpdateNicQosOptionsParams'), 'vm-nic-qos', 'warning', { ...active, selectionType: 'vmNic' }),
    action('hardware.cdrom.add', '添加 CD-ROM', 'Add CD-ROM', op('AddVmCdRom', 'add-vm-cd-rom', 'VmAddCdRomParams'), 'vm-cdrom-add', 'warning', stopped),
    action('hardware.cdrom.mount', '装载或更换 ISO', 'Mount or replace ISO', op('UpdateVmDisk', 'update-vm-disk', 'VmUpdateDiskParams'), 'vm-cdrom-iso', 'warning', { ...active, selectionType: 'vmDisk' }),
    action('hardware.cdrom.eject', '弹出 ISO', 'Eject ISO', op('EjectIsoFromVmCdRom', 'eject-iso-from-vm-cd-rom', 'VmEjectCdRomParams'), 'vm-cdrom-eject', 'warning', { ...active, targetType: 'vmDisk' }),
    action('hardware.cdrom.toggle', '启用或禁用 CD-ROM', 'Enable or disable CD-ROM', op('ToggleVmCdRomDisable', 'toggle-vm-cd-rom-disable', 'VmToggleCdRomDisableParams'), 'vm-cdrom-enabled', 'warning', { ...active, targetType: 'vmDisk' }),
    action('hardware.cdrom.remove', '移除 CD-ROM', 'Remove CD-ROM', op('RemoveVmCdRom', 'remove-vm-cd-rom', 'VmRemoveCdRomParams'), 'vm-cdrom-remove', 'danger', { ...stopped, selectionType: 'vmDisk' }),
    action('hardware.gpu.add', '添加 GPU', 'Add GPU', op('AddVmGpuDevice', 'add-vm-gpu-device', 'VmAddGpuDeviceParams'), 'vm-gpu-add', 'warning', { ...stopped, selectionType: 'gpuDevice' }),
    action('hardware.gpu.remove', '移除 GPU', 'Remove GPU', op('RemoveVmGpuDevice', 'remove-vm-gpu-device', 'VmRemoveGpuDeviceParams'), 'vm-gpu-remove', 'danger', { ...stopped, selectionType: 'gpuDevice' }),
    action('hardware.pciNic.add', '添加直通网卡', 'Add passthrough NIC', op('AddVmPciNic', 'add-vm-pci-nic', 'VmOperatePciNicParams'), 'vm-pci-nic-add', 'warning', { ...stopped, selectionType: 'nic' }),
    action('hardware.pciNic.remove', '移除直通网卡', 'Remove passthrough NIC', op('RemoveVmPciNic', 'remove-vm-pci-nic', 'VmOperatePciNicParams'), 'vm-pci-nic-remove', 'danger', { ...stopped, selectionType: 'nic' }),
    action('hardware.usb.mount', '挂载直通 USB', 'Mount USB device', op('MountUsbDevice', 'mount-usb-device', 'UsbDeviceMountParams'), 'vm-usb-mount', 'warning', { ...stopped, targetType: 'usbDevice' }),
    action('hardware.usb.unmount', '卸载直通 USB', 'Unmount USB device', op('UnmountUsbDevice', 'unmount-usb-device', 'UsbDeviceUnmountParams'), 'vm-usb-unmount', 'danger', { ...stopped, targetType: 'usbDevice' }),
    action('hardware.advanced', 'CPU 型号、显示与时钟选项', 'CPU model, video and clock options', op('UpdateVmAdvancedOptions', 'update-vm-advanced-options', 'VmUpdateAdvancedOptionsParams'), 'vm-advanced', 'warning', stopped),
    action('hardware.bootOrder', '启动顺序', 'Boot order', null, 'vm-boot-order', 'warning', stopped),
    action('hardware.firmware', '启动固件', 'Boot firmware', null, 'vm-firmware', 'warning', stopped),
    action('hardware.tpm', '虚拟可信平台模块', 'Virtual TPM', null, 'vm-tpm', 'warning', stopped),
  ]),
  group('vm.snapshots', '快照、克隆与导出', 'Snapshots, cloning and export', [
    action('snapshots.list', '查看快照', 'Browse snapshots', op('GetVmSnapshots', 'get-vm-snapshots', 'GetVmSnapshotsRequestBody'), 'vm-snapshot-browser', 'none', { mutation: false, recycle: 'any' }),
    action('snapshots.create', '创建快照', 'Create snapshot', op('CreateVmSnapshot', 'create-vm-snapshot', 'VmSnapshotCreationParams'), 'vm-snapshot-create', 'warning', active),
    action('snapshots.restore', '回滚当前虚拟机', 'Roll back this VM', op('RollbackVm', 'rollback-vm', 'VmRollbackParams'), 'vm-snapshot-rollback', 'danger', { ...stopped, selectionType: 'vmSnapshot' }),
    action('snapshots.rebuild', '从快照重建虚拟机', 'Rebuild VM from snapshot', op('RebuildVm', 'rebuild-vm-from-snapshot', 'VmRebuildParams[]'), 'vm-snapshot-rebuild', 'warning', { ...active, selectionType: 'vmSnapshot' }),
    action('snapshots.delete', '删除快照', 'Delete snapshot', op('DeleteVmSnapshot', 'delete-vm-snapshot', 'VmSnapshotDeletionParams'), 'vm-snapshot-delete', 'danger', { ...active, targetType: 'vmSnapshot' }),
    action('clone', '克隆虚拟机', 'Clone VM', op('CloneVm', 'clone-vm', 'VmCloneParams[]'), 'vm-clone', 'warning', active),
    // A disabled native submenu establishes neither its public operation nor
    // why it is disabled. Do not infer a running-state restriction from its label.
    action('template.create', '创建虚拟机模板', 'Create VM template', null, 'vm-template-create', 'warning', unverifiedNativeBinding),
    action('export', '导出虚拟机', 'Export VM', op('ExportVm', 'export-vm', 'VmExportParams'), 'vm-export', 'warning', stopped),
    action('backup', '备份与容灾', 'Backup and disaster recovery', null, 'vm-backup', 'warning'),
  ]),
  group('vm.migration', '迁移', 'Migration', [
    action('migration.withinCluster', '集群内迁移', 'Migrate within cluster', op('MigrateVm', 'migrate-vm', 'VmMigrateParams'), 'vm-migrate-host', 'warning', active),
    action('migration.acrossCluster', '跨集群迁移', 'Migrate across clusters', op('MigrateVmAcrossCluster', 'migrate-vm-across-cluster', 'VmMigrateAcrossClusterParams'), 'vm-migrate-cluster', 'warning', active),
    action('migration.cutover', '切换迁移中的虚拟机', 'Cut over migrating VM', op('StopVmInCutoverMigration', 'stop-vm-in-cutover-migration', 'StopVmInCutoverMigrationParams'), 'vm-migration-cutover', 'danger', { ...running, migrationControl: 'cutover' }),
    action('migration.abort', '中止跨集群迁移', 'Abort cross-cluster migration', op('AbortMigrateVmAcrossCluster', 'abort-migrate-vm-across-cluster', 'AbortMigrateVmAcrossClusterParams'), 'vm-migration-abort', 'danger', { ...active, migrationControl: 'abort' }),
  ]),
  group('vm.management', '高可用、归属与标签', 'Availability, ownership and labels', [
    action('availability.ha', '配置高可用与优先级', 'Configure HA and priority', op('UpdateVm', 'update-vm-basic-info', 'VmUpdateParams'), 'vm-ha', 'warning', active),
    action('placementGroup', '虚拟机放置组', 'VM placement groups', null, 'vm-placement-group', 'warning', unverifiedNativeBinding),
    action('hostAutostart', '随主机开机', 'Start with host', null, 'vm-host-autostart', 'warning', unverifiedNativeBinding),
    action('vmGroup', '虚拟机组', 'VM groups', null, 'vm-group', 'warning', unverifiedNativeBinding),
    action('ownership', '修改虚拟机所有者', 'Change VM owner', op('UpdateVmOwner', 'update-vm-owner', 'VmUpdateOwnerParams'), 'vm-owner'),
    action('folder.add', '移入文件夹', 'Move into folder', op('AddVmToFolder', 'add-vm-to-folder', 'VmAddFolderParams'), 'vm-folder-add'),
    action('folder.remove', '移出文件夹', 'Remove from folder', op('RemoveVmToFolder', 'remove-vm-from-folder', 'VmAddFolderParams'), 'vm-folder-remove', 'warning', { requiresFolder: true }),
    action('ioPolicy', '配置磁盘 I/O 策略', 'Configure disk I/O policy', op('UpdateVmIoPolicy', 'update-vm-io-policy', 'VmUpdateIoPolicyParams'), 'vm-io-policy'),
    // Labels, boot order, firmware, TPM and backup need a separately verified
    // host binding. Do not infer a 4.9 endpoint from an older API reference.
    action('labels', '编辑标签', 'Edit labels', null, 'vm-labels'),
    action('protection', '配置虚拟机保护', 'Configure VM protection', null, 'vm-protection'),
  ]),
  group('vm.recycle', '回收与删除', 'Recycle and delete', [
    action('recycle.move', '移入回收站', 'Move to recycle bin', op('MoveVmToRecycleBin', 'move-vm-to-recycle', 'VmOperateParams'), 'vm-recycle-confirm', 'danger', stopped),
    action('recycle.recover', '从回收站恢复', 'Recover from recycle bin', op('RecoverVmFromRecycleBin', 'recover-vm-from-recycle', 'VmOperateParams'), 'vm-recover-confirm', 'warning', { ...stopped, recycle: 'in' }),
    action('delete', '永久删除虚拟机', 'Permanently delete VM', op('DeleteVm', 'delete-vm', 'VmDeleteParams'), 'vm-delete-confirm', 'danger', { ...stopped, recycle: 'in' }),
  ]),
];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const VM_ACTION_CATALOG = freeze(groups);
export const ACTION_CATALOG = VM_ACTION_CATALOG;
const reasons = {
  unsupported: text('尚无已验证的宿主操作适配，不能执行。', 'No verified host action binding is available.'),
  preflight: text('尚未取得此虚拟机的可靠最新状态。', 'A reliable current VM snapshot is required.'),
  mismatch: text('对象 ID 与状态快照不一致，请重新读取。', 'The resource ID does not match the snapshot. Refresh it.'),
  stateUnknown: text('虚拟机状态未知，暂不可操作。', 'The VM state is unknown; the action is unavailable.'),
  busy: text('虚拟机存在进行中的变更，请等待后重新读取。', 'The VM has a pending change. Wait and refresh.'),
  protected: text('虚拟机已保护，暂不提供修改操作。', 'The VM is protected; changes are unavailable.'),
  internal: text('系统内部虚拟机不提供此修改操作。', 'This change is unavailable for an internal VM.'),
  recycled: text('对象已在回收站中，此操作不可用。', 'This action is unavailable while the VM is in the recycle bin.'),
  notRecycled: text('此操作仅适用于回收站中的虚拟机。', 'This action requires a VM in the recycle bin.'),
  state: text('当前电源状态不满足此操作的保守前置条件。', 'The current power state does not meet this action’s conservative preconditions.'),
  migrationUnknown: text('未取得与此虚拟机绑定的、正在执行的跨集群迁移任务证据。', 'A verified executing cross-cluster migration task bound to this VM is required.'),
  migrationPhase: text('尚未确认迁移处于允许此控制操作的阶段。', 'The migration phase has not been verified as eligible for this control.'),
  migrationActive: text('此虚拟机的迁移任务尚未结束，暂不提供其他修改。', 'This VM has an unfinished migration task; other changes are unavailable.'),
  guestAgent: text('此客户机操作需要已确认运行的 VM Tools。', 'This guest operation requires VM Tools verified as running.'),
  folder: text('未确认此虚拟机所属的有效文件夹。', 'A valid folder containing this VM has not been verified.'),
  permissionUnknown: text('尚未取得此操作的权威权限结果。', 'Authoritative authorization for this action is unavailable.'),
  denied: text('当前账户无权执行此操作。', 'The current account is not authorized for this action.'),
};
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const languages = locale => locale === 'en-US' ? 'en-US' : 'zh-CN';
function migrationIsBound(snapshot) {
  const migration = snapshot.migration;
  return migration?.verified === true && migration.vmId === snapshot.id &&
    validId(migration.taskId) && migration.taskId !== snapshot.id && migration.kind === 'CROSS_CLUSTER';
}
function migrationControlBlock(entry, snapshot) {
  if (!migrationIsBound(snapshot) || snapshot.migration.taskStatus !== 'EXECUTING') return 'migrationUnknown';
  const migration = snapshot.migration;
  const eligiblePhase = entry.migrationControl === 'cutover' ? migration.phase === 'AWAITING_CUTOVER' :
    ['TRANSFERRING', 'AWAITING_CUTOVER'].includes(migration.phase);
  if (!eligiblePhase || migration.controls?.[entry.migrationControl] !== true) return 'migrationPhase';
  return null;
}
function blocked(entry, resource, snapshot, capability) {
  if (!entry.operation) return 'unsupported';
  if (!validId(resource.id) || !snapshot || !validId(snapshot.id)) return 'preflight';
  if (resource.id !== snapshot.id) return 'mismatch';
  if (!['RUNNING', 'STOPPED', 'SUSPENDED'].includes(snapshot.status)) return 'stateUnknown';
  if (entry.migrationControl) {
    const reason = migrationControlBlock(entry, snapshot);
    if (reason) return reason;
  }
  const controlsOwnUpdate = entry.migrationControl && snapshot.entityAsyncStatus === 'UPDATING' && snapshot.migration?.ownsVmUpdate === true;
  if (snapshot.entityAsyncStatus && !controlsOwnUpdate) return 'busy';
  if (entry.mutation && !entry.migrationControl && migrationIsBound(snapshot) &&
    ['PENDING', 'EXECUTING', 'PAUSED'].includes(snapshot.migration.taskStatus)) return 'migrationActive';
  if (entry.mutation && snapshot.protected === true) return 'protected';
  if (entry.mutation && snapshot.internal === true) return 'internal';
  if (entry.recycle === 'out' && snapshot.in_recycle_bin === true) return 'recycled';
  if (entry.recycle === 'in' && snapshot.in_recycle_bin !== true) return 'notRecycled';
  if (entry.statuses && !entry.statuses.includes(snapshot.status)) return 'state';
  if (entry.requiresGuestAgent && snapshot.vm_tools_status !== 'RUNNING') return 'guestAgent';
  if (entry.requiresFolder && !validId(snapshot.folder?.id)) return 'folder';
  if (capability?.allowed === false) return 'denied';
  if (capability?.allowed !== true) return 'permissionUnknown';
  return null;
}
// Opening a form is not executing its REST operation. Subresource IDs and disk/
// NIC indexes must be selected from freshly read, VM-owned resources in that
// form. No payload, token, global state, network call or native handler is used.
export function buildActionTree({ resource, snapshot, capabilities = {}, locale = 'zh-CN' } = {}) {
  if (resource?.type !== 'vm') return [];
  const language = languages(locale);
  return VM_ACTION_CATALOG.map(section => ({ id: section.id, label: section.labels[language], items: section.items.map(entry => {
    const capability = Object.hasOwn(capabilities || {}, entry.id) ? capabilities[entry.id] : undefined;
    const reasonCode = blocked(entry, resource, snapshot, capability);
    const suppliedReason = capability?.reason;
    const reason = reasonCode === 'unsupported' ? entry.unsupportedReason?.[language] : reasonCode === 'denied' && (typeof suppliedReason === 'string' ? suppliedReason : suppliedReason?.[language]);
    const vmId = validId(resource.id) && resource.id === snapshot?.id ? resource.id : null;
    return { id: entry.id, label: entry.labels[language], enabled: !reasonCode, reason: reason || (reasonCode ? reasons[reasonCode][language] : ''), reasonCode,
      form: entry.form, danger: entry.danger, mutation: entry.mutation, bindingSource: entry.bindingSource || null,
      operation: entry.operation ? { ...entry.operation } : null,
      target: { type: entry.targetType, id: entry.targetType === 'vm' ? vmId : null, parentVmId: entry.targetType === 'vm' ? null : vmId },
      selection: entry.selectionType ? { type: entry.selectionType, ids: [], parentVmId: vmId } : null,
    };
  }) }));
}
