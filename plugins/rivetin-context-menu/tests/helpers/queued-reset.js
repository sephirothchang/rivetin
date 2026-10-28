export function queuedExternalReset(returnViaA = false) {
  let sent = false;
  return ({ win }) => {
    if (sent) return; sent = true;
    const reset = win.location.href;
    const sidebar = id => { const u = new URL(reset), [route, query = ''] = u.hash.split('?'), p = new URLSearchParams(query); p.set('sidebar', JSON.stringify({ type: 'vm', view: 'detail', id })); u.hash = route + '?' + p; return u.href; };
    const b = sidebar('vm-b'), a = sidebar('vm-a');
    // All events are delivered after location has returned to the owned reset
    // URL, just as queued browser hash events can outlive the navigation.
    const edges = returnViaA ? [[reset, b], [b, a], [a, reset]] : [[reset, b], [b, reset]];
    win.history.replaceState({}, '', reset);
    for (const [oldURL, newURL] of edges) win.dispatchEvent(new win.HashChangeEvent('hashchange', { oldURL, newURL }));
  };
}
