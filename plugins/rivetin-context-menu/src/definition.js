import { configuration, PLUGIN_ID, RESOURCE_TYPES } from './configuration.js';
import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { installContextMenu } from './menu.js';
import { installObjectActionMenu } from './actions/menu.js';
import { createProductionActionProvider } from './actions/provider.js';
export default function createContextMenuPlugin({ React: suppliedReact, win, history, options = {}, getLocale = () => 'zh-CN', actionProvider }) {
  const React = suppliedReact || win.RivetinSDK.React, h = React.createElement;
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration), configuration);
  const names = { organization: ['CloudTower 实例', 'CloudTower instance'], datacenter: ['数据中心', 'Datacenter'], cluster: ['集群', 'Cluster'], host: ['主机', 'Host'], vm: ['虚拟机', 'Virtual machine'], vmVolume: ['虚拟卷', 'Virtual volume'], disk: ['硬盘', 'Disk'] };
  function Settings({ preferences, locale }) {
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    function checkbox(id, label, checked, onChange) { return h('div', { className: 'c89-setting', key: id }, h('div', { className: 'c89-setting-row' },
      h('label', { htmlFor: `rvcm-${id}` }, label), h('input', { id: `rvcm-${id}`, type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }))); }
    return h(React.Fragment, null,
      h('h3', null, t('资源右键菜单', 'Resource context menus')),
      h('p', null, t('右键资源树节点、列表行或详情标题，查看对象菜单。Shift + 右键保留浏览器菜单。', 'Right-click a resource tree node, table row or detail title. Shift + right-click keeps the browser menu.')),
      h('p', null, t('此插件申请资源操作权限。确认执行后，可通过框架对当前账户有权操作的对象提交变更；菜单展示本身不提交变更。', 'This plugin requests resource action permission. Confirming an action may submit a change through the framework for resources your account is authorized to manage. Opening a menu does not submit changes.')),
      checkbox('enabled', t('启用资源右键菜单', 'Enable resource context menus'), preferences.enabled, enabled => store.update({ enabled })),
      checkbox('native', t('显示对象操作', 'Show object actions'), preferences.nativeActions, nativeActions => store.update({ nativeActions })),
      h('h4', null, t('资源类型', 'Resource types')),
      ...RESOURCE_TYPES.map(type => checkbox(type, t(...names[type]), preferences.resourceTypes.includes(type), checked => store.update({ resourceTypes: RESOURCE_TYPES.filter(value => value === type ? checked : preferences.resourceTypes.includes(value)) }))),
      h('p', null, t('虚拟机右键菜单按功能分组，不需要先打开详情。尚未接入或无法确认权限、状态的功能不可执行，可查看禁用原因。', 'VM actions are grouped without opening details first. Unconnected actions or unverified permissions and state remain unavailable, with reasons shown.')));
  }
  return { id: PLUGIN_ID, store, Settings, activate(onError) {
    const canUseObjectActions = resource => store.status().loaded && store.get().enabled && store.get().nativeActions && store.get().resourceTypes.includes(resource.type);
    const provider = actionProvider || createProductionActionProvider({ win, bridge: options.resourceActions?.(PLUGIN_ID), getLocale, isEnabled: canUseObjectActions });
    const objectMenu = installObjectActionMenu({ win, provider, getLocale, isEnabled: canUseObjectActions, onError });
    const stop = installContextMenu({ win, store, history, getLocale, onError,
      onResourceMenu: (resource, x, y) => resource.type === 'vm' && !resource.internal && canUseObjectActions(resource) ? objectMenu.open(resource, x, y) : false,
      onDismiss: () => objectMenu.close() });
    const unsubscribe = store.subscribe(() => { if (!canUseObjectActions({ type: 'vm' })) { objectMenu.close(); provider?.close?.(); } });
    const poll = win.setInterval(() => { if (!store.status().dirty && win.document.visibilityState === 'visible') store.load(); }, 15000);
    return () => { win.clearInterval(poll); unsubscribe(); stop(); objectMenu.stop(); provider?.stop?.(); };
  } };
}
