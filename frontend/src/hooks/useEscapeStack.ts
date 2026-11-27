import { useEffect, useRef } from "react";
import { isImeComposing } from "../utils/imeComposition";

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
  // Escape cancels an IME composition; it must not also close the modal (#2167).
  if (isImeComposing(e)) return;
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
 *   61 — focused toast in the shared toast region (ToastProvider, #2060); false unless focus is inside it
 *   60 — command palette
 *   59.5 — custom color popover (ColorSwatchPicker, #2095); between the card context menu's 59 and the palette's 60
 *   59 — card context menu, menu and submenu in one entry (CardContextMenu, #2059)
 *   58 — Board Settings member search (BoardSettingsModal, #2036)
 *   57 — inline confirm removing an all-content member's board role (BoardSettingsModal, #1301)
 *   48 — canceling an in-flight load inside a modal (Import Board sample load)
 *   42 — card-detail block/unblock reason form (CardBlockSection, #1149)
 *   41 — also the field-set editor's Add field menu and Swimlanes dropdown (FIELD_SET_MENU_ESCAPE_PRIORITY, #2570)
 *   40.9 — Board Settings "Let a card's assignee move it anyway" turn-on confirm (#1923): cancels it, else false
 *   40.8 — field-set editor delete / discard confirms and the nested "Copy a field set" modal (BoardSettingsFieldSetsSection, #2570)
 *   40.7 — a choice-row keyboard drag in a Board Settings field editor (SortableChoiceList and, via useSortableFieldDrag, the card-field and swimlane-field lists, #2190): consumed only mid-drag, else false; both share the level because only one drag is active at a time
 *   40.6 — Board Settings column-policy discard prompt (BoardSettingsPoliciesSection, #2156): cancels the prompt, else false
 *   40.5 — Board Settings Danger Zone delete confirmation (BoardSettingsModal, #2034): swallowed while the request runs, clears a typed name, else false
 *   40 — modals and overlays
 *   36.5 — the assignee override's reason box in the Move popover and peek sheet (OverrideReasonForm, #1923)
 *   35-39 — card-detail overlays: 35 archive/delete and comment-delete confirms, 36 move popover,
 *           37 relation picker (and bulk-add overlay), 38 MR/PR link editor, 39 multi-select value menu
 *   44 — default for text/URL custom-field inputs (CustomFieldValueInput, #2036)
 *   43 — card title input (CardDetail) and @-mention popup (MentionTextarea), #2036
 *   34 — card-detail inline new-label input (CardDetail, #1972)
 *   33 — RichTextEditor color picker
 *   32 — card-face custom-field quick-edit popover (CustomFieldQuickEditPopover, #1856)
 *   31 — RichTextEditor edit-mode cancel
 *   30.5 — field set Maximize layer (FieldSetBlocks, #2570)
 *   30.4 — the Children tab's scoped board (CardChildrenTab, #2209, #2370)
 *   30 — side panels (card detail)
 *   25 — dropdowns (SelectDropdown, FilterBar, BulkActionToolbar) — via useDropdownEscape
 *   21 — inline board text fields (add-card, column/swimlane/board rename, search) — via useInlineEditEscape (#1860)
 *   20 — inline confirmation dialogs (bulk delete confirm)
 *   19.5 — Activity drawer filter popover (BoardActivityDrawer, #2316): returns false unless open
 *   19 — Activity drawer, Recent and Archived tabs (BoardActivityDrawer, #2274): non-modal, so below dropdowns, the View menu, inline fields and the bulk-delete confirm
 *   18 — movement-history slide-in (above the view-toggle's 15, below menus and dropdowns at 25)
 *   15 — view-toggle navigation (analytics → summary → board)
 *   14 — Children mode grid on the board (ChildrenModeView, #2370): leaves the grid, below the View menu's 25
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
