import { useState, useRef, useCallback, useEffect, memo } from "react";
import { createPortal } from "react-dom";
import { useDraggable } from "@dnd-kit/core";
import type { Card, CardDensity } from "../../types";
import { PRIORITY_COLORS } from "../../constants/colors";
import Avatar from "../Common/Avatar";
import { formatDueDate, formatRelativeMovedAt } from "../../utils/date";
import { agingTint, idleDays } from "../../utils/agingTint";
import { classifyCardUrgency } from "../../utils/cardUrgency";
import CardPeekPopover from "./CardPeekPopover";



interface Props {
  card: Card;
  onClick?: () => void;
  overlay?: boolean;
  selected?: boolean;
  highlighted?: boolean;
  onSelect?: () => void;
  /**
   * Per-board card layout density (#961). Drives how much metadata renders on
   * the card face. ``comfortable`` (default) shows one urgency badge + one
   * primary label + assignee. ``standard`` adds due date, weight, attachments.
   * ``dense`` shows everything (today's pre-1.1 layout). Default is
   * ``comfortable`` so any caller that forgets to pass the prop (e.g. drag
   * overlay constructed without a board) degrades gracefully.
   */
  density?: CardDensity;
  userTimezone?: string;
  userDateFormat?: string;
  /** When true, the card is non-interactive: no drag, no hover lift, no onClick. Used on the share page. */
  readOnly?: boolean;
  /** When true, renders a compact single-line card with reduced padding (per-user layout pref, distinct from density). */
  compact?: boolean;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
}

// Custom comparator for React.memo — avoids re-renders when the card object
// is referentially new but semantically identical.  We compare the scalar
// fields that affect rendering plus label/assignee identity.
function arePropsEqual(prev: Props, next: Props): boolean {
  if (
    prev.card.id !== next.card.id ||
    prev.card.updated_at !== next.card.updated_at ||
    prev.card.title !== next.card.title ||
    prev.card.column !== next.card.column ||
    prev.card.swimlane !== next.card.swimlane ||
    prev.card.position !== next.card.position ||
    prev.card.priority !== next.card.priority ||
    prev.card.due_date !== next.card.due_date ||
    prev.card.weight !== next.card.weight ||
    prev.card.description !== next.card.description ||
    prev.card.last_moved_at !== next.card.last_moved_at ||
    prev.card.attachment_count !== next.card.attachment_count ||
    prev.card.checklist_total !== next.card.checklist_total ||
    prev.card.checklist_done !== next.card.checklist_done ||
    prev.card.is_stale !== next.card.is_stale ||
    prev.card.archived_at !== next.card.archived_at ||
    prev.card.assignee?.id !== next.card.assignee?.id ||
    prev.card.labels.length !== next.card.labels.length
  ) return false;

  // Shallow label identity check
  for (let i = 0; i < prev.card.labels.length; i++) {
    if (prev.card.labels[i].id !== next.card.labels[i].id) return false;
  }

  return (
    prev.onClick === next.onClick &&
    prev.overlay === next.overlay &&
    prev.selected === next.selected &&
    prev.highlighted === next.highlighted &&
    prev.onSelect === next.onSelect &&
    prev.density === next.density &&
    prev.userTimezone === next.userTimezone &&
    prev.userDateFormat === next.userDateFormat &&
    prev.readOnly === next.readOnly &&
    prev.compact === next.compact &&
    prev.staleness_threshold_days === next.staleness_threshold_days &&
    prev.stale_warning_pct === next.stale_warning_pct
  );
}

