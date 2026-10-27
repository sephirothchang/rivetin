import { configuration, PLUGIN_ID, CONFIGURATION_ENDPOINT } from './configuration.js';
import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { installSmartInfo } from './enhancer.js';
import { text } from './i18n.js';
export default function createDiskSmartInfoPlugin({ React, win, options = {}, getLocale = () => 'zh-CN' }) {
  const h = React.createElement;
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration, CONFIGURATION_ENDPOINT), configuration);
  function Settings({ preferences, locale }) {
    const t = (zh, en) => text(locale, zh, en);
    return h(React.Fragment, null,
      h('h3', null, t('磁盘健康展示', 'Disk SMART information')),
      h('p', null, t('在物理盘详情侧栏展示 SMART 数据、历史采样和指标劣化。', 'Display SMART data, historical samples and metric deterioration in physical disk details.')),
      h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' },
        h('label', { htmlFor: 'pk-smart-enabled' }, t('显示 Smart 信息子页', 'Show SMART information tab')),
        h('input', { id: 'pk-smart-enabled', type: 'checkbox', checked: preferences.enabled, onChange: event => store.update({ enabled: event.target.checked }) }))),
      h('p', { role: 'status' }, t('插件声明每日只读 SMART 采集；需要管理员配置统一 SSH 通道并独立审核批准。页面只读取采样，重新读取不会触发采集。真实主机采集尚未验收。', 'The plugin declares daily read-only SMART collection, requiring configured SSH channels and separate administrator approval. Reload reads samples without triggering collection. Live host collection has not been accepted.')),
      h('p', null, t('功能配置复用框架的保存、丢弃和退出流程；关闭本页显示不会删除历史记录。', 'Settings use the framework save, discard and exit flow. Hiding the tab does not delete historical records.')));
  }
  return { id: PLUGIN_ID, store, Settings, activate() {
    const stop = installSmartInfo({ win, store, getLocale, provider: options.diskSmartInfo?.provider, findDetail: options.diskSmartInfo?.findDetail });
    const poll = win.setInterval(() => { if (!store.status().dirty && win.document.visibilityState === 'visible') store.load(); }, 15000);
    return () => { win.clearInterval(poll); stop(); };
  } };
}
