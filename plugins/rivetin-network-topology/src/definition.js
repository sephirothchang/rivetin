import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { configuration } from './configuration.js';
export default function createNetworkTopologyPlugin({ React: suppliedReact, win, options = {} }) {
  const React = suppliedReact || win.RivetinSDK.React;
  return {
    id: 'rivetin-network-topology',
    store: createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration), configuration),
    // Deliberately dormant: the deliverable is a standalone demo, not a live editor.
    activate() { return () => {}; },
    Settings({ locale }) {
      return React.createElement('p', null, locale === 'en-US'
        ? 'Local demo only. Live topology editing and server-side rollback are not implemented. Do not install this preview for network changes.'
        : '仅供本地 Demo。真实网络编辑与服务端回滚尚未实现，请勿安装本预览进行网络变更。');
    }
  };
}
