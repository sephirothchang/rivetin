import { configuration, PLUGIN_ID, CONFIGURATION_ENDPOINT } from './configuration.js';
import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { installSmartInfo } from './enhancer.js';
import { text } from './i18n.js';
import { createGlobalCollection } from './global-collection.js';
import { createBatchController } from './batch-collection.js';
export default function createDiskSmartInfoPlugin({ React, win, options = {}, getLocale = () => 'zh-CN' }) {
  const h = React.createElement;
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration, CONFIGURATION_ENDPOINT), configuration);
  const batch = createBatchController(win, options.diskSmartInfo?.provider);
  const GlobalCollection = createGlobalCollection(React);
  function GlobalSettings({ locale }) {
    const [state, setState] = React.useState(batch.snapshot);
    React.useEffect(() => batch.subscribe(setState), []);
    const items = state.items?.map(item => ({ ...item, key: item.diskId, label: item.diskId }));
    return h(GlobalCollection, { locale, state: { ...state, items }, disabled: !state.active,
      onCollect: state.available ? () => batch.collect() : undefined });
  }
  function Settings({ preferences, locale }) {
    const t = (zh, en) => text(locale, zh, en);
    return h(React.Fragment, null,
      h('h3', null, t('磁盘健康展示', 'Disk SMART information')),
      h('p', null, t('在物理盘详情侧栏展示 SMART 数据、历史采样和指标劣化。', 'Display SMART data, historical samples and metric deterioration in physical disk details.')),
      h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' },
        h('label', { htmlFor: 'pk-smart-enabled' }, t('显示 Smart 信息子页', 'Show SMART information tab')),
        h('input', { id: 'pk-smart-enabled', type: 'checkbox', checked: preferences.enabled, onChange: event => store.update({ enabled: event.target.checked }) }))),
      h('p', { role: 'status' }, t('每日采集与“立即采集”均需要可信设备配置和独立人工审核。“重新读取”只刷新已有采样；离开侧栏只停止页面等待，后台任务可能继续。真实主机采集尚未验收。', 'Daily collection and Collect now require trusted device configuration and explicit administrator approval. Reload only reads existing samples. Leaving the sidebar stops waiting; a background task may continue. Live host collection has not been accepted.')),
      h(GlobalSettings, { locale }),
      h('p', null, t('功能配置复用框架的保存、丢弃和退出流程；关闭本页显示不会删除历史记录。', 'Settings use the framework save, discard and exit flow. Hiding the tab does not delete historical records.')));
  }
  return { id: PLUGIN_ID, store, Settings, activate() {
    batch.start();
    const stop = installSmartInfo({ win, store, getLocale, provider: options.diskSmartInfo?.provider, findDetail: options.diskSmartInfo?.findDetail });
    const poll = win.setInterval(() => { if (!store.status().dirty && win.document.visibilityState === 'visible') store.load(); }, 15000);
    return () => { batch.stop(); win.clearInterval(poll); stop(); };
  } };
}
