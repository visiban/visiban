import { useState, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column, Swimlane } from "../../types";
import { updateSwimlane } from "../../api/boards";
import BoardCell from "./BoardCell";
import EditSwimlaneModal from "./EditSwimlaneModal";

interface Props {
  swimlane: Swimlane;
  columns: Column[];
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  canEdit: boolean;
  closeEditorOnEnter: boolean;
  collapsedColumnIds: Set<number>;
  hiddenColumnIds?: Set<number>;
  filteredCardIds: Set<number> | null;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onSwimlaneDeleted: (swimlaneId: number) => void;
  /** Controlled collapsed state — driven by useViewPrefs.collapsedSwimlaneIds. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onFocus: (id: number) => void;
  /** Called when the user exits focus mode via the crosshair toggle. */
  onExitFocus: () => void;
  /** True when this swimlane is currently the active focus target. */
  isFocused: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  sidebarWidth?: number;
  setSidebarWidth?: (w: number) => void;
  onResizeStart?: (e: React.MouseEvent) => void;
  colWidths?: Map<number, number>;
  setColumnWidth?: (colId: number, width: number) => void;
  onInsertColumn?: (colId: number) => void;
  /** Which column separator index (0-based from left) is currently hovered — for full-height highlight. */
  hoveredSepIndex?: number | null;
  onSepHoverChange?: (idx: number | null) => void;
  minHeight?: number;
  setSwimlaneHeight?: (h: number) => void;
  hideLabels?: boolean;
  hideDueDate?: boolean;
  hideAssignee?: boolean;
  hidePriority?: boolean;
  hideLastMoved?: boolean;
  userTimezone?: string;
  userDateFormat?: string;
  compact?: boolean;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
}

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, collapsed, onToggleCollapse, onFocus, onExitFocus, isFocused, onHoverEnter, onHoverLeave, sidebarWidth, setSidebarWidth, colWidths, setColumnWidth, onInsertColumn, hoveredSepIndex, onSepHoverChange, minHeight, setSwimlaneHeight, hideLabels, hideDueDate, hideAssignee, hidePriority, hideLastMoved, userTimezone, userDateFormat, compact, staleness_threshold_days, stale_warning_pct }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const heightResizeState = useRef<{ startY: number; startHeight: number } | null>(null);

  const startRenaming = () => {
    setDraft(swimlane.name);
    setRenaming(true);
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === swimlane.name) return;
    const updated = await updateSwimlane(boardId, swimlane.id, { name: trimmed, color: swimlane.color });
    onSwimlaneUpdated(updated);
  };

  const cancelRename = () => {
    setRenaming(false);
    setDraft("");
  };

  const handleHeightResizeStart = (e: React.MouseEvent) => {
    if (!setSwimlaneHeight) return;
    e.preventDefault();
    e.stopPropagation();
    const startHeight = rowRef.current ? rowRef.current.getBoundingClientRect().height : (minHeight ?? 80);
    heightResizeState.current = { startY: e.clientY, startHeight };
    const onMove = (ev: MouseEvent) => {
      if (!heightResizeState.current) return;
      setSwimlaneHeight(heightResizeState.current.startHeight + (ev.clientY - heightResizeState.current.startY));
    };
    const onUp = () => {
      heightResizeState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `swim:${swimlane.id}`, disabled: !isAdmin });

  return (
    <>
      <div
        ref={(el) => { setNodeRef(el); (rowRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1, minHeight: collapsed ? undefined : (minHeight ?? undefined) }}
        className="relative flex border-b border-line bg-surface"
        onMouseEnter={onHoverEnter}
        onMouseLeave={onHoverLeave}
      >
        {/* Swimlane label — sticky to the left */}
        <div
          className={`shrink-0 flex items-center gap-2 pl-1 pr-3 sticky left-0 z-10 bg-surface border-l-4 hover:bg-surface-hover/30 group relative ${collapsed ? "py-1" : "py-3 items-start"}`}
          style={{ width: sidebarWidth ?? 220, borderLeftColor: swimlane.color || "transparent" }}
          data-tour-step="swimlane"
          data-no-pan
          onDoubleClick={isAdmin ? () => setEditing(true) : undefined}
        >
          {/* Drag handle */}
          {isAdmin && (
            <span
              {...attributes}
              {...listeners}
              className={`text-fg-faint hover:text-fg-secondary cursor-grab active:cursor-grabbing text-sm select-none shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded transition-opacity ${collapsed ? "" : "mt-0.5"}`}
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}

          <div className="flex-1 min-w-0">
            {renaming ? (
              <input
                ref={inputRef}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                className="w-full text-sm bg-sunken text-white border border-blue-500 rounded px-1 py-0 outline-none"
              />
            ) : (
              <p
                className={`text-sm text-fg-secondary truncate ${isAdmin ? "cursor-text hover:text-info" : ""}`}
                title={isAdmin ? "Click to rename" : swimlane.name}
                onClick={isAdmin ? (e) => { e.stopPropagation(); startRenaming(); } : undefined}
              >
                {swimlane.name}
              </p>
            )}
            {!collapsed && isAdmin && swimlane.contact_email && <p className="text-xs text-fg-tertiary truncate">{swimlane.contact_email}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!collapsed && (
              <button
                onClick={() => { if (isAdmin) setEditing(true); }}
                className={`transition text-xs focus-visible:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 rounded ${isAdmin ? "text-fg-tertiary hover:text-white opacity-30 group-hover:opacity-100" : "text-fg-faint opacity-50 cursor-not-allowed"}`}
                title={isAdmin ? "Edit swimlane" : "You need admin access to change board settings"}
                disabled={!isAdmin}
              >
                ✎
              </button>
            )}
            {/* Focus icon — toggles single-swimlane focus mode on/off */}
            <button
              onClick={() => isFocused ? onExitFocus() : onFocus(swimlane.id)}
              className={`opacity-0 group-hover:opacity-100 focus:opacity-100 transition focus:ring-2 focus:ring-blue-500 rounded shrink-0 focus:outline-none ${isFocused ? "!opacity-100 text-info" : "text-fg-tertiary hover:text-white"}`}
              title={isFocused ? "Exit focus" : `Focus on ${swimlane.name}`}
              aria-pressed={isFocused}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="3" />
                <line x1="8" y1="1" x2="8" y2="4" />
                <line x1="8" y1="12" x2="8" y2="15" />
                <line x1="1" y1="8" x2="4" y2="8" />
                <line x1="12" y1="8" x2="15" y2="8" />
              </svg>
            </button>
            <button
              onClick={onToggleCollapse}
              className="text-fg-tertiary hover:text-white transition shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
              aria-pressed={collapsed}
              aria-label={collapsed ? `Expand ${swimlane.name}` : `Collapse ${swimlane.name}`}
              title={collapsed ? `Expand ${swimlane.name}` : `Collapse ${swimlane.name}`}
            >
              <svg
                className={`w-4 h-4 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col, colIdx) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const cellWidth = colWidths?.get(col.id) ?? 220;
          const sepHighlighted = hoveredSepIndex === colIdx;

          // The sep sits to the LEFT of col[colIdx], so it resizes the column to its left:
          //   colIdx === 0  → resize the swimlane sidebar
          //   colIdx  >  0  → resize columns[colIdx - 1]
          // This mirrors the header where ColumnSeparator after col[i] resizes col[i].
          const prevCol = colIdx > 0 ? columns[colIdx - 1] : null;
          const sepStartWidth = prevCol
            ? (colWidths?.get(prevCol.id) ?? 220)
            : (sidebarWidth ?? 220);
          const canResizeSep = prevCol ? !!setColumnWidth : !!setSidebarWidth;

          const handleSepMouseDown = (canResizeSep || onInsertColumn)
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = sepStartWidth;
                let didDrag = false;
                const onMove = (ev: MouseEvent) => {
                  const delta = ev.clientX - startX;
                  if (!didDrag && Math.abs(delta) > 4) didDrag = true;
                  if (didDrag) {
                    if (prevCol && setColumnWidth) setColumnWidth(prevCol.id, startWidth + delta);
                    else if (!prevCol && setSidebarWidth) setSidebarWidth(startWidth + delta);
                  }
                };
                const onUp = () => {
                  if (!didDrag && isAdmin && onInsertColumn) onInsertColumn(col.id);
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }
            : undefined;

          const sep = (
            <div
              key={`sep-${col.id}`}
              className={`relative shrink-0 flex items-stretch select-none ${canResizeSep || onInsertColumn ? "cursor-col-resize" : ""}`}
              style={{ width: 16 }}
              onMouseEnter={() => onSepHoverChange?.(colIdx)}
              onMouseLeave={() => onSepHoverChange?.(null)}
              onMouseDown={handleSepMouseDown}
            >
              <div className={`w-px self-stretch transition-colors ${sepHighlighted ? "bg-info/50" : "bg-surface-active/70"}`} />
              <div className={`flex-1 transition-colors ${sepHighlighted ? "bg-info/5" : "bg-sunken/70"}`} />
              <div className={`w-px self-stretch transition-colors ${sepHighlighted ? "bg-info/50" : "bg-surface-active/70"}`} />
              {isAdmin && onInsertColumn && sepHighlighted && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-info text-[10px] font-bold leading-none bg-sunken px-0.5 rounded-sm">+</span>
                </div>
              )}
            </div>
          );

          // Hidden by view prefs — show a narrow placeholder to preserve grid alignment
          if (hiddenColumnIds?.has(col.id)) {
            return (
              <div key={col.id} className="contents">
                {sep}
                <div className="w-10 shrink-0 flex items-center justify-center py-1">
                  {cellCount > 0 && (
                    <span className="text-xs text-fg-faint font-medium">{cellCount}</span>
                  )}
                </div>
              </div>
            );
          }

          if (collapsedColumnIds.has(col.id)) {
            // Collapsed column: show per-swimlane card count; pulse if filter matches are hidden here
            const matchCount = filteredCardIds
              ? cellCards.filter((c) => filteredCardIds.has(c.id)).length
              : 0;
            const hasMatch = matchCount > 0;
            return (
              <div key={col.id} className="contents">
                {sep}
                <div className={`w-10 shrink-0 flex items-center justify-center py-1${hasMatch ? " animate-pulse bg-info/15" : ""}`}>
                  {(hasMatch ? matchCount : cellCount) > 0 && (
                    <span className={`text-xs font-medium ${hasMatch ? "text-info" : "text-fg-tertiary"}`}>
                      {hasMatch ? matchCount : cellCount}
                    </span>
                  )}
                </div>
              </div>
            );
          }

          if (collapsed) {
            // Swimlane collapsed — full-width cell showing card count as a pill badge
            const matchCount = filteredCardIds
              ? cellCards.filter((c) => filteredCardIds.has(c.id)).length
              : 0;
            const hasMatch = matchCount > 0;
            const displayCount = hasMatch ? matchCount : cellCount;
            return (
              <div key={col.id} className="contents">
                {sep}
                <div
                  className={`shrink-0 flex items-center justify-center bg-canvas${hasMatch ? " animate-pulse" : ""}`}
                  style={{ width: cellWidth }}
                >
                  {displayCount > 0 ? (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${hasMatch ? "bg-info/20 text-info" : "bg-surface text-fg-tertiary"}`}>
                      {displayCount}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          }

          return (
            <div key={col.id} className="contents">
              {sep}
              <BoardCell
                column={col}
                swimlane={swimlane}
                cards={cellCards.sort((a, b) => a.position - b.position)}
                boardId={boardId}
                canEdit={canEdit}
                closeEditorOnEnter={closeEditorOnEnter}
                filteredCardIds={filteredCardIds}
                selectedCardIds={selectedCardIds}
                highlightedCardId={highlightedCardId}
                onToggleCardSelection={onToggleCardSelection}
                onCardClick={onCardClick}
                onCardAdded={onCardAdded}
                hideLabels={hideLabels}
                hideDueDate={hideDueDate}
                hideAssignee={hideAssignee}
                hidePriority={hidePriority}
                hideLastMoved={hideLastMoved}
                userTimezone={userTimezone}
                userDateFormat={userDateFormat}
                compact={compact}
                staleness_threshold_days={staleness_threshold_days}
                stale_warning_pct={stale_warning_pct}
                width={cellWidth}
              />
            </div>
          );
        })}
        {/* Trailing separator to match header's trailing ColumnSeparator */}
        <div className="shrink-0 flex items-stretch" style={{ width: 16 }}>
          <div className="w-px self-stretch bg-surface-active/70" />
          <div className="flex-1 bg-sunken/70" />
          <div className="w-px self-stretch bg-surface-active/70" />
        </div>
        {/* Bottom resize handle — drag to set row min-height */}
        {setSwimlaneHeight && (
          <div
            className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-info/20 transition-colors group/resize"
            onMouseDown={handleHeightResizeStart}
          >
            <div className="absolute bottom-0 left-0 right-0 h-px bg-info/0 group-hover/resize:bg-info/40 transition-colors" />
          </div>
        )}
      </div>

      {isAdmin && editing && (
        <EditSwimlaneModal
          boardId={boardId}
          swimlane={swimlane}
          cardCount={cards.length}
          onUpdated={(s) => { onSwimlaneUpdated(s); setEditing(false); }}
          onDeleted={(id) => { onSwimlaneDeleted(id); setEditing(false); }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
