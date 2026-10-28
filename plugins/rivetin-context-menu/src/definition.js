import { configuration, PLUGIN_ID, RESOURCE_TYPES } from './configuration.js';
import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { installContextMenu } from './menu.js';
import { installObjectActionMenu } from './actions/menu.js';
import { createNativeActionProvider } from './native/provider.js';
import { installNativeResourceMenu } from './native/resource-menu.js';
export default function createContextMenuPlugin({ React: suppliedReact, win, history, options = {}, getLocale = () => 'zh-CN', actionProvider }) {
  const React = suppliedReact || win.RivetinSDK.React, h = React.createElement;
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration), configuration);
  const names = { organization: ['CloudTower 实例', 'CloudTower instance'], datacenter: ['数据中心', 'Datacenter'], cluster: ['集群', 'Cluster'], host: ['主机', 'Host'], vm: ['虚拟机', 'Virtual machine'], vmVolume: ['虚拟卷', 'Virtual volume'], disk: ['硬盘', 'Disk'],
    nic: ['网口', 'Physical NIC'], vmGroup: ['虚拟机组', 'VM group'], vmPlacementGroup: ['虚拟机放置组', 'VM placement group'], vmNetwork: ['虚拟网络', 'VM network'], systemNetwork: ['系统网络', 'System network'], vmSnapshot: ['虚拟机快照', 'VM snapshot'], snapshotPlan: ['快照计划', 'Snapshot plan'], vds: ['分布式虚拟交换机', 'Distributed virtual switch'] };
  function Settings({ preferences, locale }) {
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    function checkbox(id, label, checked, onChange) { return h('div', { className: 'c89-setting', key: id }, h('div', { className: 'c89-setting-row' },
      h('label', { htmlFor: `rvcm-${id}` }, label), h('input', { id: `rvcm-${id}`, type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }))); }
    return h(React.Fragment, null,
      h('h3', null, t('资源右键菜单', 'Resource context menus')),
      h('p', null, t('右键资源树节点、列表行或详情标题，查看对象菜单。Shift + 右键保留浏览器菜单。', 'Right-click a resource tree node, table row or detail title. Shift + right-click keeps the browser menu.')),
      h('p', null, t('菜单用于定位官方操作入口。参数配置、权限判断、确认和任务执行均由 CloudTower 原生界面完成。', 'The menu locates official action entries. CloudTower’s native UI handles configuration, permissions, confirmation and task execution.')),
      checkbox('enabled', t('启用资源右键菜单', 'Enable resource context menus'), preferences.enabled, enabled => store.update({ enabled })),
      checkbox('native', t('显示对象操作', 'Show object actions'), preferences.nativeActions, nativeActions => store.update({ nativeActions })),
      h('h4', null, t('资源类型', 'Resource types')),
      h('p', null, t('升级保留已有的资源类型选择；新增类型需在此勾选，或重置为默认设置。', 'Upgrades preserve existing resource type selections. Select new types here, or reset settings to defaults.')),
      ...RESOURCE_TYPES.map(type => checkbox(type, t(...names[type]), preferences.resourceTypes.includes(type), checked => store.update({ resourceTypes: RESOURCE_TYPES.filter(value => value === type ? checked : preferences.resourceTypes.includes(value)) }))),
      h('p', null, t('右键可直接选择操作入口，必要时定位官方详情，无需预先打开侧栏。具体操作是否可用，以 CloudTower 原生界面为准。', 'Choose an entry directly from the context menu. Official details are located when needed, without opening the sidebar first. CloudTower’s native UI determines which operations are available.')));
  }
  return { id: PLUGIN_ID, store, Settings, activate(onError) {
    const canUseObjectActions = resource => store.status().loaded && store.get().enabled && store.get().nativeActions && store.get().resourceTypes.includes(resource.type);
    const provider = actionProvider || createNativeActionProvider({ win, history, getLocale, isEnabled: canUseObjectActions, onError });
    const objectMenu = installObjectActionMenu({ win, provider, getLocale, isEnabled: canUseObjectActions, onError });
    const resourceMenu = installNativeResourceMenu({ win, getLocale, isEnabled: canUseObjectActions, onError });
    const stop = installContextMenu({ win, store, history, getLocale, onError,
      onResourceMenu: (resource, x, y) => !resource.internal && canUseObjectActions(resource) ? resource.type === 'vm' ? objectMenu.open(resource, x, y) : resourceMenu.open(resource, x, y) : false,
      onDismiss: () => { objectMenu.close(); resourceMenu.close(); } });
    const effectiveConfiguration = () => {
      const settings = store.get();
      return { loaded: store.status().loaded, version: settings.version, enabled: settings.enabled, nativeActions: settings.nativeActions,
        resourceTypes: RESOURCE_TYPES.filter(type => settings.resourceTypes.includes(type)) };
    };
    let effective = effectiveConfiguration();
    const unsubscribe = store.subscribe(() => {
      const next = effectiveConfiguration();
      // Background reads emit loading/error notifications even when the saved
      // functional settings are unchanged. Only a real change revokes a menu.
      if (configuration.equal(effective, next)) return;
      effective = next; resourceMenu.close(); objectMenu.close(); provider?.close?.();
    });
    const poll = win.setInterval(() => { if (!store.status().dirty && win.document.visibilityState === 'visible') store.load(); }, 15000);
    return () => { win.clearInterval(poll); unsubscribe(); stop(); objectMenu.stop(); resourceMenu.stop(); provider?.stop?.(); };
  } };
}
