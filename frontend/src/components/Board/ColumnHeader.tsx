import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardColor } from "../../utils/boardColors";
import { useInlineEditEscape } from "../../hooks/useInlineEditEscape";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column } from "../../types";
import EditColumnModal, { type EditColumnTab } from "./EditColumnModal";
import ColumnPolicyPopover from "./ColumnPolicyPopover";
import { columnPolicy, policyCountSummary } from "../../utils/columnPolicy";
import { updateColumn } from "../../api/boards";
import OverflowMenu, { type OverflowItem } from "../Layout/OverflowMenu";
import { isImeComposing } from "../../utils/imeComposition";
import { columnTintStyle } from "../../utils/colorContrast";

interface Props {
  /** Colors in use on the board, for the edit modal's custom color popover (#2098). */
  boardColors?: BoardColor[];
  /** This is the board's first not-done column (#2298); shown in its settings. */
  isIntakeColumn?: boolean;
  column: Column;
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  onColumnUpdated: (column: Column) => void;
  onRequestDelete: (column: Column) => void;
  collapsed: boolean;
  hidden?: boolean;
  abbreviation?: string;
  width?: number;
  onToggleCollapse: () => void;
  hardWipEnforced?: boolean;
  /** Kept for API compatibility; the redesigned count line always shows "n / limit" (#2270). */
  showWipAtLimit?: boolean;
  /**
   * Opens the add-card input in this column (#2270). Omitted when the viewer cannot
   * create cards here, which removes the button rather than disabling it.
   */
  onAddCard?: () => void;
}

