const NOTICE_SELECTOR = '[data-rivetin-upgrade-notice]';
const CSS = '.pk-upgrade-notice{display:flex;align-items:flex-start;gap:9px;max-width:100%;margin:10px 0 16px;padding:10px 12px;border:1px solid #f1d08c;border-radius:7px;background:#fff8e6;color:#78521b;font-family:inherit;font-size:12px;line-height:1.65;box-sizing:border-box}.pk-upgrade-notice svg{flex-shrink:0;margin-top:2px}.pk-upgrade-notice>span{flex:1;min-width:0}.pk-upgrade-notice button{flex-shrink:0;border:0;background:transparent;padding:0;color:#096dd9;font:inherit;cursor:pointer;white-space:nowrap}.pk-upgrade-notice button:focus-visible{outline:2px solid #1385ee;outline-offset:3px}';
function heading(document) {
  const candidates = [...document.querySelectorAll('h1,h2,.title,.upgrade-center .page-title,.upgrade-center-title')].filter(element => {
    if (element.closest(NOTICE_SELECTOR) || element.closest('[hidden],[aria-hidden="true"],.global-header,#global-header,[data-testid="global-header"],.c89-plugin-root,.c89-backdrop,.c89-panel,[role="dialog"],[role="alertdialog"]')) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = document.defaultView.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const text = element.textContent.trim().replace(/\s+/g, ' ');
    return /^(?:CloudTower\s*(?:升级|Upgrade)(?:\s+Center)?|升级中心|Upgrade\s+Center)$/i.test(text) || Boolean(element.closest('.upgrade-center')) && /^(?:升级|Upgrade)$/i.test(text);
  });
  return candidates.length === 1 ? candidates[0] : null;
}
export function installUpgradeNotice({ win, getState, getLocale = () => win.document.documentElement.lang, onOpen }) {
  const document = win.document;
  let stopped = false, scheduled = false, notice = null, style = null, anchor = null;
  function remove() { notice?.remove(); style?.remove(); notice = null; style = null; anchor = null; }
  function update() {
    if (stopped) return false;
    let state;
    try { state = getState(); } catch { remove(); return false; }
    const route = /^#\/(?:upgrade-center|settings\/upgrade-management)\/?(?:\?|$)/.test(win.location.hash);
    if (!route || state?.enabled !== true || !Array.isArray(state.plugins) || !state.plugins.some(plugin => plugin?.installed === true && (plugin.enabled === true || plugin.active === true))) { remove(); return false; }
    const title = heading(document);
    if (!title) { remove(); return false; }
    const existing = document.querySelector(NOTICE_SELECTOR);
    if (existing && existing !== notice) return false;
    let en = false;
    try { en = getLocale() === 'en-US'; } catch { /* A missing host locale uses Chinese. */ }
    if (!notice) {
      notice = document.createElement('aside'); notice.className = 'pk-upgrade-notice'; notice.setAttribute('data-rivetin-upgrade-notice', ''); notice.setAttribute('role', 'note');
      const ns = 'http://www.w3.org/2000/svg', icon = document.createElementNS(ns, 'svg');
      for (const [key, value] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(key, value);
      const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9');
      const path = document.createElementNS(ns, 'path'); path.setAttribute('d', 'M12 11v6M12 7v1'); icon.append(circle, path);
      const text = document.createElement('span'), button = document.createElement('button'); button.type = 'button';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); try { onOpen?.(); } catch { /* Keep native upgrade controls independent of the extension callback. */ } });
      notice.append(icon, text, button);
      style = document.createElement('style'); style.setAttribute('data-rivetin-upgrade-notice-style', ''); style.textContent = CSS; document.head.append(style);
    }
    const text = en ? 'Rivetin extensions are enabled on this instance. Before upgrading CloudTower, confirm that the framework and installed plugins support the target version.' : '此实例已启用 Rivetin 扩展。升级 CloudTower 前，请确认插件框架及子插件与目标版本兼容。';
    const label = en ? 'Open Plugin Center' : '打开插件中心';
    if (notice.children[1].textContent !== text) notice.children[1].textContent = text;
    if (notice.children[2].textContent !== label) notice.children[2].textContent = label;
    if (anchor !== title || !notice.isConnected || title.nextElementSibling !== notice) { title.insertAdjacentElement('afterend', notice); anchor = title; }
    return true;
  }
  function queue() {
    if (stopped || scheduled) return;
    scheduled = true;
    win.queueMicrotask(() => { scheduled = false; if (!stopped) update(); });
  }
  const observer = new win.MutationObserver(queue);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['lang', 'hidden', 'aria-hidden'] });
  win.addEventListener('hashchange', queue); win.addEventListener('popstate', queue);
  update();
  function cleanup() {
    if (stopped) return;
    stopped = true; observer.disconnect(); win.removeEventListener('hashchange', queue); win.removeEventListener('popstate', queue); remove();
  }
  cleanup.update = update;
  return cleanup;
}
