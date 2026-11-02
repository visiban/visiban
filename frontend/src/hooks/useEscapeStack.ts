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
 * Priority conventions (the authoritative, fuller list is in frontend/CLAUDE.md):
 *   58 — Board Settings member search (BoardSettingsModal, #2036)
 *   57 — inline confirm removing an all-content member's board role (BoardSettingsModal, #1301)
 *   48 — canceling an in-flight load inside a modal (Import Board sample load)
 *   42 — card-detail block/unblock reason form (CardBlockSection, #1149)
 *   40 — modals and overlays
 *   35-39 — card-detail overlays: 35 archive/delete and comment-delete confirms, 36 move popover,
 *           37 relation picker (and bulk-add overlay), 38 MR/PR link editor, 39 multi-select value menu
 *   44 — default for text/URL custom-field inputs (CustomFieldValueInput, #2036)
 *   43 — card title input (CardDetail) and @-mention popup (MentionTextarea), #2036
 *   34 — card-detail inline new-label input (CardDetail, #1972)
 *   33 — RichTextEditor color picker
 *   32 — card-face custom-field quick-edit popover (CustomFieldQuickEditPopover, #1856)
 *   31 — RichTextEditor edit-mode cancel
 *   30 — side panels (card detail, archived cards)
 *   25 — dropdowns (SelectDropdown, FilterBar, BulkActionToolbar) — via useDropdownEscape
 *   20 — inline confirmation dialogs (bulk delete confirm)
 *   18 — movement-history slide-in (above the view-toggle's 15, below menus and dropdowns at 25)
 *   15 — view-toggle navigation (analytics → summary → board)
 *   12 — focus mode (single-swimlane focus — above selection-clear, below view-toggle)
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
  }, [priority]);
}
