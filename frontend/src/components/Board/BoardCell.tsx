import { useState, useCallback, useEffect, useRef, memo } from "react";
import { useInlineEditEscape } from "../../hooks/useInlineEditEscape";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, rectSortingStrategy } from "@dnd-kit/sortable";
import type { Card, CardDensity, Column, CustomFieldDefinition, Swimlane } from "../../types";
import CardItem from "../Card/CardItem";
import { createCard } from "../../api/cards";
import { limitBlockedMessage } from "./moveBlockedMessages";
import GridOverlayLayer from "./GridOverlay/GridOverlayLayer";
import type { GridOverlayCellState } from "../../gridOverlays/slot";
import { trippedLimitLabel, type TrippedLimit } from "../../utils/placementLimits";
import type { CardMenuAnchor } from "../Card/CardContextMenu";
import { isImeComposing } from "../../utils/imeComposition";
import { ADD_CARD_EVENT } from "../../utils/addCardEvent";

interface Props {
  column: Column;
  swimlane: Swimlane;
  cards: Card[];
  boardId: number;
  canEdit: boolean;
  closeEditorOnEnter: boolean;
  filteredCardIds: Set<number> | null;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  /** The card open in the card detail sheet, if any (#1914). */
  currentCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  density?: CardDensity;
  userTimezone?: string;
  /** #445: the viewer, for the checklist mine suffix on the card face. */
  currentUserId?: number;
  userDateFormat?: string;
  width?: number;
  compact?: boolean;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
  customFieldDefinitions?: CustomFieldDefinition[];
  onCardUpdated?: (card: Card) => void;
  /**
   * This cell's grid-overlay shading (#1147), or undefined/null when no overlay is
   * active or this cell has no value. Optional so every existing call site — and the
   * component's own tests — keep working untouched, which is also what makes the
   * default "None" overlay provably identical to the pre-#1147 board.
   */
  overlayCell?: GridOverlayCellState | null;
  /** The active overlay's label, for the cell's screen-reader text. */
  overlayLabel?: string;
  /**
   * The limits dropping card `cardId` here would trip, strictest first
   * (#1150). Called only while a card drag is over this cell.
   */
  getDropVerdict?: (cardId: number, column: Column, swimlane: Swimlane) => TrippedLimit[];
  /** Entry criteria a dragged card would meet in this column (#1101); empty for none. */
  getEntryCriteria?: (cardId: number, column: Column) => string[];
  /** Opens the card context menu (#2059); passed through to every CardItem. */
  onOpenCardMenu?: (card: Card, anchor: CardMenuAnchor) => void;
  /** The card the context menu targets alone (outside the selection), for its transient outline. */
  contextTargetCardId?: number | null;
}

