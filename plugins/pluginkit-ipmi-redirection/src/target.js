export function currentHostId(location) {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const match = /^\/hosts\/([A-Za-z0-9_-]{1,128})\/?$/.exec(path);
  if (!match) return null;
  let view = new URLSearchParams(query).get('view');
  if (view) { try { view = JSON.parse(view); } catch { /* Some builds use an unquoted view. */ } }
  return !view || view === 'detail' ? match[1] : null;
}
export function bmcUrl(ip) {
  if (typeof ip !== 'string' || ip !== ip.trim()) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    if (ip.split('.').some(part => Number(part) > 255 || (part.length > 1 && part[0] === '0'))) return null;
    return `https://${ip}/`;
  }
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(ip) && ip.includes(':')) {
    try { return new URL(`https://[${ip.replace(/^\[|\]$/g, '')}]/`).href; } catch { return null; }
  }
  return null;
}
export function findIpmiFields(doc) {
  return [...doc.querySelectorAll('.copy-icon-wrapper > span.copy-content')].flatMap(span => {
    if (span.closest('dialog,[role="dialog"],form,[aria-hidden="true"],[hidden]')) return [];
    const field = span.parentElement.parentElement;
    const label = [...field.children].find(child => child.tagName === 'LABEL');
    if (!label || !/^IPMI(?:\s*(?:IP|地址|IP\s*地址))?\s*[:：]?$/i.test(label.textContent.trim())) return [];
    const ip = span.textContent.trim(), url = bmcUrl(ip);
    return url ? [{ span, ip, url }] : [];
  });
}
