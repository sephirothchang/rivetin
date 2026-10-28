// Presentation-only coordinates. They never enter the topology transaction or shared config.
export const CANVAS_WIDTH = 2400;
export const CANVAS_HEIGHT = 6750;
export function createLayout() {
  const positions = new Map();
  const clamp = (x, y) => ({ x: Math.max(12, Math.min(CANVAS_WIDTH - 260, x)), y: Math.max(60, Math.min(CANVAS_HEIGHT - 180, y)) });
  return {
    sync(topology) {
      const live = new Set(); let cursor = 66;
      for (const sw of topology.switches) {
        const key = `vds:${sw.id}`; live.add(key);
        if (!positions.has(key)) positions.set(key, clamp(360, cursor));
        const parent = positions.get(key);
        for (const [index, net] of (sw.networks || []).entries()) {
          const key = `network:${net.id}`; live.add(key);
          if (!positions.has(key)) positions.set(key, clamp(parent.x + 16, parent.y + 98 + index * 62));
        }
        cursor = Math.max(cursor, parent.y + 128 + sw.networks.length * 62);
      }
      for (const key of positions.keys()) if (!live.has(key)) positions.delete(key);
    },
    get(key) { const point = positions.get(key); return point ? { ...point } : null; },
    set(key, x, y) { positions.set(key, clamp(x, y)); },
    reset() { positions.clear(); },
    bottom() { return Math.max(1350, ...[...positions.values()].map(point => point.y + 180)); }
  };
}
