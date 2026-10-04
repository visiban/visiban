import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SwimlaneCustomFieldDefinition } from "../../types";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";

export interface SwimlaneFieldEntry {
  def: SwimlaneCustomFieldDefinition;
  value: string;
}

interface Props {
  swimlaneName: string;
  /** Already filtered to what this viewer may see, and sorted by position.
   *  The popover regroups them: off-row fields first, then the pinned ones. */
  entries: SwimlaneFieldEntry[];
  anchorRect: DOMRect;
  userDateFormat?: string;
  /** Admin only — omit entirely for members and viewers. */
  onEdit?: () => void;
  onDismiss: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * The full list of a swimlane's visible field values (#1140), opened from the
 * `+N` chip in the row's label panel.
 *
 * Read-only for everyone, admins included: a member and an admin see the same
 * component, and the admin's edit path is one click away in the footer. That
 * keeps the popover a single code path rather than a form that conditionally
 * becomes read-only.
 *
 * This exists because the label panel can only show a limited number of pinned values, and a
 * board may define fifteen. Without it, a non-pinned value would be reachable
 * only by an admin opening the edit modal — invisible to everyone else.
 */
export default function SwimlaneFieldsPopover({
  swimlaneName, entries, anchorRect, userDateFormat, onEdit, onDismiss, triggerRef,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Above ModalWrapper's 40 is unnecessary here — this popover lives on the
  // board surface, not inside a modal — so the default dropdown tier is right.
  useDropdownEscape(true, onDismiss, triggerRef);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onDismiss, triggerRef]);

  // Close on scroll rather than reposition. Position is computed once, at
  // click time, and the panel is `fixed` — so scrolling the board would leave
  // it floating over whichever row happened to slide underneath. The pattern
  // this borrows from (CardPeekPopover) never had to solve that because it is
  // hover-triggered and dismisses on mouse-leave; this one is click-persistent.
  // `capture: true` so it fires for the board's inner scroll container, not
  // just the window — which also means it fires for this panel's own list, so
  // a scroll that starts inside the panel is ignored (#1455: scrolling down to
  // the fields below the fold closed the popover instead).
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      onDismiss();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [onDismiss]);

  // Move focus into the panel on open. The popover renders in normal document
  // flow, after this row's card cells, so without this a keyboard user who
  // opened it and pressed Tab would walk through every card in the row before
  // reaching "Edit fields…". Focusing the panel puts the following tab stops
  // where they visually appear.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // The `+N` trigger counts the fields that are NOT on the row, so those lead
  // (#1455). Pinned fields still follow under a divider — this stays the one
  // place a member can read every value — but they no longer push the fields
  // the user asked for below the fold. Each group keeps position order.
  const offRow = entries.filter((e) => !e.def.show_on_row);
  const onRow = entries.filter((e) => e.def.show_on_row);

  // Fixed positioning, same technique as CardPeekPopover: the row panel is
  // inside a scroll container, so an absolutely-positioned panel would be
  // clipped by it. The panel is sized to its content up to the viewport
  // (list max-height below), then placed from its measured height: below the
  // trigger if it fits, else above, else pinned to the viewport's bottom
  // edge. A fixed 16rem cap with an estimated flip hid half of a 15-field
  // board behind a scrollbar macOS doesn't draw.
  const PANEL_WIDTH = 256;
  const MARGIN = 8;
  const left = Math.min(anchorRect.left, window.innerWidth - PANEL_WIDTH - MARGIN);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const height = panelRef.current?.offsetHeight ?? 0;
    const below = anchorRect.bottom + 4;
    const above = anchorRect.top - 4 - height;
    if (below + height <= window.innerHeight - MARGIN) setTop(below);
    else if (above >= MARGIN) setTop(above);
    else setTop(Math.max(MARGIN, window.innerHeight - MARGIN - height));
  }, [anchorRect, entries.length]);

  // Bottom fade while more of the list is below the fold: the overflow is
  // otherwise invisible wherever the OS hides scrollbars.
  const listRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const updateMoreBelow = () => {
    const el = listRef.current;
    if (el) setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  useLayoutEffect(updateMoreBelow, [entries.length]);

  const renderEntry = ({ def, value }: SwimlaneFieldEntry, i: number) => (
    <div
      key={def.id}
      className={`px-3 py-1.5 flex items-start gap-2 ${i > 0 ? "border-t border-line/60" : ""}`}
    >
      <span className="text-xs text-fg-muted shrink-0 w-20 truncate" title={def.name}>{def.name}</span>
      <CustomFieldValueDisplay
        definition={def}
        value={value}
        variant="detail"
        userDateFormat={userDateFormat}
        className="text-xs min-w-0 break-words"
      />
      {def.is_admin_only && (
        <AdminOnlyFieldGlyph className="w-3 h-3 text-fg-faint shrink-0 mt-0.5 ml-auto" />
      )}
    </div>
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={`Field values for ${swimlaneName}`}
      className="fixed z-50 w-64 bg-surface border border-line-strong rounded-lg shadow-xl py-1"
      // Hidden only for the pre-paint measuring pass; useLayoutEffect sets
      // `top` before the browser paints, so this never flashes.
      style={{ top: top ?? 0, left, visibility: top === null ? "hidden" : undefined }}
    >
      <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">Fields</p>
      <div className="relative">
        <div
          ref={listRef}
          data-testid="swimlane-fields-list"
          onScroll={updateMoreBelow}
          className="overflow-y-auto"
          // Viewport minus the margins and the header/footer chrome.
          style={{ maxHeight: `calc(100vh - ${2 * MARGIN}px - 5.5rem)` }}
        >
          {offRow.map(renderEntry)}
          {offRow.length > 0 && onRow.length > 0 && (
            <p className="px-3 pt-2.5 pb-1 border-t border-line text-xs font-semibold uppercase tracking-wide text-fg-muted">On row</p>
          )}
          {onRow.map(renderEntry)}
        </div>
        {moreBelow && (
          <div
            data-testid="swimlane-fields-more-below"
            className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none"
          />
        )}
      </div>
      {onEdit && (
        <>
          <div className="border-t border-line my-1" />
          <button
            onClick={() => { onDismiss(); onEdit(); }}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Edit fields…
          </button>
        </>
      )}
    </div>
  );
}
