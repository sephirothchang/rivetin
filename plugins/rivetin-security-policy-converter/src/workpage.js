import { createSession } from './session.js';
import { createWorkbench } from './view.js';

// The host owns navigation and activation; this component owns only its page data.
export function createWorkPage({ React, win, store }) {
  const h = React.createElement;
  return function WorkPage({ active = false, locale = 'zh-CN', signal, onDirtyChange }) {
    const [session] = React.useState(() => createSession());
    const [Workbench] = React.useState(() => createWorkbench(React, win, session));
    const [, render] = React.useState(0);
    const [abortedSignal, setAbortedSignal] = React.useState(null);
    const dirtyCallback = React.useRef(onDirtyChange), lastDirty = React.useRef();
    dirtyCallback.current = onDirtyChange;
    const loaded = store.status().loaded === true;
    const enabled = active === true && signal?.aborted !== true && (!signal || signal !== abortedSignal);
    function reportDirty() {
      const state = session.view();
      const dirty = session.isActive() && Boolean(state.reading || state.inventoryText || state.trafficText || state.clusterId || state.externalText || Object.keys(state.columnMap).length || state.result);
      if (lastDirty.current !== dirty) {
        lastDirty.current = dirty;
        if (typeof dirtyCallback.current === 'function') dirtyCallback.current(dirty);
      }
    }
    React.useEffect(() => { lastDirty.current = undefined; reportDirty(); }, [onDirtyChange]);
    React.useEffect(() => {
      const unsubscribe = session.subscribe(reportDirty);
      reportDirty();
      return () => {
        unsubscribe();
        if (lastDirty.current !== false && typeof dirtyCallback.current === 'function') dirtyCallback.current(false);
      };
    }, [session]);
    React.useEffect(() => {
      const sync = () => {
        session.configure(store.get().labelKey);
        render(value => value + 1);
      };
      const unsubscribe = store.subscribe(sync);
      sync();
      return () => { unsubscribe(); session.stop(); };
    }, [session]);
    React.useEffect(() => {
      const abort = () => { session.stop(); setAbortedSignal(signal); };
      if (enabled && loaded) session.activate();
      else session.stop();
      signal?.addEventListener('abort', abort, { once: true });
      return () => { signal?.removeEventListener('abort', abort); session.stop(); };
    }, [enabled, loaded, session, signal]);
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    return h('section', { 'data-rivetin-policy-workpage': '', lang: locale },
      !enabled ? h('p', { role: 'status' }, t('安全策略转换未启用或当前不可用。', 'Security policy conversion is disabled or unavailable.')) :
        !loaded ? h('p', { role: 'status' }, t('请先由框架加载共享配置，再使用转换工作页。', 'Load shared configuration through the framework before using this page.')) :
          h(Workbench, { locale, savedLabelKey: store.get().labelKey, surface: 'workpage' }));
  };
}
