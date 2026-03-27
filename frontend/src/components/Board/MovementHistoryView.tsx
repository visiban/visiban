import { useCallback, useEffect, useRef, useState } from "react";
import { getBoardMovements } from "../../api/boards";
import type { BoardFull, CardMovement } from "../../types";
import { userDisplayName } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryFilters {
  swimlaneId: number | null;
  columnId: number | null;
  userId: number | null;
  since: string;
  until: string;
}

const EMPTY_FILTERS: HistoryFilters = {
  swimlaneId: null,
  columnId: null,
  userId: null,
  since: "",
  until: "",
};

function filtersToParams(f: HistoryFilters, page: number): Record<string, string> {
  const p: Record<string, string> = { page: String(page) };
  if (f.swimlaneId !== null) p.swimlane_id = String(f.swimlaneId);
  if (f.columnId !== null) p.column_id = String(f.columnId);
  if (f.userId !== null) p.user_id = String(f.userId);
  if (f.since) p.since = f.since;
  if (f.until) p.until = f.until;
  return p;
}

function hasFilters(f: HistoryFilters): boolean {
  return (
    f.swimlaneId !== null ||
    f.columnId !== null ||
    f.userId !== null ||
    f.since !== "" ||
    f.until !== ""
  );
}

// ---------------------------------------------------------------------------
// Slide-in detail panel
// ---------------------------------------------------------------------------

interface SlideInPanelProps {
  movement: CardMovement;
  /** All movements for the same card visible on the current page — for context. */
  relatedMovements: CardMovement[];
  onClose: () => void;
}

