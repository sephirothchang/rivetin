import { createConfigurationStore, createHttpConfigurationBackend } from '../../../framework/src/config-store.js';
import { configuration, PLUGIN_ID } from './configuration.js';
import { createSession } from './session.js';
import { createWorkbench } from './view.js';
import { createWorkPage } from './workpage.js';

export default function createSecurityPolicyConverter({ React, win, options = {} }) {
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win, configuration, '/api/rivetin/v1/config'), configuration);
  const session = createSession(), Workbench = createWorkbench(React, win, session), h = React.createElement;
  function Settings({ preferences, locale }) {
    React.useEffect(() => () => session.clear(), []);
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    return h('div', null,
      h('label', { className: 'pksp' }, t('策略标签键（共享配置，明确保存后生效）', 'Policy label key (shared setting, effective after explicit save)'),
        h('input', { type: 'text', maxLength: 80, value: preferences.labelKey, onChange: event => store.update({ labelKey: event.target.value }) })),
      h(Workbench, { locale, savedLabelKey: store.get().labelKey }));
  }
  return { id: PLUGIN_ID, store, Settings,
    ui: {
      schemaVersion: 1,
      pages: [{ id: 'converter', Component: createWorkPage({ React, win, store }) }],
      actions: [],
      contributions: [{
        id: 'open-converter', slot: 'everoute.navigation.tools',
        label: { 'zh-CN': '安全策略转换', 'en-US': 'Security policy converter' },
        icon: 'convert', order: 100, visibility: { requiresContext: [] },
        target: { type: 'page', id: 'converter' }
      }]
    }, activate() {
    session.activate(); session.configure(store.get().labelKey);
    const unsubscribe = store.subscribe(() => session.configure(store.get().labelKey));
    return () => { unsubscribe(); session.stop(); };
  } };
}
