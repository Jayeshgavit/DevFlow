import { useLayoutEffect, useRef, type RefObject } from 'react';

// Coordinate only transient menus, not dialogs or expandable content.
export function useMenuDismissal(open: boolean, close: () => void, roots: RefObject<HTMLElement | null>[], trigger?: RefObject<HTMLElement | null>) {
  const latest = useRef({ close, roots, trigger });
  latest.current = { close, roots, trigger };
  useLayoutEffect(() => {
    if (!open) return;
    const token = {};
    const outside = (event: Event) => {
      if (event.target instanceof Node && !latest.current.roots.some(root => root.current?.contains(event.target as Node))) latest.current.close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      latest.current.close(); latest.current.trigger?.current?.focus({ preventScroll: true });
    };
    const anotherMenu = (event: Event) => { if ((event as CustomEvent).detail !== token) latest.current.close(); };
    const blur = () => latest.current.close();
    window.dispatchEvent(new CustomEvent('devflow-menu-open', { detail: token }));
    window.addEventListener('devflow-menu-open', anotherMenu);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('devflow-menu-open', anotherMenu);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
    };
  }, [open]);
}
