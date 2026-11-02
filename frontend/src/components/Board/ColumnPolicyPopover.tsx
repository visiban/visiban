import { useEffect, useRef } from "react";
import type { ColumnPolicy } from "../../types";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import { useAnchoredPlacement, POPOVER_VIEWPORT_MARGIN } from "../../hooks/useAnchoredPlacement";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import { POLICY_MODE_LABEL } from "../../utils/columnPolicy";

interface Props {
  columnName: string;
  policy: ColumnPolicy;
  anchorRect: DOMRect;
  /** Admin only — omit for everyone else (no greyed-out control). */
  onEdit?: () => void;
  onDismiss: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const PANEL_WIDTH = 340;

function CriteriaSection({ heading, items }: { heading: string; items: string[] }) {
  return (
    <section className="px-3 py-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary mb-1">{heading}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-fg-tertiary italic">No criteria yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((text, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-fg-secondary">
              <span aria-hidden="true" className="mt-1.5 w-1 h-1 rounded-full bg-fg-tertiary shrink-0" />
              <span className="min-w-0 break-words">{text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A column's written policy (#1101), opened from the header's Policy button.
 *
 * Read-only for everyone; an admin gets "Edit policy" in the footer, which
 * opens EditColumnModal on its Policy tab. Placement, dismissal and the scroll
 * region follow SwimlaneFieldsPopover (frontend/CLAUDE.md § Modals and
 * dialogs, #1455). Escape closes it before anything else on the board.
 */
export default function ColumnPolicyPopover({ columnName, policy, anchorRect, onEdit, onDismiss, triggerRef }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const top = useAnchoredPlacement(panelRef, {
    anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
    deps: [policy.entry.length, policy.done.length],
    onResize: onDismiss,
    onOutsideScroll: onDismiss,
  });

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

  // Focus after placement, never on the hidden measuring pass (#1455).
  const focusedRef = useRef(false);
  const placed = top !== null;
  useEffect(() => {
    if (!placed || focusedRef.current) return;
    focusedRef.current = true;
    const body = bodyRef.current;
    if (body && body.scrollHeight > body.clientHeight) body.focus();
    else panelRef.current?.focus();
  }, [placed]);

  const { moreBelow, onScroll } = useOverflowFade(bodyRef, [policy.entry.length, policy.done.length]);
  const left = Math.max(
    POPOVER_VIEWPORT_MARGIN,
    Math.min(anchorRect.left, window.innerWidth - PANEL_WIDTH - POPOVER_VIEWPORT_MARGIN),
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={`Column policy for ${columnName}`}
      className="fixed z-50 bg-surface border border-line-strong rounded-lg shadow-xl py-1 focus:outline-none"
      style={{
        top: top ?? 0,
        left,
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px))`,
        visibility: top === null ? "hidden" : undefined,
      }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <p className="text-sm font-medium text-fg truncate min-w-0" title={columnName}>{columnName} policy</p>
        <span className="ml-auto shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-surface-hover text-fg-secondary">
          {POLICY_MODE_LABEL[policy.mode]}
        </span>
      </div>
      <div className="relative">
        <div
          ref={bodyRef}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label="Policy criteria"
          className="overflow-y-auto focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
          style={{ maxHeight: `calc(100vh - ${2 * POPOVER_VIEWPORT_MARGIN}px - 6rem)` }}
        >
          <CriteriaSection heading="Entry criteria" items={policy.entry} />
          <div className="border-t border-line/60" />
          <CriteriaSection heading="Definition of done" items={policy.done} />
        </div>
        {moreBelow && (
          <div aria-hidden="true" className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none" />
        )}
      </div>
      {onEdit && (
        <>
          <div className="border-t border-line my-1" />
          <button
            type="button"
            onClick={() => { onDismiss(); onEdit(); }}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Edit policy
          </button>
        </>
      )}
    </div>
  );
}
