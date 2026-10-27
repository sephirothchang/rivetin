import { configuration, PLUGIN_ID } from './configuration.js';
import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
export default function createSshChannelPlugin({ React: suppliedReact, win, options = {} }) {
  const React = suppliedReact || win.RivetinSDK.React, h = React.createElement;
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration), configuration);
  function Settings({ preferences, locale }) {
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    return h(React.Fragment, null,
      h('h3', null, t('SSH 通道', 'SSH channel')),
      h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' },
        h('label', { htmlFor: 'pk-ssh-allow-collection' }, t('允许通道执行采集', 'Allow channel collection')),
        h('input', { id: 'pk-ssh-allow-collection', type: 'checkbox', checked: preferences.enabled, onChange: event => store.update({ enabled: event.target.checked }) }))),
      h('p', null, t('此设置需保存后生效。框架和 SSH 通道插件均启用后，仍须在 SSH 通道审计页逐个审核并确认消费插件的命令与计划。', 'Save this setting to apply it. Even when the framework and SSH channel plugin are enabled, review and confirm each requesting plugin’s commands and schedules in the SSH channel audit page.')),
      h('p', null, t('关闭、重置或更改通道配置将撤销既有授权；重新开启后需再次审核。连接凭据通过下方独立连接草稿或便携 CLI 管理，后端加密且不保存到普通插件设置中。', 'Disabling, resetting or changing channel configuration revokes existing approvals; review is required again after re-enabling. Connection credentials use the separate connection draft below or portable CLI; the backend encrypts them outside ordinary plugin settings.')));
  }
  return { id: PLUGIN_ID, store, Settings, activate() { return () => {}; } };
}
