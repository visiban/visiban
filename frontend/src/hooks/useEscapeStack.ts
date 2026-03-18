import { useEffect, useRef } from "react";

type EscapeHandler = () => boolean | void;

interface Entry {
  fn: () => boolean | void;
  priority: number;
}

// Module-level registry — shared across all component instances.
// Handlers are stored as stable wrappers around refs so that re-renders
// do not cause churn in the registry.
const registry: Entry[] = [];
let listenerActive = false;

function dispatch(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // Fire handlers in descending priority order. The first handler that does
  // NOT return false consumes the event and stops the chain.
  const sorted = [...registry].sort((a, b) => b.priority - a.priority);
  for (const entry of sorted) {
    if (entry.fn() !== false) return;
  }
}

/**
 * Register an escape key handler in the global priority stack.
 *
 * Handlers fire in descending priority order when Escape is pressed.
 * Return `false` to signal "not handled" and allow the next lower-priority
 * handler to run. Any other return value (including void) consumes the event.
 *
 * Priority conventions:
 *   40 — modals and overlays
 *   30 — side panels (card detail, archived cards)
 *   20 — inline confirmation dialogs (bulk delete confirm)
 *   10 — selection state (multi-card selection)
 *    0 — page-level navigation (board → referrer, group → referrer)
 *
 * The handler is registered on mount and removed on unmount, so the active
 * set of handlers naturally reflects what is currently rendered.
 */
export function useEscapeStack(fn: EscapeHandler, priority: number): void {
  const fnRef = useRef<EscapeHandler>(fn);
  // Keep the ref current without re-running the effect on every render.
  fnRef.current = fn;

  useEffect(() => {
    const entry: Entry = { fn: () => fnRef.current(), priority };
    registry.push(entry);
    if (!listenerActive) {
      document.addEventListener("keydown", dispatch);
      listenerActive = true;
    }
    return () => {
      const idx = registry.indexOf(entry);
      if (idx !== -1) registry.splice(idx, 1);
      if (registry.length === 0) {
        document.removeEventListener("keydown", dispatch);
        listenerActive = false;
      }
    };
  // priority is the only dep — fn stays current via fnRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority]);
}
