/** Trigger rectangle captured when a menu opens (viewport coordinates). */
export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function captureMenuAnchor(trigger: HTMLElement | null): MenuAnchor | null {
  const r = trigger?.getBoundingClientRect();
  return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
}
