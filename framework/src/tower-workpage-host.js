const settingsLabels = new Set(['设置', 'Settings']);
const visible = node => node.isConnected && !node.closest('[hidden],[aria-hidden="true"],[data-c89-plugin-ui]');
const contentVisible = node => visible(node) || node?.hasAttribute('data-rivetin-workpage-native');

// Native structure observed on the supported Tower 4.9 profile. The resolver
// returns only a unique matching surface; plugins never receive these nodes.
export function createTowerWorkPageHost(win) {
  return slot => {
    const hash = win.location.hash.slice(1), split = hash.indexOf('?');
    const pathname = split < 0 ? hash : hash.slice(0, split), query = new URLSearchParams(split < 0 ? '' : hash.slice(split + 1));
    if (slot === 'everoute.navigation.tools' && pathname.startsWith('/everoute/')) {
      const matches = [];
      for (const menu of win.document.querySelectorAll('ul.ant-menu-root[role="menu"]')) {
        if (!visible(menu)) continue;
        const services = [...menu.querySelectorAll('a[href]')].filter(node => node.getAttribute('href') === '#/everoute/service' && visible(node));
        const settings = [...menu.querySelectorAll('button')].filter(node => settingsLabels.has(node.textContent.trim()) && visible(node));
        if (services.length !== 1 || settings.length !== 1) continue;
        const serviceGroup = services[0].closest('li.ant-menu-item-group'), settingGroup = settings[0].closest('li.ant-menu-item-group');
        const mains = [...win.document.querySelectorAll('main.ant-layout-content')].filter(node => contentVisible(node) && !node.contains(menu));
        if (serviceGroup?.parentElement === menu && settingGroup?.parentElement === menu && serviceGroup !== settingGroup &&
            serviceGroup.compareDocumentPosition(settingGroup) & win.Node.DOCUMENT_POSITION_FOLLOWING && mains.length === 1) {
          matches.push({ navigation: menu, before: settingGroup, content: mains[0], listItem: true, selectionRoot: menu, context: Object.freeze({ schemaVersion: 1, section: 'everoute', clusterId: null }) });
        }
      }
      return matches.length === 1 ? matches[0] : null;
    }
    if (slot === 'cluster-network-topology.toolbar.actions') {
      const match = /^\/clusters\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
      if (!match || query.get('view') !== '"networkTopology"') return null;
      const views = [...win.document.querySelectorAll('#networkTopology.react-flow')].filter(contentVisible);
      if (views.length !== 1) return null;
      const content = views[0], bars = [...content.querySelectorAll('.right.item')].filter(node => node.querySelectorAll('.show-line input[type="checkbox"]').length === 1 && node.querySelectorAll('.refresh-wrapper').length === 1);
      if (bars.length !== 1) return null;
      return { navigation: bars[0], before: bars[0].querySelector('.show-line'), content, listItem: false,
        context: Object.freeze({ schemaVersion: 1, section: 'cluster-network-topology', clusterId: match[1] }) };
    }
    return null;
  };
}
