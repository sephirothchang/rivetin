import { mountTopologyWorkspace } from './workspace.js';

// The framework supplies only narrow route context and its shared React instance.
export function createTopologyWorkspaceComponent(React, win, source) {
  return function TopologyWorkspace({ active, locale = 'zh-CN', signal, onDirtyChange = () => {}, context }) {
    const root = React.useRef(null), notify = React.useRef(onDirtyChange), session = React.useRef(null);
    notify.current = onDirtyChange;
    React.useEffect(() => {
      if (active !== true || signal?.aborted || !root.current) return undefined;
      const initialClusterId = context?.section === 'cluster-network-topology' ? context.clusterId : null;
      const mounted = mountTopologyWorkspace(root.current, win, { source, locale, signal, initialClusterId, onDirtyChange: dirty => notify.current(dirty) });
      session.current = mounted;
      return () => { if (session.current === mounted) session.current = null; mounted(); };
    }, [active, signal, context?.section, context?.clusterId]);
    React.useEffect(() => { session.current?.updateLocale?.(locale); }, [locale]);
    return React.createElement('div', { ref: root });
  };
}
