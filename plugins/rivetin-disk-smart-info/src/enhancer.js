import { findDiskDetail } from './detail-adapter.js';
import { loadDiskData, readHistoryPage, errorCode, sameIdentity } from './provider.js';
import { collectDisk, createRequestId, collectionCode, collectionInvalidatesData } from './collection.js';
import { renderPanel } from './view.js';
import { text } from './i18n.js';
import { CSS } from './style.js';

export function installSmartInfo({ win, store, getLocale, provider, findDetail = findDiskDetail, timeoutMs = 8000, collectionTimeoutMs = 45000, collectionIntervalMs = 1500 }) {
  const doc = win.document, style = doc.createElement('style'); style.dataset.pkSmartStyle = ''; style.textContent = CSS;
  doc.head.append(style);
  let stopped = false, current = null, scheduled = null, sequence = 0;
  function locate() { try { return findDetail(win); } catch { return null; } }
  function matching(detail) {
    const found = locate();
    return Boolean(found && found.diskId === detail.diskId && found.path === detail.path && found.root === detail.root && found.tabs === detail.tabs && found.content === detail.content);
  }
  function close() {
    if (!current) return;
    const { panel, button, detail } = current;
    if (current.state.collection?.status === 'running') {
      current.collectionAbort?.abort();
      current.state.collection = { ...current.state.collection, status: 'unknown', code: 'SMART_COLLECTION_WAIT_CANCELLED' };
    }
    panel.hidden = true; button.setAttribute('aria-selected', 'false');
    if (current.open) { detail.content.hidden = current.originalHidden; current.open = false; }
  }
  function unmount() {
    sequence++;
    if (!current) return;
    current.abort?.abort(); current.collectionAbort?.abort(); win.clearTimeout(current.timeout); close();
    current.detail.tabs.removeEventListener('click', nativeClick);
    current.button.remove(); current.panel.remove(); current = null;
  }
  function nativeClick(event) { if (!event.target.closest('[data-pk-smart-tab]')) close(); }
  function draw() {
    if (!current) return;
    current.button.textContent = text(getLocale(), 'Smart 信息', 'SMART information');
    const canCollect = typeof provider?.collect === 'function' && typeof provider?.collection === 'function';
    renderPanel(current.panel, { ...current.state, canCollect }, getLocale(), refresh, loadMore, collectedAt => {
      current.state.selectedAt = collectedAt; draw(); current.panel.scrollTop = 0;
    }, collectNow);
  }
  function refresh() { return read(false); }
  function loadMore() { if (!current?.state.result?.virtualDemo) return read(true); }
  async function read(more, expected) {
    if (!current || stopped || !matching(current.detail)) { unmount(); return; }
    if (current.state.collection?.status === 'running') return;
    if (more && (!current.state.result?.nextCursor || current.state.historyLoading || current.state.historyError)) return;
    const session = current, request = ++sequence;
    session.abort?.abort(); win.clearTimeout(session.timeout);
    const abort = new win.AbortController(); session.abort = abort;
    const collection = session.state.collection;
    session.state = more ? { ...session.state, historyLoading: true } : { loading: true, collection }; draw();
    const timeout = session.timeout = win.setTimeout(() => {
      abort.abort();
      if (current === session && sequence === request && !stopped) { session.state = { error: 'SMART_READ_FAILED', collection }; draw(); }
    }, timeoutMs);
    try {
      const result = more ? await readHistoryPage(provider, session.state.result, session.state.result.nextCursor, abort.signal) : await loadDiskData(provider, session.detail.diskId, abort.signal);
      if (stopped || abort.signal.aborted || current !== session || sequence !== request) return;
      if (!matching(session.detail)) { unmount(); return; }
      if (expected && (!sameIdentity(result.identity, expected.identity) || result.latest.source !== expected.source)) throw new Error('SMART_GENERATION_CHANGED');
      session.state = { result, selectedAt: more ? session.state.selectedAt : null, collection: result.virtualDemo ? undefined : collection }; draw();
    } catch (error) {
      if (!stopped && !abort.signal.aborted && current === session && sequence === request) {
        const code = errorCode(error);
        session.state = more && code === 'SMART_HISTORY_CURSOR_STALE' ? { ...session.state, historyLoading: false, historyError: code } : { error: code, collection };
        draw();
      }
    } finally { win.clearTimeout(timeout); }
  }
  async function collectNow() {
    if (!current || stopped || !current.open || !matching(current.detail) || !current.state.result || current.state.result.virtualDemo || current.state.loading || current.state.historyLoading || current.state.collection?.status === 'running') return;
    const session = current, request = ++sequence, identity = Object.freeze({ ...session.state.result.identity }), source = session.state.result.latest.source;
    session.abort?.abort(); const abort = new win.AbortController(); session.collectionAbort = abort;
    session.state = { ...session.state, collection: { status: 'running' } }; draw();
    const active = () => !stopped && !abort.signal.aborted && current === session && sequence === request && matching(session.detail);
    try {
      const outcome = await collectDisk(provider, { identity, requestId: createRequestId(win.crypto), signal: abort.signal,
        timeoutMs: collectionTimeoutMs, intervalMs: collectionIntervalMs,
        onProgress: value => { if (active()) { session.state.collection = value; draw(); } } });
      if (!active()) return;
      session.state.collection = outcome; draw();
      if (outcome.status === 'succeeded' || outcome.status === 'failed' && outcome.operationId) await read(false, { identity, source });
    } catch (error) {
      if (!active()) return;
      const code = collectionCode(error), collection = { status: 'failed', code };
      session.state = collectionInvalidatesData(code) ? { error: code, collection } : { ...session.state, collection }; draw();
    }
  }
  function mount(detail) {
    const button = doc.createElement('button'), panel = doc.createElement('section');
    button.type = 'button'; button.className = 'tab-item pk-smart-tab'; button.dataset.pkSmartTab = '';
    button.id = 'pk-smart-info-tab'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false'); button.setAttribute('aria-controls', 'pk-smart-info-panel');
    panel.id = 'pk-smart-info-panel'; panel.className = 'pk-smart-panel'; panel.dataset.pkSmartPanel = ''; panel.hidden = true;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
    current = { detail, button, panel, open: false, originalHidden: detail.content.hidden, state: {} };
    button.addEventListener('click', event => {
      event.stopPropagation(); if (!current || !matching(detail)) { unmount(); return; }
      if (!current.open) current.originalHidden = detail.content.hidden;
      detail.content.hidden = true; current.open = true;
      panel.hidden = false; button.setAttribute('aria-selected', 'true'); refresh();
    });
    detail.tabs.append(button); detail.content.after(panel); detail.tabs.addEventListener('click', nativeClick); draw();
  }
  function scan() {
    scheduled = null; if (stopped) return;
    const detail = store.status().loaded && store.get().enabled ? locate() : null;
    if (!detail) { unmount(); return; }
    if (current && !matching(current.detail)) unmount();
    if (!current) mount(detail);
    if (current.locale !== getLocale()) { current.locale = getLocale(); draw(); }
  }
  function schedule() { if (!stopped && scheduled === null) scheduled = win.setTimeout(scan, 40); }
  const observer = new win.MutationObserver(schedule); observer.observe(doc.body, { childList: true, subtree: true });
  const languageObserver = new win.MutationObserver(schedule); languageObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
  const unsubscribe = store.subscribe(schedule);
  win.addEventListener('hashchange', schedule); win.addEventListener('popstate', schedule); win.addEventListener('languagechange', schedule);
  scan();
  return () => {
    if (stopped) return; stopped = true; unmount(); observer.disconnect(); languageObserver.disconnect(); unsubscribe();
    win.clearTimeout(scheduled); win.removeEventListener('hashchange', schedule); win.removeEventListener('popstate', schedule); win.removeEventListener('languagechange', schedule); style.remove();
  };
}
