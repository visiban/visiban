import { useRef } from "react";
import type { Card } from "../../types";
import { PRIORITY_COLORS } from "../../constants/colors";
import { formatRelativeTime } from "../../utils/date";

interface CardPeekPopoverProps {
  card: Card;           // from ../../types
  anchorRect: DOMRect;  // captured via getBoundingClientRect() on the card element
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const POPOVER_WIDTH = 288; // w-72 = 288px
const POPOVER_GAP = 8;

export default function CardPeekPopover({ card, anchorRect, onMouseEnter, onMouseLeave }: CardPeekPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Check prefers-reduced-motion — when true, skip the fade-in animation class.
  // Guard against jsdom and older environments where matchMedia may not exist.
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Determine horizontal placement: right of card or flip to left when near right edge
  const wouldOverflowRight = anchorRect.right + POPOVER_GAP + POPOVER_WIDTH > window.innerWidth;

  const style: React.CSSProperties = {
    position: "fixed",
    top: anchorRect.top,
    zIndex: 50,
    width: POPOVER_WIDTH,
    ...(wouldOverflowRight
      ? { right: window.innerWidth - anchorRect.left + POPOVER_GAP }
      : { left: anchorRect.right + POPOVER_GAP }),
  };

  const priorityColor = PRIORITY_COLORS[card.priority] ?? "#6B7280";

  // Build checklist items from checklist_total / checklist_done counts.
  // The card summary only carries counts, not the individual item list, so we
  // render a compact progress representation instead of individual item rows.
  const hasChecklist = card.checklist_total > 0;

  // Last activity footer — use last_moved_at as the best available signal
  const lastActivityText = card.last_moved_at
    ? `Last activity ${formatRelativeTime(card.last_moved_at)}`
    : null;

  const lastActivityUser = card.created_by?.display_name ?? null;

  return (
    <div
      ref={popoverRef}
      role="tooltip"
      style={style}
      className={`bg-surface border border-line-strong rounded-lg shadow-xl p-3 text-sm pointer-events-auto select-none
        ${prefersReducedMotion ? "" : "animate-fade-in"}
      `}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Title row with priority badge */}
      <div className="flex items-start gap-2">
        <p className="text-fg font-medium leading-snug flex-1 min-w-0 line-clamp-2">
          {card.title}
        </p>
        {card.priority !== "low" && (
          <span
            className="px-1.5 py-0.5 text-[10px] rounded font-semibold text-fg shrink-0 capitalize"
            style={{ backgroundColor: priorityColor }}
          >
            {card.priority}
          </span>
        )}
      </div>

      {/* Description — truncated to ~3 lines */}
      {card.description && (
        <p className="text-xs text-fg-secondary mt-2 leading-relaxed line-clamp-3">
          {card.description}
        </p>
      )}

      {/* Checklist progress */}
      {hasChecklist && (
        <div className="mt-3 space-y-1 text-xs">
          <div className="flex items-center gap-2">
            {/* Progress bar */}
            <div className="flex-1 h-1.5 bg-surface-hover rounded-full overflow-hidden">
              <div
                className="h-full bg-success-emphasis rounded-full transition-all"
                style={{
                  width: `${Math.round((card.checklist_done / card.checklist_total) * 100)}%`,
                }}
              />
            </div>
            <span
              className={
                card.checklist_done === card.checklist_total
                  ? "line-through text-fg-muted"
                  : "text-fg-secondary"
              }
            >
              {card.checklist_done}/{card.checklist_total}
            </span>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 pt-2 border-t border-line flex items-center justify-between text-[11px] text-fg-muted">
        <span>
          {lastActivityText
            ? lastActivityUser
              ? `${lastActivityText} by @${lastActivityUser}`
              : lastActivityText
            : "No activity yet"}
        </span>
        <span className="text-fg-tertiary shrink-0 ml-2">Click to open ↗</span>
      </div>
    </div>
  );
}
