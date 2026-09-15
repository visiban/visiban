import { useRef } from "react";
import type { Card, CustomFieldDefinition } from "../../types";
import { PRIORITY_COLORS } from "../../constants/colors";
import { formatRelativeTime } from "../../utils/date";
import { formatCustomFieldValue, isValidForType } from "../../utils/customFieldValue";

interface CardPeekPopoverProps {
  card: Card;           // from ../../types
  anchorRect: DOMRect;  // captured via getBoundingClientRect() on the card element
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Every board custom field definition (#371) — not pre-filtered; the peek
   *  filters to non-pinned ones itself, since pinned fields are already
   *  visible on the card face and would be redundant here. */
  customFieldDefinitions?: CustomFieldDefinition[];
  userDateFormat?: string;
}

const POPOVER_WIDTH = 288; // w-72 = 288px
const POPOVER_GAP = 8;

export default function CardPeekPopover({ card, anchorRect, onMouseEnter, onMouseLeave, customFieldDefinitions = [], userDateFormat = "MM/DD/YYYY" }: CardPeekPopoverProps) {
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
            className="px-1.5 py-0.5 text-xs rounded font-semibold shrink-0 capitalize"
            style={{ backgroundColor: priorityColor, color: "#fff" }}
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

      {/* Activity & metrics — surfaces fields hidden from the card face at
          comfortable / standard density (#961). Single muted line by design;
          do not stack into multiple rows or the peek becomes the wall-of-icons
          we just removed. ``last_moved_at`` is intentionally omitted here —
          the footer below already shows "Last activity Xd ago", so listing
          it twice in a 288px panel is just noise. */}
      {(() => {
        const parts: string[] = [];

        // Custom fields (#371) — non-pinned only (pinned fields already show
        // on the card face; repeating them here would be redundant), in
        // board position order, capped at 6 populated entries so up to 30
        // possible fields can never blow the "single muted line" rule past
        // readability. "+N more" replaces the 6th entry rather than being
        // appended after it, keeping the hard cap at 6 visible slots.
        const populated = [...customFieldDefinitions]
          .filter((d) => !d.show_on_card)
          .sort((a, b) => a.position - b.position)
          .map((d) => {
            const v = card.custom_field_values.find((cv) => cv.field_definition === d.id);
            if (!v || v.value === "") return null;
            const text = isValidForType(d, v.value) ? formatCustomFieldValue(d, v.value, userDateFormat) : v.value;
            return `${d.name}: ${text}`;
          })
          .filter((p): p is string => p !== null);
        if (populated.length > 6) {
          parts.push(...populated.slice(0, 5), `+${populated.length - 5} more`);
        } else {
          parts.push(...populated);
        }

        if (card.weight > 1) parts.push(`Weight ${card.weight}`);
        if (card.attachment_count > 0) parts.push(`${card.attachment_count} attachment${card.attachment_count === 1 ? "" : "s"}`);
        if (parts.length === 0) return null;
        return (
          <p className="mt-3 text-xs text-fg-muted">{parts.join(" · ")}</p>
        );
      })()}

      {/* Footer */}
      <div className="mt-3 pt-2 border-t border-line flex items-center justify-between text-xs text-fg-muted">
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