const CardItem = memo(function CardItem({ card, onClick, overlay, selected, highlighted, onSelect, density = "comfortable", userTimezone = "", userDateFormat = "MM/DD/YYYY", readOnly = false, compact = false, staleness_threshold_days = 14, stale_warning_pct = 50 }: Props) {
  // Per-density visibility booleans (#961). The decision tree:
  //   comfortable → one urgency badge, one primary label, checklist, assignee
  //   standard    → adds due date (when not in urgency), weight (>1), attachments, second label
  //   dense       → everything (today's pre-1.1 layout: 3 labels, last-moved text/dot, priority badge, description indicator)
  // The middle tier is named ``standard`` rather than ``compact`` to avoid
  // colliding with the per-user *Card layout: Compact / Expanded* toolbar pref.
  const showDescriptionIndicator = density === "dense";
  const showDueDatePill = density !== "comfortable";
  const showAttachments = density !== "comfortable";
  const showWeight = density !== "comfortable";
  const showLastMovedText = density === "dense";
  const showRecentlyMovedDot = density === "dense";
  const showPriorityBadge = density === "dense";
  const labelLimit = density === "dense" ? 3 : density === "standard" ? 2 : 1;
  // useDraggable must be called unconditionally (hook rules). When readOnly,
  // we do not attach its ref or event listeners so the card is non-draggable.
  const draggable = useDraggable({ id: card.id, disabled: readOnly });
  const { attributes, listeners, setNodeRef, isDragging } = draggable;
  const [hovered, setHovered] = useState(false);
  // Tracks tooltip visibility for the aging indicator. We manage this with
  // local state rather than wrapping the card in <Tooltip> (which uses
  // cloneElement and would clobber ref={setNodeRef} from useDraggable).
  const [showTooltip, setShowTooltip] = useState(false);

  // --- Card peek state ---
  // Internal peek state — no prop changes needed, so arePropsEqual doesn't need updating.
  const [peekVisible, setPeekVisible] = useState(false);
  // Captured DOMRect of the card element at hover-start time, stored as state so
  // the popover re-renders at the correct position even if the card scrolls.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // Ref to the card's outer div so we can capture its bounding rect on hover.
  const cardRef = useRef<HTMLDivElement>(null);
  // Ref to the peek timer so we can clear it on mouseleave / drag start.
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Combine dnd-kit's setNodeRef with our own cardRef using a stable callback ref.
  // setNodeRef is stable for the lifetime of the draggable hook instance.
  const compositeRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [setNodeRef],
  );

  const handleMouseEnter = () => {
    setHovered(true);
    setShowTooltip(true);
    // Disabled when: readOnly, overlay prop set. isDragging is checked in the timer callback.
    if (readOnly || overlay) return;
    peekTimer.current = setTimeout(() => {
      // Bail out if dragging started while we were waiting.
      if (cardRef.current) {
        setAnchorRect(cardRef.current.getBoundingClientRect());
        setPeekVisible(true);
      }
    }, 600);
  };

  const handleMouseLeave = () => {
    setHovered(false);
    setShowTooltip(false);
    if (peekTimer.current !== null) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    setPeekVisible(false);
  };

  // When dragging starts, clear the timer and hide peek immediately.
  // Using useEffect so we never call setState during render.
  useEffect(() => {
    if (isDragging) {
      if (peekTimer.current !== null) {
        clearTimeout(peekTimer.current);
        peekTimer.current = null;
      }
      setPeekVisible(false);
    }
  }, [isDragging]);

  // 24h is intentional here — it represents "moved in the current working session",
  // not the board's staleness threshold. The two concepts are independent:
  // staleness_threshold_days flags cards that need attention; the 24h window
  // controls which cards show a dot (very recent) vs. a text label (older).
  const isRecent = card.last_moved_at
    ? Date.now() - new Date(card.last_moved_at).getTime() < 86_400_000
    : false;

  const { overlayClass, bodyOpacityClass } = agingTint(card.last_moved_at, staleness_threshold_days, stale_warning_pct);

  // Compute tooltip content for aging indicator
  const days = idleDays(card.last_moved_at);
  const threshDays = Math.max(1, staleness_threshold_days);
  const warnDays = Math.round(threshDays * (1 - stale_warning_pct / 100));
  const agingRatio = card.last_moved_at
    ? Math.min(1, (Date.now() - new Date(card.last_moved_at).getTime()) / (threshDays * 86_400_000))
    : 0;
  const isAgingStale = agingRatio >= 1.0;
  const agingTooltip = overlayClass !== null
    ? isAgingStale
      ? `Stale — idle for ${days} day${days === 1 ? "" : "s"} (threshold: ${threshDays} day${threshDays === 1 ? "" : "s"})`
      : `Idle for ${days} day${days === 1 ? "" : "s"} — warning at ${warnDays} day${warnDays === 1 ? "" : "s"}, threshold is ${threshDays} day${threshDays === 1 ? "" : "s"}`
    : null;

  const dueInfo = card.due_date ? formatDueDate(card.due_date, userTimezone, userDateFormat) : null;
  // Show a text label for cards moved ≥24h ago; the blue dot (isRecent) handles the <24h case.
  // formatRelativeMovedAt returns "moved today" for ms < 86_400_000, which is unreachable here
  // because movedLabel is only computed when !isRecent (same threshold). See date.ts JSDoc.
  const movedLabel = (showLastMovedText && !isRecent) ? formatRelativeMovedAt(card.last_moved_at, userDateFormat) : null;
  const priorityColor = PRIORITY_COLORS[card.priority] ?? "#6B7280";

  // Worst-offender urgency badge (#961). Drives a single high-signal cue at
  // comfortable / standard density instead of stacking due-date + recently-
  // moved-dot + last-moved-text. Dense intentionally keeps the pre-1.1
  // multi-cue layout — the urgency badge is a *replacement* for those cues at
  // lower densities, not an addition on top of them.
  const urgency = density === "dense"
    ? null
    : classifyCardUrgency(
        { due_date: card.due_date, is_stale: card.is_stale, last_moved_at: card.last_moved_at },
      );
  // Suppress the dedicated due-date pill at lower densities when the urgency
  // badge is already carrying that information (overdue / due-soon). At dense
  // the urgency badge is null so this is always false.
  const dueAlreadyInUrgency = urgency?.kind === "overdue" || urgency?.kind === "due-soon";
  // Suppress the recently-moved dot when urgency is already showing "Just moved".
  const recentAlreadyInUrgency = urgency?.kind === "recent";

  const hasMetadata =
    (showDescriptionIndicator && !!card.description) ||
    card.labels.length > 0 ||
    card.checklist_total > 0 ||
    (showAttachments && card.attachment_count > 0) ||
    (showDueDatePill && dueInfo && !dueAlreadyInUrgency) ||
    card.assignee ||
    (showWeight && card.weight > 1) ||
    (showRecentlyMovedDot && isRecent && !recentAlreadyInUrgency) ||
    !!movedLabel ||
    !!urgency ||
    (showPriorityBadge && card.priority !== "low");

  return (
    <>
    <div className="relative">
      {/* Sibling tooltip — rendered as an absolutely-positioned overlay so we
          never need to wrap the card root div in cloneElement-based <Tooltip>,
          which would clobber ref={setNodeRef} from useDraggable. */}
      {overlayClass && showTooltip && agingTooltip && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 bg-sunken text-fg text-xs rounded px-2 py-1 shadow-lg whitespace-nowrap pointer-events-none"
        >
          {agingTooltip}
        </div>
      )}
    <div
      ref={compositeRef}
      {...attributes}
      {...listeners}
      onClick={readOnly ? undefined : onClick}
      data-no-pan
      data-tour-step="card"
      className={`group bg-surface rounded-md select-none transition-all border relative z-0
        ${readOnly ? "cursor-default" : "cursor-pointer hover:-translate-y-0.5 hover:z-20"}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis focus-visible:ring-offset-2 focus-visible:ring-offset-canvas
        ${isDragging && !overlay ? "opacity-25 !shadow-none !translate-y-0" : ""}
        ${overlay ? "rotate-1 opacity-95 !-translate-y-1" : ""}
        ${highlighted ? "ring-2 ring-primary-soft ring-offset-1 ring-offset-sunken animate-pulse" : selected ? "ring-2 ring-primary-soft bg-info/20" : ""}
      `}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        borderColor: priorityColor,
        boxShadow: isDragging && !overlay
          ? "none"
          : overlay
          ? "0 8px 0 rgba(0,0,0,0.55), 0 16px 40px rgba(0,0,0,0.5)"
          : hovered
          ? "0 4px 0 rgba(0,0,0,0.5), 0 6px 16px rgba(0,0,0,0.35)"
          : "0 2px 0 rgba(0,0,0,0.45), 0 1px 6px rgba(0,0,0,0.25)",
      }}
    >
      {overlayClass && (
        <div className={overlayClass} aria-hidden="true" />
      )}
      {onSelect && (
        <div
          role="checkbox"
          aria-checked={selected}
          tabIndex={0}
          className={`absolute top-1 right-1 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition z-10
            focus:outline-none focus:ring-2 focus:ring-primary-emphasis
            ${selected ? "bg-primary-emphasis border-primary-emphasis text-on-primary opacity-100" : "border-line-strong bg-surface-hover opacity-0 group-hover:opacity-100 focus:opacity-100"}
          `}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSelect(); }}
          onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onSelect(); } }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {selected && (
            <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
        </div>
      )}
      <div className={`px-2.5 ${compact ? "py-1.5" : "py-2"}${bodyOpacityClass ? ` ${bodyOpacityClass}` : ""}`}>
        <p className={`leading-snug ${compact ? "text-xs text-fg line-clamp-1" : "text-sm text-fg line-clamp-2"}`}>{card.title}</p>

        {/* Description exists — indicator only; full content shown in card detail */}

        {hasMetadata && (
          <div className="flex items-center gap-1 mt-1.5 overflow-hidden group-hover:overflow-visible group-hover:flex-wrap">
            {/* The non-compact (per-user layout) branch shows the full density-driven
                metadata row. compact (single-line layout) keeps only the universal
                bits — urgency badge, recently-moved dot, priority badge, assignee —
                regardless of density. */}
            {!compact && (
              <>
                {/* Description indicator — dense only */}
                {showDescriptionIndicator && card.description && (
                  <svg className="w-2.5 h-2.5 text-fg-muted shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-label="Has description">
                    <title>Has description</title>
                    <path d="M2 4h12v1.5H2V4zm0 3h12v1.5H2V7zm0 3h8v1.5H2V10z" />
                  </svg>
                )}

                {/* Worst-offender urgency badge (#961). Replaces the stacked
                    overdue / due-soon / stale / moved-recently signals at lower
                    densities. Tint matches the design system's danger / warning /
                    info tones — no filled background. For date-based kinds the
                    badge carries the formatted date (e.g. ``⚑ 2d late``,
                    ``⏱ Tomorrow``) instead of the generic ``Overdue`` label,
                    so the date isn't lost when the standalone date pill is
                    suppressed. */}
                {urgency && (
                  <span
                    className={`text-xs font-semibold shrink-0 ${
                      urgency.tone === "danger"
                        ? "text-danger"
                        : urgency.tone === "warning"
                        ? "text-warning"
                        : "text-info"
                    }`}
                    title={
                      urgency.kind === "overdue" || urgency.kind === "due-soon"
                        ? `Due ${card.due_date}`
                        : urgency.label
                    }
                  >
                    {urgency.kind === "overdue" && dueInfo
                      ? `⚑ ${dueInfo.label}`
                      : urgency.kind === "due-soon" && dueInfo
                      ? `⏱ ${dueInfo.label}`
                      : urgency.label}
                  </span>
                )}

                {/* Label pills — density-capped: comfortable=1, standard=2, dense=3.
                    Exception to the "filled pill" rule: labels use user-assigned colors
                    that may be light or low-contrast against white text. Tint + colored
                    border keeps the label readable across any hue. See frontend/CLAUDE.md. */}
                {card.labels.slice(0, labelLimit).map((label) => {
                  const display = label.name.length > 8 ? label.name.slice(0, 7) + "…" : label.name;
                  return (
                    <span
                      key={label.id}
                      className="text-xs font-semibold px-1 py-0.5 rounded leading-none shrink-0"
                      style={{ backgroundColor: label.color + "22", color: label.color, border: `1px solid ${label.color}44` }}
                      title={label.name}
                    >
                      {display}
                    </span>
                  );
                })}
                {card.labels.length > labelLimit && (
                  <span className="text-xs text-fg-tertiary shrink-0">+{card.labels.length - labelLimit}</span>
                )}

                {/* Checklist — shown at every density (it's a quick progress signal) */}
                {card.checklist_total > 0 && (
                  <span
                    className={`text-xs font-medium shrink-0 ${
                      card.checklist_done === card.checklist_total ? "text-success" : "text-fg-tertiary"
                    }`}
                    title={`${card.checklist_done}/${card.checklist_total} checklist items`}
                  >
                    ✓{card.checklist_done}/{card.checklist_total}
                  </span>
                )}

                {/* Attachments — standard + dense only; comfortable folds into peek */}
                {showAttachments && card.attachment_count > 0 && (
                  <span className="text-xs text-fg-tertiary shrink-0" title={`${card.attachment_count} attachment(s)`}>
                    📎{card.attachment_count}
                  </span>
                )}

                {/* Due date — only at Standard / Dense, and only when not
                    already carried by the urgency badge. At Comfortable the
                    urgency badge is the single date signal. */}
                {showDueDatePill && dueInfo && !dueAlreadyInUrgency && (
                  <span
                    className={`text-xs font-medium shrink-0 ${dueInfo.overdue ? "text-danger" : "text-fg-tertiary"}`}
                    title={`Due ${card.due_date}`}
                  >
                    {dueInfo.label}
                  </span>
                )}

                {/* Weight — standard + dense, only when > 1 */}
                {showWeight && card.weight > 1 && (
                  <span className="text-xs text-fg-secondary font-medium shrink-0" title={`Weight: ${card.weight}`}>
                    {card.weight}
                  </span>
                )}
              </>
            )}

            {/* Recently moved dot — dense only; lower densities use the urgency
                badge's "Just moved" tone instead. */}
            {showRecentlyMovedDot && isRecent && !recentAlreadyInUrgency && (
              <span className="w-2 h-2 rounded-full bg-primary-emphasis shrink-0" title="Recently moved" />
            )}

            {/* Last-moved text label — dense only (≥24h ago) */}
            {!compact && movedLabel && (
              <span className="text-xs text-fg-muted shrink-0">{movedLabel}</span>
            )}

            {/* Priority badge — dense only. At lower densities the priority is
                already communicated by the existing colored card border. */}
            {showPriorityBadge && card.priority !== "low" && (
              <span
                className="text-xs font-semibold shrink-0 capitalize px-1 py-0.5 rounded leading-none"
                style={{ backgroundColor: priorityColor, color: "#fff" }}
                title={`Priority: ${card.priority}`}
              >
                {card.priority}
              </span>
            )}

            {/* Assignee avatar — always shown */}
            {card.assignee && (
              <Avatar user={card.assignee} size="xs" className="ml-auto" />
            )}
          </div>
        )}
      </div>
    </div>
    </div>
    {peekVisible && anchorRect && !isDragging && createPortal(
      <CardPeekPopover
        card={card}
        anchorRect={anchorRect}
        onMouseEnter={() => setPeekVisible(true)}
        onMouseLeave={() => setPeekVisible(false)}
      />,
      document.body,
    )}
    </>
  );
}, arePropsEqual);

export default CardItem;