const BoardCell = memo(function BoardCell({ column, swimlane, cards, boardId, canEdit, closeEditorOnEnter, filteredCardIds, selectedCardIds, highlightedCardId, currentCardId, onToggleCardSelection, onCardClick, onCardAdded, density, userTimezone, currentUserId, userDateFormat, width, compact, staleness_threshold_days, stale_warning_pct, customFieldDefinitions, onCardUpdated, overlayCell, overlayLabel, getDropVerdict, getEntryCriteria, onOpenCardMenu, contextTargetCardId }: Props) {
  const id = `cell:${column.id}:${swimlane.id}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const { active } = useDndContext();
  const isDraggingCard = active != null && !String(active.id).startsWith("swim:") && !String(active.id).startsWith("col:");
  // Drop verdict (#1150): the strictest limit this drop would trip, if any.
  // The ring and the label below predict the server's answer; the server
  // still decides, and its refusal still raises MoveBlockedToast.
  const blockedBy = isOver && isDraggingCard && getDropVerdict
    ? getDropVerdict(Number(active?.id), column, swimlane)[0] ?? null
    : null;
  // Entry criteria (#1101): the drop message lists them while a card from
  // another column is over this one. A limit block wins: a blocked cell shows
  // only its verdict, since the move will be refused before anyone checks them.
  const entryCriteria = isOver && isDraggingCard && !blockedBy && getEntryCriteria
    ? getEntryCriteria(Number(active?.id), column)
    : [];
  const [adding, setAdding] = useState(false);
  // Every exit of the add-card input (Escape, Cancel, commit) returns focus to the control that
  // opened it (#2087): the cell itself when empty, the "+ Add card" button when populated.
  const cellRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const focusTriggerRef = useRef(false);
  useEffect(() => {
    if (!adding && focusTriggerRef.current) {
      focusTriggerRef.current = false;
      (addButtonRef.current ?? cellRef.current)?.focus();
    }
  }, [adding]);
  // The card currently expanded over this cell, if any (see the CardItem
  // dimming note in the render below).
  const [expandedCardId, setExpandedCardId] = useState<number | null>(null);
  const handleExpandChange = useCallback((cardId: number, expanded: boolean) => {
    setExpandedCardId((prev) => (expanded ? cardId : prev === cardId ? null : prev));
  }, []);
  const [title, setTitle] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!title.trim()) return;
    setAddError(null);
    try {
      const card = await createCard(boardId, { column: column.id, swimlane: swimlane.id, title: title.trim() });
      onCardAdded(card);
      setTitle("");
      focusTriggerRef.current = true;
      setAdding(false);
    } catch (err) {
      // A WIP/weight-limit 409 (#1428) names the column and the numbers;
      // every other failure keeps the generic text.
      setAddError(limitBlockedMessage(err) ?? "Failed to add card.");
    }
  };

  // The cell becomes the keyboard-reachable creation surface when it has nothing
  // in it (#962). Tab → empty cell → Enter / Space opens the new-card input. The
  // dashed border + centered "+ Add card" overlay gives Sam a discoverable click
  // target on day one. Populated cells keep the dense layout, but their "+ Add card"
  // button grows to fill the cell's remaining height (#2319), so blank well space below the
  // cards behaves like an empty cell: dashed edge and "Add card" label on hover, click adds.
  const isEmptyAddable = cards.length === 0 && !adding && column.allow_card_creation && canEdit;
  const isPopulatedAddable = cards.length > 0 && !adding && column.allow_card_creation && canEdit;
  const startAdding = () => setAdding(true);
  const canAdd = column.allow_card_creation && canEdit;
  useEffect(() => {
    const el = cellRef.current;
    if (!el || !canAdd) return;
    const open = () => setAdding(true);
    el.addEventListener(ADD_CARD_EVENT, open);
    return () => el.removeEventListener(ADD_CARD_EVENT, open);
  }, [canAdd]);

  // Escape cancels the add-card input through the stack so it does not also clear the selection (#1860).
  // Several cells can have the input open at once (it has no onBlur close), so the predicate is
  // scoped to focus inside this cell's editor; otherwise the first-registered cell would close.
  const addEditorRef = useRef<HTMLDivElement>(null);
  const cancelAdd = () => { focusTriggerRef.current = true; setAdding(false); setAddError(null); };
  useInlineEditEscape(() => adding && !!addEditorRef.current?.contains(document.activeElement), cancelAdd);

  // Grid overlay (#1147). Suppressed on the cell being dragged over: drop feedback
  // already owns the cell's background channel (`bg-primary/20`, or `bg-warning/20`
  // for a blocked drop, #2326), and compositing a tint on top weakens it — the same
  // reason the centered "+ Add card" overlay hides during a drag.
  const overlay = overlayCell && overlayLabel && !(isOver && isDraggingCard) ? overlayCell : null;
  // An empty addable cell is `role="button"` with an `aria-label`, and an aria-label
  // overrides *all* descendant text — so an sr-only reading inside it is silently
  // discarded. Fold the overlay reading into the cell's own label instead.
  const addLabel = `Add card to ${column.name} in ${swimlane.name}`;
  const cellAriaLabel = overlay ? `${addLabel} — ${overlayLabel}: ${overlay.label}, ${overlay.encoding.levelLabel}` : addLabel;
  // Drop feedback (#2326, spec § Drag and drop): an open target takes the selection
  // treatment (dashed `border-info`, `bg-primary/20`) plus a placeholder where the card
  // lands; a blocked one takes the warning treatment and names the limit in text.
  const dropOpen = isOver && isDraggingCard && !blockedBy;
  // The placeholder is as tall as the lifted card, so the cell shows the space it needs.
  const placeholderHeight = Math.max(40, Math.round(active?.rect?.current?.initial?.height ?? 40));

  return (
    <div
      ref={(el) => { cellRef.current = el; setNodeRef(el); }}
      // The card detail sheet anchors to this cell's column edges (#1914).
      data-board-cell
      data-column-id={column.id}
      data-swimlane-id={swimlane.id}
      role={isEmptyAddable ? "button" : undefined}
      tabIndex={isEmptyAddable ? 0 : undefined}
      aria-label={isEmptyAddable ? cellAriaLabel : undefined}
      onClick={isEmptyAddable ? startAdding : undefined}
      onKeyDown={isEmptyAddable ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          startAdding();
        }
      } : undefined}
      // Double-click and right-click open the new-card input on any cell — empty
      // or populated. They're the long-standing power-user shortcuts; the cell-
      // as-button (#962) only adds the *empty-cell* keyboard path on top.
      onDoubleClick={() => { if (column.allow_card_creation && canEdit) setAdding(true); }}
      // A touch long-press fires `contextmenu` too, and that same long-press is
      // what starts a touch drag (#1287). While any drag is active, swallow it so
      // the new-card input doesn't open (and the native menu doesn't show) mid-drag.
      onContextMenu={(e) => {
        if (active != null) { e.preventDefault(); return; }
        // A right-click on a card belongs to the card's context menu (#2059);
        // only empty cell space keeps the add-card shortcut.
        if ((e.target as Element).closest?.("[data-card-id]")) return;
        if (column.allow_card_creation && canEdit) { e.preventDefault(); setAdding(true); }
      }}
      // Sized by the board's shared grid track (#2300); `width` only for isolated renders.
      style={width != null ? { width } : undefined}
      // A well (#2270): the deepest surface, 8px radius, 6px padding (5px + the 1px edge that
      // the dashed hover border reuses, so content never shifts); 56px tall when empty and
      // otherwise as tall as its cards. The empty cell shows a quiet plus and gains a dashed
      // edge and the "Add card" label on hover or focus.
      className={`group/cell relative min-w-0 min-h-14 p-[5px] rounded-lg border transition-colors ${
        blockedBy ? "bg-warning/20 border-dashed border-warning"
          : dropOpen ? "bg-primary/20 border-dashed border-info"
          : "bg-canvas border-transparent"
      } ${isPopulatedAddable ? "flex flex-col" : ""
      } ${
        isEmptyAddable ? "cursor-pointer hover:border-dashed hover:border-line-strong focus:border-dashed focus:border-line-strong hover:bg-surface-active/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis" : ""
      }`}
    >
      {/* Grid overlay shading (#1147) — FIRST child on purpose: it is absolutely
          positioned, so everything below it in this subtree paints on top of the tint
          and stays legible. See GridOverlayLayer for the full ordering rationale. */}
      {overlay && overlayLabel && (
        <GridOverlayLayer
          overlayLabel={overlayLabel}
          cell={overlay}
          valueAnnouncedByCell={isEmptyAddable}
        />
      )}
      {/* Blocked drop target (#1150, warning treatment #2326): the tint is color
          only, so the limit is also written out (WCAG 1.4.1). aria-hidden: keyboard
          and screen-reader users get the same verdict from the drag live region. */}
      {blockedBy && (
        <span
          aria-hidden="true"
          data-testid="cell-drop-blocked"
          // An opaque pill: the label sits over the first card or the empty
          // drop target, so it needs its own surface to stay legible.
          className="absolute left-2 top-1 z-[6] max-w-[calc(100%-1rem)] truncate rounded bg-canvas px-1.5 py-0.5 shadow text-xs font-medium text-warning-on-tint pointer-events-none"
        >
          {blockedBy.mode === "hard" ? "⛔ " : "⚠ "}{trippedLimitLabel(blockedBy)}
        </span>
      )}
      {/* Entry criteria drop message (#1101). aria-hidden for the same reason
          as the blocked label above: the drag live region reads the criteria
          aloud. Truncates to one line; the full list is in the Policy popover. */}
      {entryCriteria.length > 0 && (
        <span
          aria-hidden="true"
          data-testid="cell-drop-entry-criteria"
          title={entryCriteria.join(" · ")}
          className="absolute left-2 top-1 z-[6] max-w-[calc(100%-1rem)] truncate rounded bg-canvas px-1.5 py-0.5 shadow text-xs font-medium text-fg-secondary pointer-events-none"
        >
          Entry: {entryCriteria.join(" · ")}
        </span>
      )}
      {/* One scalar per corner: the built-in count stands down while an overlay owns
          the top-right slot, so the cell never shows two different numbers there. */}
      {!overlay && !blockedBy && entryCriteria.length === 0 && cards.length >= 2 && (
        // z-[5]: CardItem's root is `relative z-0`, so a z-auto badge paints under the
        // first card (#1162). Same value and reasoning as the overlay badge; see
        // frontend/CLAUDE.md (grid overlay stacking).
        <span data-testid="cell-card-count" className="absolute top-1.5 right-2 z-[5] text-xs font-medium text-fg-muted select-none pointer-events-none">
          {cards.length}
        </span>
      )}
      <SortableContext items={cards.map((c) => c.id)} strategy={compact ? rectSortingStrategy : verticalListSortingStrategy}>
        {/* While one card is expanded over the cell (hover or focus in its
            metadata row), every other card in the cell is dimmed to near-
            invisible, so the expanded card reads as the cell's only content.
            The id is compared on the way out so a stale "ended" report from a
            card that just lost the expansion to its neighbor cannot clear the
            neighbor's. */}
        {/* `relative` so the card stack paints above the overlay tint layer, which is
            absolutely positioned and would otherwise cover in-flow siblings. */}
        <div className={`relative ${compact ? "grid grid-cols-2 gap-1.5" : "flex flex-col gap-1.5"}`}>
          {(filteredCardIds ? cards.filter((c) => filteredCardIds.has(c.id)) : cards).map((card) => (
            <CardItem
              key={card.id}
              card={card}
              onClick={() => onCardClick(card)}
              selected={selectedCardIds.has(card.id)}
              highlighted={highlightedCardId === card.id}
              current={currentCardId === card.id}
              // Hover peeks stand down while the card detail sheet is open (#1918).
              peekSuppressed={currentCardId != null}
              // No selection checkbox while the card detail sheet is open
              // (#1914): it would take focus out of the aria-modal sheet and
              // raise the bulk toolbar behind it. A click there swaps cards.
              onSelect={canEdit && currentCardId == null ? () => onToggleCardSelection(card.id) : undefined}
              density={density}
              userTimezone={userTimezone}
              currentUserId={currentUserId}
              userDateFormat={userDateFormat}
              compact={compact}
              staleness_threshold_days={staleness_threshold_days}
              stale_warning_pct={stale_warning_pct}
              inDoneColumn={column.is_done}
              customFieldDefinitions={customFieldDefinitions}
              boardId={boardId}
              dimmed={expandedCardId !== null && expandedCardId !== card.id}
              onExpandChange={handleExpandChange}
              onCardUpdated={canEdit ? onCardUpdated : undefined}
              onOpenMenu={onOpenCardMenu}
              contextTarget={contextTargetCardId === card.id}
            />
          ))}
          {/* Drop placeholder (#2326): where the card lands. A drop always appends
              (handleDragEnd sends the cell's count), so it sits after the last card. */}
          {dropOpen && cards.length > 0 && (
            <div
              aria-hidden="true"
              data-testid="cell-drop-placeholder"
              style={{ height: placeholderHeight }}
              className="rounded-md border border-dashed border-info bg-primary/40"
            />
          )}
        </div>
        {cards.length === 0 && active && (
          // An empty cell's slot doubles as the placeholder while it is the open target.
          <div
            aria-hidden="true"
            data-testid={dropOpen ? "cell-drop-placeholder" : undefined}
            className={`h-10 rounded-md border border-dashed transition-colors ${
              blockedBy ? "border-warning" : dropOpen ? "border-info bg-primary/40" : "border-line-strong"
            }`}
          />
        )}
      </SortableContext>

      {column.allow_card_creation && canEdit && adding && (
        <div ref={addEditorRef} className="relative mt-1.5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e) && !e.shiftKey) {
                if (closeEditorOnEnter) { e.preventDefault(); void handleAdd(); } // handleAdd manages its own error state (addError) and never rejects
                // else: fall through so the browser inserts a newline (default textarea behavior)
              }
            }}
            placeholder="Card title…"
            className="w-full text-xs border border-primary-emphasis rounded px-2 py-1.5 outline-none bg-surface text-fg placeholder-fg-muted"
          />
          <div className="flex gap-1.5 mt-1.5">
            <button onClick={handleAdd} className="text-xs bg-button-primary text-on-primary px-2.5 py-1 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Add</button>
            <button onClick={cancelAdd} className="text-xs text-fg-tertiary hover:text-fg-secondary transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
          </div>
          <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true"><span className="text-danger">{addError}</span></p>
        </div>
      )}

      {/* Empty-cell centered affordance — overlay-positioned and decorative; the
          cell wrapper itself is the focusable role="button" surface. Hidden during
          a card drag so the drop indicator owns the visual frame. */}
      {isEmptyAddable && !active && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs text-fg-muted group-hover/cell:text-fg group-focus/cell:text-fg transition"
          aria-hidden="true"
          data-testid="empty-cell-add-affordance"
        >
          {/* Inner pill gains a soft wash on hover/focus (#200) so the affordance reads as a
              button without ever being a second tab stop; the cell wrapper owns the action. */}
          <span className="inline-flex items-center rounded px-2 py-1 transition-colors">
            <span className="text-base leading-none">+</span>
            <span className="hidden group-hover/cell:inline group-focus/cell:inline ml-1.5">Add card</span>
          </span>
        </div>
      )}

      {/* Populated-cell affordance (#2319) — a real button that fills the cell's remaining
          height (the swimlane row stretches cells to the tallest neighbor), so the blank space
          below the cards offers the same dashed hover edge and "+ Add card" label as an empty
          cell. Still ONE tab stop, named like the empty cell (#2320). At least 44px tall so it
          stays a touch target when cards fill the cell. During a drag it stays in layout but is
          transparent and inert so the drop indicator owns the cell; opacity, not `invisible`,
          because a hidden element drops keyboard focus and the focus would not come back (#2320). */}
      {isPopulatedAddable && (
        <button
          ref={addButtonRef}
          type="button"
          aria-label={addLabel}
          onClick={() => setAdding(true)}
          // On an overlay tint fg-faint sinks out of sight, and this button sits on the
          // tint rather than on a card (#459). fg-secondary keeps at least 6:1 at /40.
          // The wash is `surface-active/50`: `surface-hover` equals `canvas` in light mode, so
          // the old wash was invisible there (#2320).
          className={`group/addbtn flex-1 min-h-11 mt-1 w-full flex items-center justify-center text-xs rounded border border-transparent transition ${overlay && overlay.encoding.level > 0 ? "text-fg-secondary" : "text-fg-muted"} hover:text-fg hover:border-dashed hover:border-line-strong hover:bg-surface-active/50 focus:text-fg focus:border-dashed focus:border-line-strong focus:bg-surface-active/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${active ? "opacity-0 pointer-events-none" : ""}`}
        >
          <span aria-hidden="true" className="text-base leading-none">+</span>
          <span aria-hidden="true" className="hidden group-hover/addbtn:inline group-focus/addbtn:inline ml-1.5">Add card</span>
        </button>
      )}
    </div>
  );
});

export default BoardCell;
