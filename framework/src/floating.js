export function clampPosition(position, viewport, size) {
  const margin = 12;
  return { x: Math.round(Math.max(margin, Math.min(position.x, Math.max(margin, viewport.width - size.width - margin)))),
    y: Math.round(Math.max(margin, Math.min(position.y, Math.max(margin, viewport.height - size.height - margin)))) };
}
export function createFloatingButton(React) {
  const h = React.createElement, { useEffect, useRef, useState } = React;
  return function FloatingButton({ win, state, label, settingsLabel, position, onPosition, onOpen }) {
    const button = useRef(null), gesture = useRef(null), suppressClick = useRef(false), [dragPosition, setDragPosition] = useState(null), [, redraw] = useState(0);
    const clamp = point => clampPosition(point, { width: win.innerWidth, height: win.innerHeight }, button.current?.getBoundingClientRect() || { width: 160, height: 44 });
    useEffect(() => { const resize = () => redraw(value => value + 1); win.addEventListener('resize', resize); return () => win.removeEventListener('resize', resize); }, [win]);
    const point = dragPosition || (position ? clamp(position) : null);
    function down(event) {
      if (event.button !== 0 || gesture.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    function move(event) {
      const drag = gesture.current; if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.moved = true; drag.position = clamp({ x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y });
      setDragPosition(drag.position); event.preventDefault();
    }
    function up(event, cancelled = false) {
      const drag = gesture.current; if (!drag || drag.id !== event.pointerId) return;
      gesture.current = null;
      if (drag.moved) { suppressClick.current = true; if (!cancelled) onPosition(drag.position); }
      setDragPosition(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return h('button', { ref: button, className: `c89-plugin-fab ${dragPosition ? 'pk-dragging' : ''}`, type: 'button',
      style: point ? { left: point.x, top: point.y, right: 'auto', bottom: 'auto' } : { right: 24, bottom: 88 },
      title: settingsLabel, 'aria-label': `${label} · ${settingsLabel}`,
      onPointerDown: down, onPointerMove: move, onPointerUp: event => up(event), onPointerCancel: event => up(event, true),
      onLostPointerCapture: event => { if (gesture.current) up(event, true); },
      onClick: event => { if (suppressClick.current) { suppressClick.current = false; if (event.detail !== 0) { event.preventDefault(); return; } } onOpen(); },
      onKeyDown: event => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
        onPosition(clamp({ x: rect.left + (event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0), y: rect.top + (event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0) }));
      } }, h('span', { className: `pk-status-dot pk-status-${state}`, 'aria-hidden': true }), h('span', { 'aria-live': 'polite' }, label));
  };
}
