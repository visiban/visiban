import { useEffect, useRef } from "react";
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
  /** Already filtered to what this viewer may see, and sorted by position. */
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
 * This exists because the label panel can only show three pinned values, and a
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
  // just the window.
  useEffect(() => {
    const onScroll = () => onDismiss();
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

  // Fixed positioning with a viewport flip, same technique as CardPeekPopover:
  // the row panel is inside a scroll container, so an absolutely-positioned
  // panel would be clipped by it.
  const PANEL_WIDTH = 256;
  const estimatedHeight = Math.min(entries.length * 34 + 64, 320);
  const flipUp = anchorRect.bottom + estimatedHeight > window.innerHeight;
  const top = flipUp ? Math.max(8, anchorRect.top - estimatedHeight) : anchorRect.bottom + 4;
  const left = Math.min(anchorRect.left, window.innerWidth - PANEL_WIDTH - 8);

  return (
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={`Field values for ${swimlaneName}`}
      className="fixed z-50 w-64 bg-surface border border-line-strong rounded-lg shadow-xl py-1"
      style={{ top, left }}
    >
      <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">Fields</p>
      <div className="max-h-[16rem] overflow-y-auto">
        {entries.map(({ def, value }, i) => (
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
        ))}
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
