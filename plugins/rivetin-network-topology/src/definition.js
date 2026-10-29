import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { configuration } from './configuration.js';
import { createTopologySource } from './provider-adapter.js';
import { createTopologyWorkspaceComponent } from './workspace-component.js';
export default function createNetworkTopologyPlugin({ React: suppliedReact, win, options = {} }) {
  const React = suppliedReact || win.RivetinSDK.React;
  return {
    id: 'rivetin-network-topology',
    store: createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration), configuration),
    ui: {
      schemaVersion: 1,
      pages: [{ id: 'topology-editor', Component: createTopologyWorkspaceComponent(React, win, createTopologySource(options.networkTopology?.provider)) }],
      actions: [],
      contributions: [{
        id: 'open-topology-editor', slot: 'cluster-network-topology.toolbar.actions',
        label: { 'zh-CN': '可视化编辑', 'en-US': 'Visual editor' },
        icon: 'edit', order: 100, visibility: { requiresContext: ['clusterId'] },
        target: { type: 'page', id: 'topology-editor' }
      }]
    },
    // Framework hosts the declared entry and page; activation never injects DOM.
    activate() { return () => {}; },
    Settings({ locale }) {
      return React.createElement('p', null, locale === 'en-US'
        ? 'Open Visual editor from the current cluster Network topology page. Resources are read-only; relationship drafts stay in this page. Live network apply and server-side rollback are not implemented.'
        : '从当前集群的网络拓扑页点击“可视化编辑”。资源只读，关联草稿仅保存在本页；真实网络应用与服务端回滚尚未实现。');
    }
  };
}
