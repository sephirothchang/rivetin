// A transient, non-interactive hint. All configuration controls and confirmation
// dialogs belong to the official host UI, not this plugin.
export function createNativeGuide(win) {
  let node = null, timer = null, stopped = false;
  function close() { if (timer !== null) win.clearTimeout(timer); timer = null; node?.remove(); node = null; }
  function show(message) {
    close(); if (stopped || typeof message !== 'string' || !message) return;
    node = win.document.createElement('div'); node.setAttribute('data-rivetin-native-guide', '');
    node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); node.textContent = message.slice(0, 1000);
    Object.assign(node.style, { position: 'fixed', left: '24px', bottom: '84px', zIndex: '2147483000', maxWidth: 'min(480px, calc(100vw - 48px))',
      boxSizing: 'border-box', padding: '12px 16px', border: '1px solid #c7def8', borderRadius: '6px', background: '#f1f7ff', color: '#193c68',
      font: '14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif', boxShadow: '0 4px 18px #14264022', pointerEvents: 'none' });
    win.document.body.append(node); timer = win.setTimeout(close, 6000);
  }
  return { show, close, stop() { stopped = true; close(); } };
}
