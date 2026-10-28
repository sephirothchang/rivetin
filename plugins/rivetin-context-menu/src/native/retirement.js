// A plugin-owned document slot survives script re-evaluation on that document.
// Weak sets do not retain removed controls, and a new document starts clean.
const stateKey = Symbol.for('rivetin-context-menu.native-retirement.v1');

export function nativeRetirement(win) {
  const doc = win.document;
  if (!Object.hasOwn(doc, stateKey)) Object.defineProperty(doc, stateKey, {
    value: Object.freeze({ panes: new WeakSet(), controls: new WeakSet() }),
  });
  const retired = doc[stateKey];
  function snapshot({ includeRows = true } = {}) {
    const panes = [...doc.querySelectorAll('.drawer-content-inner')];
    return { panes, controls: [
      ...panes.flatMap(pane => [...pane.querySelectorAll('*')]),
      ...doc.querySelectorAll('.ant-dropdown,.ant-dropdown *,.ant-dropdown-menu-submenu-popup,.ant-dropdown-menu-submenu-popup *'),
      ...(includeRows ? doc.querySelectorAll('tr[data-row-key] td[unique="_action_"] *,tr[data-row-key] td.cell__action_ *') : []),
    ] };
  }
  function quarantine(value = snapshot()) {
    for (const pane of value.panes) retired.panes.add(pane);
    for (const control of value.controls) retired.controls.add(control);
  }
  function trusted(node) {
    if (!node || node.ownerDocument !== doc) return false;
    for (let current = node; current; current = current.parentElement) {
      if (retired.panes.has(current) || retired.controls.has(current)) return false;
    }
    return true;
  }
  return { snapshot, quarantine, trusted };
}