function SlideInPanel({ movement, relatedMovements, onClose }: SlideInPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on open so keyboard users can immediately dismiss.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const formatTs = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  return (
    <div
      className="w-80 shrink-0 bg-slate-800 border-l border-slate-700 flex flex-col overflow-hidden"
      role="complementary"
      aria-label="Movement detail"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-slate-700">
        <h2 className="text-sm font-medium text-slate-200 pr-2 leading-snug line-clamp-2">
          {movement.card_title}
        </h2>
        <button
          ref={closeRef}
          onClick={onClose}
          className="text-slate-400 hover:text-white hover:bg-slate-700 rounded p-0.5 shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Close panel"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Selected movement */}
      <div className="px-4 py-3 border-b border-slate-700 space-y-1.5">
        <p className="text-xs text-slate-500 uppercase tracking-wide font-medium">This movement</p>
        <p className="text-xs text-slate-300">
          <span className="text-slate-500">When </span>
          {formatTs(movement.moved_at)}
        </p>
        <p className="text-xs text-slate-300">
          <span className="text-slate-500">By </span>
          {movement.moved_by ? userDisplayName(movement.moved_by) : <span className="text-slate-600 italic">Unknown</span>}
        </p>
        <div className="text-xs text-slate-300 space-y-0.5">
          <p>
            <span className="text-slate-500">From </span>
            <span className="text-slate-200">{movement.from_column_name ?? "—"}</span>
            {movement.from_swimlane_name && (
              <span className="text-slate-500"> · {movement.from_swimlane_name}</span>
            )}
          </p>
          <p>
            <span className="text-slate-500">To </span>
            <span className="text-slate-200">{movement.to_column_name ?? "—"}</span>
            {movement.to_swimlane_name && (
              <span className="text-slate-500"> · {movement.to_swimlane_name}</span>
            )}
          </p>
        </div>
        {movement.notes && (
          <p className="text-xs text-slate-400 italic mt-1">{movement.notes}</p>
        )}
      </div>

      {/* Other movements for the same card on this page */}
      {relatedMovements.length > 1 && (
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-2">
            Other movements on this page
          </p>
          <ol className="space-y-2">
            {relatedMovements
              .filter((m) => m.id !== movement.id)
              .map((m) => (
                <li key={m.id} className="text-xs text-slate-400 space-y-0.5">
                  <p className="text-slate-500 tabular-nums">{formatTs(m.moved_at)}</p>
                  <p>
                    <span className="text-slate-200">{m.to_column_name ?? "—"}</span>
                    {m.to_swimlane_name && (
                      <span className="text-slate-500"> · {m.to_swimlane_name}</span>
                    )}
                  </p>
                </li>
              ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  board: BoardFull;
}

const PAGE_SIZE = 50;

/**
 * Board-level movement history view — filterable, paginated feed of card
 * movements with a slide-in detail panel on row selection.
 *
 * Keyboard navigation:
 *   ArrowDown / ArrowUp — move row focus
 *   Enter               — open slide-in for the focused row
 *   Escape              — close slide-in panel
 */
export default function MovementHistoryView({ board }: Props) {
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ results: CardMovement[]; count: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedMovement, setSelectedMovement] = useState<CardMovement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const totalPages = data ? Math.max(1, Math.ceil(data.count / PAGE_SIZE)) : 1;

  // Fetch on filters or page change; cancel in-flight request on re-render.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    getBoardMovements(board.id, filtersToParams(filters, page))
      .then((d) => { if (!cancelled) { setData(d); setFocusedIndex(null); } })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [board.id, filters, page]);

  // Reset to page 1 and clear selection when filters change.
  const applyFilters = useCallback((next: HistoryFilters) => {
    setFilters(next);
    setPage(1);
    setSelectedMovement(null);
  }, []);

  // Keyboard navigation.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!data?.results.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min((i ?? -1) + 1, data.results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max((i ?? 1) - 1, 0));
      } else if (e.key === "Enter" && focusedIndex !== null) {
        setSelectedMovement(data.results[focusedIndex]);
      } else if (e.key === "Escape" && selectedMovement !== null) {
        setSelectedMovement(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [data, focusedIndex, selectedMovement]);

  // Scroll the focused row into view when focus moves.
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (focusedIndex === null || !tbodyRef.current) return;
    const row = tbodyRef.current.children[focusedIndex] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: "nearest" });
  }, [focusedIndex]);

  // Dropdown options derived from board metadata.
  const swimlaneOptions = board.swimlanes
    .slice().sort((a, b) => a.position - b.position)
    .map((s) => ({ value: s.id, label: s.name }));

  const columnOptions = board.columns
    .slice().sort((a, b) => a.position - b.position)
    .map((c) => ({ value: c.id, label: c.name }));

  const userOptions = board.members.map((m) => ({
    value: m.user.id,
    label: userDisplayName(m.user),
  }));

  // Collect all movements for the selected card on this page (for the panel).
  const relatedMovements = selectedMovement
    ? (data?.results ?? []).filter((m) => m.card_uid === selectedMovement.card_uid)
    : [];

  const startItem = data ? (page - 1) * PAGE_SIZE + 1 : 0;
  const endItem = data ? Math.min(page * PAGE_SIZE, data.count) : 0;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden" data-testid="movement-history-view">
      {/* ── Main panel ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Filter row */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800 flex-wrap shrink-0">
          <SingleSelectDropdown
            label="Swimlane"
            options={swimlaneOptions}
            selected={filters.swimlaneId}
            onChange={(v) => applyFilters({ ...filters, swimlaneId: v })}
          />
          <SingleSelectDropdown
            label="Column"
            options={columnOptions}
            selected={filters.columnId}
            onChange={(v) => applyFilters({ ...filters, columnId: v })}
          />
          <SingleSelectDropdown
            label="User"
            options={userOptions}
            selected={filters.userId}
            onChange={(v) => applyFilters({ ...filters, userId: v })}
          />
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-slate-500">From</span>
            <input
              type="date"
              value={filters.since}
              onChange={(e) => applyFilters({ ...filters, since: e.target.value })}
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-300 outline-none focus:border-blue-400 w-36"
              aria-label="Since date"
            />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-slate-500">To</span>
            <input
              type="date"
              value={filters.until}
              onChange={(e) => applyFilters({ ...filters, until: e.target.value })}
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-300 outline-none focus:border-blue-400 w-36"
              aria-label="Until date"
            />
          </div>
          {hasFilters(filters) && (
            <button
              onClick={() => applyFilters(EMPTY_FILTERS)}
              className="text-xs text-slate-500 hover:text-slate-300 underline shrink-0 transition"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center flex-1 py-16">
            <span className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-label="Loading" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center flex-1 py-16">
            <p className="text-sm text-slate-400">Failed to load movement history.</p>
          </div>
        ) : !data || data.count === 0 ? (
          <div className="flex items-center justify-center flex-1 py-16">
            <p className="text-sm text-slate-400">
              {hasFilters(filters)
                ? "No movements match the current filters."
                : "No card movements recorded yet."}
            </p>
          </div>
        ) : (
          <>
            {/* Scrollable table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm border-collapse" role="grid" aria-label="Movement history">
                <thead className="sticky top-0 bg-slate-900 z-10">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-slate-500 font-medium uppercase tracking-wide w-36">Time</th>
                    <th className="text-left px-4 py-2 text-xs text-slate-500 font-medium uppercase tracking-wide w-28">User</th>
                    <th className="text-left px-4 py-2 text-xs text-slate-500 font-medium uppercase tracking-wide">Card</th>
                    <th className="text-left px-4 py-2 text-xs text-slate-500 font-medium uppercase tracking-wide">Movement</th>
                  </tr>
                </thead>
                <tbody ref={tbodyRef}>
                  {data.results.map((m, idx) => {
                    const isFocused = focusedIndex === idx;
                    const isSelected = selectedMovement?.id === m.id;
                    return (
                      <tr
                        key={m.id}
                        onClick={() => {
                          setSelectedMovement(isSelected ? null : m);
                          setFocusedIndex(idx);
                        }}
                        onFocus={() => setFocusedIndex(idx)}
                        tabIndex={0}
                        role="row"
                        aria-selected={isSelected}
                        data-testid="history-row"
                        className={`border-b border-slate-800 cursor-pointer transition-colors focus:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-blue-500 ${
                          isSelected
                            ? "bg-blue-600/10"
                            : isFocused
                            ? "bg-slate-800/60"
                            : "hover:bg-slate-800/40"
                        }`}
                      >
                        <td className="px-4 py-2 text-xs text-slate-500 tabular-nums whitespace-nowrap align-top">
                          {new Date(m.moved_at).toLocaleString(undefined, {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-400 align-top truncate max-w-[7rem]">
                          {m.moved_by
                            ? userDisplayName(m.moved_by)
                            : <span className="text-slate-600 italic">Unknown</span>}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-200 align-top">
                          {m.card_title}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-400 align-top">
                          {m.from_column_name && (
                            <span className="text-slate-500">{m.from_column_name} → </span>
                          )}
                          <span className="text-slate-200">{m.to_column_name ?? "—"}</span>
                          {m.to_swimlane_name && m.to_swimlane_name !== m.from_swimlane_name && (
                            <span className="text-slate-500"> · {m.to_swimlane_name}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-slate-800 shrink-0">
              <span className="text-xs text-slate-500">
                Showing {startItem}–{endItem} of {data.count}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-xs rounded bg-slate-800 border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  ← Prev
                </button>
                <span className="text-xs text-slate-500 tabular-nums">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 text-xs rounded bg-slate-800 border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Slide-in detail panel ── */}
      {selectedMovement && (
        <SlideInPanel
          movement={selectedMovement}
          relatedMovements={relatedMovements}
          onClose={() => setSelectedMovement(null)}
        />
      )}
    </div>
  );
}
