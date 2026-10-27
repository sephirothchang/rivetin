let sequence = 0;
export function createMenuIcon(doc) {
  const ns = 'http://www.w3.org/2000/svg', gradientId = `pluginkit-menu-gradient-${++sequence}`;
  function svg(name, attributes) {
    const node = doc.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  const icon = svg('svg', { class: 'c89-menu-icon', width: '32', height: '32', viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': 'true', focusable: 'false' });
  const defs = svg('defs', {}), gradient = svg('linearGradient', { id: gradientId, x1: '5', y1: '3', x2: '26', y2: '29', gradientUnits: 'userSpaceOnUse' });
  gradient.append(svg('stop', { 'stop-color': '#a4a9f2' }), svg('stop', { offset: '1', 'stop-color': '#7b7fc6' }));
  defs.append(gradient); icon.append(defs);
  icon.append(svg('path', { d: 'M13 6H9a3 3 0 0 0-3 3v4h2a3 3 0 1 1 0 6H6v4a3 3 0 0 0 3 3h4v-2a3 3 0 1 1 6 0v2h4a3 3 0 0 0 3-3v-4h-2a3 3 0 1 1 0-6h2V9a3 3 0 0 0-3-3h-4V5a3 3 0 0 0-6 0Z', fill: '#f7f7ff', stroke: `url(#${gradientId})`, 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return icon;
}
