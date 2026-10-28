import { currentHostId, findIpmiFields } from './target.js';
import { resolveBmcProfile } from './bmc-profiles.js';

export function installIpmiEnhancer({ win, store, history, resolveDirectUrl = target => target.url,
  requestLaunch, getHostContext = () => ({}), onStatus = () => {}, onError = () => {} }) {
  const doc = win.document, owned = new Map();
  let frame = null, disposed = false;
  function restore(span, state) {
    if (state.anchor.parentNode === span) state.anchor.replaceWith(...state.anchor.childNodes);
    owned.delete(span);
  }
  function scan() {
    frame = null;
    if (disposed) return;
    const prefs = store.get(), hostId = currentHostId(win.location);
    const fields = hostId && prefs.ipmiEnabled ? findIpmiFields(doc) : [];
    const candidates = fields.length === 1 ? fields : [];
    for (const [span, state] of owned) {
      if (!candidates.some(field => field.span === span) || !span.isConnected) restore(span, state);
    }
    if (fields.length > 1) { onStatus('检测到多个 IPMI 字段，已停止增强'); return; }
    if (!candidates.length) { onStatus(prefs.ipmiEnabled ? '当前页面没有可增强的 IPMI 地址' : 'IPMI 跳转已关闭'); return; }
    const field = candidates[0], existing = owned.get(field.span);
    const directUrl = resolveDirectUrl({ ...field, hostId });
    // A resolver is trusted application configuration, never derived from a page's href.
    let destination;
    try { destination = new URL(directUrl, win.location.href); } catch { return; }
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) return;
    const profile = resolveBmcProfile(prefs, { hostId, ...getHostContext(hostId) });
    const canAutoLogin = prefs.loginMode === 'megarac' && typeof requestLaunch === 'function' && profile.ready && profile.vendor.simulatedAutoLogin;
    const statusText = !profile.ready ? '等待资产清单，暂时仅提供普通跳转' :
      prefs.loginMode === 'megarac' && !profile.vendor.simulatedAutoLogin ? `${profile.vendor.label} · 自动登录待适配，当前仅普通跳转` :
      canAutoLogin ? `${profile.vendor.label} · 模拟自动登录已就绪` : `${profile.vendor.label} · 普通跳转已就绪`;
    if (existing?.anchor.parentNode === field.span) {
      const a = existing.anchor;
      if (a.href !== destination.href) a.href = destination.href;
      if (a.textContent !== field.ip) a.textContent = field.ip;
      a.target = prefs.openInNewTab ? '_blank' : '_self';
      existing.target = { hostId, ip: field.ip, url: field.url, vendor: profile.vendor.id };
      existing.auto = canAutoLogin;
      onStatus(statusText);
      return;
    }
    if (existing) owned.delete(field.span);
    const a = doc.createElement('a');
    a.className = 'c89-ipmi-link'; a.textContent = field.ip; a.href = destination.href;
    a.target = prefs.openInNewTab ? '_blank' : '_self'; a.rel = 'noopener noreferrer';
    a.title = '打开此主机的 IPMI 登录页';
    const state = { anchor: a, target: { hostId, ip: field.ip, url: field.url, vendor: profile.vendor.id }, auto: canAutoLogin };
    a.addEventListener('click', async event => {
      if (disposed || currentHostId(win.location) !== state.target.hostId || field.span.textContent.trim() !== state.target.ip || !store.get().ipmiEnabled) {
        event.preventDefault(); schedule(); return;
      }
      if (!state.auto || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      const target = { ...state.target };
      function isCurrent() {
        const current = store.get(), profile = resolveBmcProfile(current, { hostId: target.hostId, ...getHostContext(target.hostId) });
        return !disposed && a.isConnected && a.parentNode === field.span &&
          currentHostId(win.location) === target.hostId && field.span.textContent.trim() === target.ip &&
          current.ipmiEnabled && current.loginMode === 'megarac' && profile.ready && profile.vendor.id === target.vendor;
      }
      if (!isCurrent()) { schedule(); return; }
      let popup;
      if (store.get().openInNewTab) {
        popup = win.open('about:blank', '_blank');
        if (!popup) { onError('浏览器阻止了新窗口，请允许弹出窗口后重试。'); return; }
        popup.opener = null;
      }
      try {
        const url = await requestLaunch(target);
        if (!isCurrent()) { popup?.close(); return; }
        if (popup) popup.location.replace(url); else win.location.assign(url);
      } catch {
        popup?.close(); onError('无法建立登录会话，请使用普通跳转重试。');
      }
    });
    field.span.replaceChildren(a); owned.set(field.span, state);
    onStatus(statusText);
  }
  function schedule() { if (frame === null && !disposed) frame = win.requestAnimationFrame(scan); }
  const observer = new win.MutationObserver(records => {
    if (records.some(record => !record.target.parentElement?.closest('[data-c89-plugin-ui]'))) schedule();
  });
  observer.observe(doc.body, { childList: true, characterData: true, subtree: true });
  win.addEventListener('hashchange', schedule); win.addEventListener('popstate', schedule);
  win.addEventListener('c89:inventory-updated', schedule);
  const unsubscribe = store.subscribe(schedule);
  const unlisten = typeof history?.listen === 'function' ? history.listen(schedule) : null;
  schedule();
  return () => {
    disposed = true; observer.disconnect(); if (frame !== null) win.cancelAnimationFrame(frame);
    win.removeEventListener('hashchange', schedule); win.removeEventListener('popstate', schedule);
    win.removeEventListener('c89:inventory-updated', schedule);
    unsubscribe(); if (typeof unlisten === 'function') unlisten();
    for (const [span, state] of owned) restore(span, state);
  };
}