export default function ColumnHeader({ boardColors, isIntakeColumn, column, cards, boardId, isAdmin, onColumnUpdated, onRequestDelete, collapsed, hidden, abbreviation, width, onToggleCollapse, hardWipEnforced, onAddCard }: Props) {
  // Which tab EditColumnModal opens on, or null when it is closed (#1101:
  // "Add policy…" and the popover's "Edit policy" open the Policy tab).
  const [editTab, setEditTab] = useState<EditColumnTab | null>(null);
  // Policy popover anchor (#1101), null while closed.
  const [policyRect, setPolicyRect] = useState<DOMRect | null>(null);
  const policyTriggerRef = useRef<HTMLButtonElement>(null);
  const policy = columnPolicy(column);
  const hasPolicy = policy !== null;
  // A policy removed over the socket closes the popover for good: left set,
  // the stale anchor would reopen it (and take focus) the moment a policy is
  // added again. Adjusted during render, so no stale frame is committed.
  if (!hasPolicy && policyRect !== null) setPolicyRect(null);
  const closePolicy = useCallback(() => setPolicyRect(null), []);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus returns to the opener on Escape/Enter (#2087); a blur-commit never steals focus back.
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const focusTriggerRef = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `col:${column.id}`, disabled: !isAdmin });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : undefined };

  const cardCount = cards.length;
  const totalWeight = cards.reduce((sum, c) => sum + c.weight, 0);
  const overWip = column.wip_limit !== null && column.wip_limit > 0 && cardCount > column.wip_limit;
  const overWeight = column.weight_limit !== null && totalWeight > column.weight_limit;
  const hasLimit = column.wip_limit !== null && column.wip_limit > 0;
  // Over-limit is a warning, not an error (board-redesign.md § Column headers): the accent
  // strip (collapsed header) and the meter and count (expanded) all use the warning tokens.
  const accentClass = overWip || overWeight ? "border-t-2 border-t-warning-emphasis" : "";
  const cardCountLabel = cardCount === 1 ? "1 card" : `${cardCount} cards`;
  // Meter fill: proportional to the limit, full at and over it. Never rendered without a limit.
  const meterPct = hasLimit ? Math.min(100, (cardCount / column.wip_limit!) * 100) : 0;

  const startRenaming = () => {
    setDraft(column.name);
    setRenaming(true);
  };

  const commitRename = async (restoreFocus = false) => {
    const trimmed = draft.trim();
    if (restoreFocus) focusTriggerRef.current = true;
    setRenaming(false);
    if (!trimmed || trimmed === column.name) return;
    setRenameError(null);
    try {
      const updated = await updateColumn(boardId, column.id, { name: trimmed });
      onColumnUpdated(updated);
    } catch {
      setRenameError("Failed to rename column. Please try again.");
    }
  };

  const cancelRename = () => {
    focusTriggerRef.current = true;
    setRenaming(false);
    setDraft("");
  };

  useEffect(() => {
    if (!renaming && focusTriggerRef.current) {
      focusTriggerRef.current = false;
      renameTriggerRef.current?.focus();
    }
  }, [renaming]);

  // Escape cancels the rename through the stack so it does not also clear the selection (#1860).
  useInlineEditEscape(() => renaming, cancelRename);

  // Kebab items are memoized so the OverflowMenu's items-driven effects don't
  // re-fire on every parent render. `column.name` is captured for the delete
  // accessible label so screen readers announce *which* column is being acted on.
  const kebabItems = useMemo<OverflowItem[]>(
    () => [
      { id: "rename", label: "Rename", onSelect: startRenaming },
      { id: "edit", label: "Edit settings…", onSelect: () => setEditTab("settings") },
      // #1101: an admin with no policy gets a direct path to write one. With a
      // policy, the always-visible Policy button's popover holds "Edit policy".
      ...(hasPolicy ? [] : [{ id: "add-policy", label: "Add policy…", onSelect: () => setEditTab("policy") }]),
      {
        id: "delete",
        label: "Delete column",
        danger: true,
        separatorBefore: true,
        onSelect: () => onRequestDelete(column),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startRenaming/setEditTab/onRequestDelete's closures are stable; only the fields read by the memoized items are listed
    [column.id, column.name, onRequestDelete, hasPolicy],
  );

  // Hidden by view prefs — render a narrow stub matching hidden cell width
  if (hidden) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="w-10 shrink-0 border-r border-line bg-surface/50"
        data-no-pan
        {...attributes}
        {...listeners}
      />
    );
  }

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`w-10 shrink-0 flex flex-col items-center py-3 gap-2 border-r border-line bg-surface cursor-pointer hover:bg-surface-hover transition overflow-hidden focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${accentClass}`}
        data-no-pan
        tabIndex={0}
        role="button"
        onClick={(e) => {
          // The color-dot drag handle must not expand the column when a click lands on it.
          if ((e.target as HTMLElement).closest("[data-column-drag-handle]")) return;
          onToggleCollapse();
        }}
        onKeyDown={(e) => {
          // Keydowns bubbling from the focusable drag-handle dot belong to the sortable sensor.
          if ((e.target as HTMLElement).closest("[data-column-drag-handle]")) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleCollapse(); }
        }}
        title={
          overWip
            ? `Expand "${column.name}" · Over WIP limit (${cardCount}/${column.wip_limit})`
            : overWeight
            ? `Expand "${column.name}" · Over weight limit (${totalWeight}/${column.weight_limit})`
            : `Expand "${column.name}"`
        }
      >
        {/* Color dot is the drag handle — same pattern as expanded header */}
        <span
          className={`color-dot w-2.5 h-2.5 rounded-full shrink-0 ${isAdmin ? "cursor-grab active:cursor-grabbing" : ""}`}
          style={{ backgroundColor: column.color }}
          title={isAdmin ? "Drag to reorder" : undefined}
          data-column-drag-handle
          {...(isAdmin ? { ...attributes, ...listeners } : {})}
        />
        <span
          className={`text-xs font-medium px-1 py-0.5 rounded-full ${
            overWip
              ? "text-warning-on-tint font-semibold"
              : overWeight
              ? "text-warning-on-tint font-semibold"
              : "bg-surface-hover text-fg-secondary"
          }`}
        >
          {cardCount}
        </span>
        {(overWip || overWeight) && (
          <span aria-hidden="true" className="text-xs leading-none text-warning-on-tint">⚠</span>
        )}
        <span
          className="text-xs font-bold text-fg-tertiary tracking-widest flex-1 flex items-center"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          title={column.name}
        >
          {abbreviation ?? column.name.slice(0, 3).toUpperCase()}
        </span>
        <span className="text-fg-muted text-xs">▶</span>
      </div>
    );
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ ...style, ...columnTintStyle(column.color), width: width ?? 220 }}
        // A tinted panel (#2270): bg-surface / border-line are the fallback when the color is not a hex.
        className="relative shrink-0 self-start box-border px-2.5 py-2 bg-surface border border-line rounded-lg group/col transition"
        data-no-pan
        onDoubleClick={isAdmin ? () => setEditTab("settings") : undefined}
      >
        {/* Row 1: collapse toggle, color dot, name, policy, add card, kebab */}
        <div className="flex items-start gap-2">
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            className="text-fg-tertiary hover:text-fg-secondary transition text-xs shrink-0 mt-0.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
            title="Collapse column"
            aria-label="Collapse column"
          >
            ◀
          </button>
          <span
            className={`color-dot w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${isAdmin ? "cursor-grab active:cursor-grabbing" : ""}`}
            style={{ backgroundColor: column.color }}
            title={isAdmin ? "Drag to reorder" : undefined}
            {...(isAdmin ? { ...attributes, ...listeners } : {})}
          />
          {renaming ? (
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e)) { e.preventDefault(); void commitRename(true); } // commitRename manages its own error state (renameError) and never rejects
              }}
              onBlur={() => void commitRename()}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 text-[13px] font-semibold bg-sunken text-fg border border-primary-emphasis rounded px-1 py-0 outline-none"
            />
          ) : (
            isAdmin ? (
              // A real button so keyboard users can reach inline rename with Tab + Enter/Space (#1376).
              <button
                type="button"
                ref={renameTriggerRef}
                className="flex-1 font-semibold text-fg text-[13px] leading-snug break-words min-w-0 text-left cursor-text hover:text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                title="Click to rename"
                onClick={(e) => { e.stopPropagation(); startRenaming(); }}
              >
                {column.name}
              </button>
            ) : (
              <span className="flex-1 min-w-0 font-semibold text-fg text-[13px] leading-snug break-words">
                {column.name}
              </span>
            )
          )}
          {/* Policy affordance (#1101). Visible at rest whenever the column has
              a policy, a recorded exception to hover-reveal (frontend/CLAUDE.md
              § Column headers): the policy is information for every reader,
              not an action. Icon only below lg, same accessible name. */}
          {policy && (
            <button
              ref={policyTriggerRef}
              type="button"
              aria-label={`Column policy for ${column.name}: ${policyCountSummary(policy)}`}
              aria-haspopup="dialog"
              aria-expanded={policyRect !== null}
              title="Column policy"
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setPolicyRect((prev) => (prev ? null : rect));
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                policyRect ? "text-info bg-info/10" : "text-fg-tertiary hover:text-fg-secondary hover:bg-surface-hover"
              }`}
            >
              <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="2.5" width="10" height="12" rx="1.5" />
                <path d="M6 2.5V1.75h4v.75M5.75 7h4.5M5.75 9.5h4.5M5.75 12h2.5" />
              </svg>
              <span className="hidden lg:inline">Policy</span>
            </button>
          )}
          {/* Column overflow kebab — discoverable surface for Rename, Edit settings,
              and Delete. Replaces the prior `✎` icon button (per #965): the kebab is
              the keyboard-reachable, name-typed-confirm path, while column drag-to-
              trash now requires holding ⌥. Non-admins get no affordance at all per
              the conditional-admin-only-elements rule — never a greyed-out control. */}
          {onAddCard && (
            <button
              type="button"
              aria-label={`Add card to ${column.name}`}
              title="Add card"
              data-testid="column-add-card"
              onClick={(e) => { e.stopPropagation(); onAddCard(); }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          )}
          {isAdmin && (
            <div className="opacity-0 group-hover/col:opacity-100 focus-within:opacity-100 transition">
              <OverflowMenu items={kebabItems} ariaLabel={`Actions for column "${column.name}"`} />
            </div>
          )}
        </div>

        {renameError && (
          <p className="mt-1 pl-[26px] text-xs text-danger" role="alert">{renameError}</p>
        )}

        {/* Meter (#2270): 3px, only when the column has a WIP limit. Column color while at or
            under the limit, warning when over. role="meter" so the proportion is not color-only. */}
        {hasLimit && (
          <div
            role="meter"
            aria-label={`WIP in ${column.name}`}
            aria-valuemin={0}
            aria-valuemax={column.wip_limit!}
            aria-valuenow={Math.min(cardCount, column.wip_limit!)}
            aria-valuetext={`${cardCount} of ${column.wip_limit}`}
            data-testid="column-meter"
            className="mt-2 h-[3px] rounded-full bg-surface-active overflow-hidden"
          >
            <div
              data-testid="column-meter-fill"
              className={`h-full rounded-full ${overWip ? "bg-warning" : ""}`}
              style={{ width: `${meterPct}%`, ...(overWip ? {} : { backgroundColor: column.color }) }}
            />
          </div>
        )}

        {/* Count line. No limit: "2 cards". Limit: "2 / 4", and "8 / 6 over" in warning text
            when over. The word "over" (and the hard-limit glyph) keep it from being color-only. */}
        <div className={`${hasLimit ? "mt-1.5" : "mt-1"} pl-[26px] text-xs tabular-nums text-fg-secondary`}>
          {overWip ? (
            <span
              data-testid="column-count"
              className="font-semibold text-warning-on-tint"
              title={hardWipEnforced ? "WIP hard limit — no override possible" : "Over WIP limit"}
            >
              {hardWipEnforced && <span aria-hidden="true">⛔ </span>}
              {cardCount} / {column.wip_limit} over
            </span>
          ) : hasLimit ? (
            <span
              data-testid="column-count"
              title={cardCount === column.wip_limit ? `Column is at its WIP limit (${cardCount}/${column.wip_limit})` : "Cards in column"}
            >
              {cardCount} / {column.wip_limit}
            </span>
          ) : (
            <span data-testid="column-count" title="Cards in column">{cardCountLabel}</span>
          )}
          {overWeight && (
            <span className="ml-2 font-semibold text-warning-on-tint" title="Over weight budget">
              Weight {totalWeight}/{column.weight_limit}
            </span>
          )}
        </div>
      </div>

      {policy && policyRect && (
        <ColumnPolicyPopover
          columnName={column.name}
          policy={policy}
          anchorRect={policyRect}
          triggerRef={policyTriggerRef}
          onDismiss={closePolicy}
          // The popover unmounts as the modal opens, so focus moves to the
          // Policy button first: the modal's focus trap restores to its opener
          // on close, and a removed opener would leave focus on the body.
          onEdit={isAdmin ? () => { policyTriggerRef.current?.focus(); setEditTab("policy"); } : undefined}
        />
      )}

      {isAdmin && editTab && (
        <EditColumnModal
          boardId={boardId}
          column={column}
          cardCount={cardCount}
          initialTab={editTab === "policy" ? "policy" : undefined}
          boardColors={boardColors}
          isIntakeColumn={isIntakeColumn}
          onUpdated={(col) => { onColumnUpdated(col); setEditTab(null); }}
          onRequestDelete={onRequestDelete}
          onClose={() => setEditTab(null)}
        />
      )}
    </>
  );
}
