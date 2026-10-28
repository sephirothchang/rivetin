const messages = {
  'provider-unavailable': ['右键菜单组件未能初始化。请刷新页面；若仍失败，请在插件中心重新启用本插件。', 'The context-menu component could not initialize. Reload the page; if it still fails, re-enable this plugin in the plugin center.'],
  'action-unknown': ['当前菜单中的操作标识不在本版本注册表中。请关闭菜单后重新右键。', 'This action ID is absent from this version’s registry. Close the menu and right-click again.'],
  'plugin-disabled': ['插件或此资源类型的右键操作已被关闭。请检查插件设置。', 'The plugin or context actions for this resource type are disabled. Check plugin settings.'],
  'source-retired': ['原生面板或控件的对象归属已失效，未执行点击。请重新打开对象详情后重试。', 'The native panel or control lost its resource ownership. No click was performed. Reopen the resource details before retrying.'],
  'source-changed': ['页面、对象行或对象标识已变化，已取消操作。请重新右键目标对象。', 'The page, resource row or identity changed. The action was cancelled. Right-click the target again.'],
  'proof-expired': ['菜单的对象校验已过期，不能继续使用旧菜单。请重新右键目标对象。', 'The menu’s resource verification expired. Right-click the target again instead of using the old menu.'],
  'blocked-by-dialog': ['页面已有其他原生对话框或菜单。请先关闭该窗口，再重新右键。', 'Another native dialog or menu is open. Close it before right-clicking again.'],
  'navigation-unavailable': ['未找到能够确认对象身份的详情入口，未执行导航。请刷新列表后重试。', 'No detail entry could be bound to this resource. No navigation was performed. Refresh the list and retry.'],
  'target-timeout': ['等待官方对象界面超时，未点击后续操作。请确认详情能够正常打开后重试。', 'Waiting for the native resource view timed out. No later action was clicked. Check that details open normally, then retry.'],
  'target-mismatch': ['无法确认官方面板与右键目标的身份一致，或当前面板不唯一，已停止操作。请关闭其他详情后重试。', 'The native panel could not be uniquely bound to the target. Close other details and retry.'],
  'trigger-missing': ['当前对象行没有可识别的官方“更多操作”按钮，未展开菜单。请检查列表是否已加载完成。', 'This row has no recognizable native More actions trigger. No menu was opened. Check that the list finished loading.'],
  'trigger-ambiguous': ['当前对象行存在多个可能的官方菜单按钮，无法安全选择。请刷新列表后重试。', 'More than one native menu trigger matches this row. Refresh the list before retrying.'],
  'popup-unproven': ['官方菜单出现了，但无法确认它属于本次点击的对象，已停止后续点击。请关闭其他菜单后重试。', 'A native menu appeared, but its ownership could not be verified. No further item was clicked. Close other menus and retry.'],
  'popup-timeout': ['点击官方菜单按钮后，等待菜单打开超时。请从原生界面确认该按钮是否响应。', 'The native menu did not open before the timeout. Check whether its trigger responds in the native interface.'],
  'entry-missing': ['当前官方界面没有找到与此操作匹配的入口。请核对对象状态与 CloudTower 版本；如原生入口存在，请将此错误报告给插件维护者。', 'No matching action entry was found in the current native UI. Check the resource state and CloudTower version; if the native entry exists, report this error to the plugin maintainer.'],
  'entry-disabled': ['CloudTower 当前禁用了此原生入口，插件未点击。请查看官方界面显示的禁用说明。', 'CloudTower currently disables this native entry. It was not clicked. Check the explanation shown by the native UI.'],
  'entry-ambiguous': ['官方界面中有多个匹配的操作入口，无法安全选择，未执行点击。请关闭重复面板后重试。', 'Several native action entries match. None was clicked. Close duplicate panels and retry.'],
  'menu-empty': ['官方菜单已打开，但没有可读取的菜单项。请确认该对象在原生界面中有可用操作。', 'The native menu opened but contains no readable items. Check whether this object has actions in the native UI.'],
  'menu-ambiguous': ['官方菜单结构或操作项不唯一，无法确定唯一目标，未点击。请直接使用原生菜单。', 'The native menu structure or action items are ambiguous. No item was clicked. Use the native menu directly.'],
  'menu-changed': ['官方菜单的层级、标签或状态已变化，已取消旧操作。请重新右键读取最新菜单。', 'The native menu hierarchy, labels or state changed. Right-click again to read the current menu.'],
  'depth-limit': ['官方菜单的层级或条目数量超过安全读取上限，未继续展开。请使用原生菜单完成此操作。', 'The native menu exceeds the safe depth or item-count limit. Use the native menu for this operation.'],
  'surface-timeout': ['已点击官方入口，但未在时限内确认预期对话框或页签。请先检查页面是否已打开窗口，避免重复操作。', 'The native entry was clicked, but its expected dialog or tab was not confirmed in time. Check for an open window before retrying.'],
  'activation-expired': ['浏览器的用户点击激活已过期，未尝试打开控制台窗口。请在目标详情中重新点击“打开终端”。', 'Browser user activation expired. No console window was requested. Click Open console again in the target’s details.'],
  'cancelled': ['操作已取消，未继续点击原生入口。', 'The action was cancelled. No further native entry was clicked.'],
  'unexpected': ['菜单处理发生异常，无法确认当前操作是否已交接。请先检查页面和官方任务，再决定是否重试。', 'An unexpected menu error prevents confirmation of the handoff. Check the page and native tasks before retrying.'],
};

// Only fixed diagnostic codes cross the UI boundary. Never display a host
// exception, URL, HTML fragment or arbitrary reason supplied by another caller.
export function nativeErrorMessage(reason, locale = 'zh-CN') {
  const code = typeof reason === 'string' && Object.hasOwn(messages, reason) ? reason : 'unexpected';
  return `${messages[code][locale === 'en-US' ? 1 : 0]} (${code})`;
}
