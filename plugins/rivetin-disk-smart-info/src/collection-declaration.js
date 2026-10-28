// Display metadata only. The shared service derives every executable argument.
export const SMART_COMMAND_DECLARATION = Object.freeze({
  operation: 'disk.smart.read',
  category: 'disk',
  template: 'sudo -n -- /usr/sbin/smartctl --json=c --all <disk>',
  argumentSource: 'fresh-host-inventory',
  expansion: 'each-authorized-disk',
});
