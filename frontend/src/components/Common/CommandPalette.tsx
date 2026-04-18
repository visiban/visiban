import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { listBoards } from "../../api/boards";
import type { Board, Card, Column } from "../../types";

type PriorityLevel = "high" | "medium" | "low" | "none";

const PRIORITY_COLOR: Record<PriorityLevel, string> = {
  high: "bg-red-500",
  medium: "bg-amber-400",
  low: "bg-blue-500",
  none: "bg-surface-active",
};

function priorityLevel(p: string | null | undefined): PriorityLevel {
  if (p === "high" || p === "critical") return "high";
  if (p === "medium") return "medium";
  if (p === "low") return "low";
  return "none";
}

interface StaticAction {
  id: string;
  label: string;
  hint?: string;
}

const STATIC_ACTIONS: StaticAction[] = [
  { id: "my-cards", label: "Filter: assigned to me", hint: "M" },
  { id: "shortcuts", label: "Show keyboard shortcuts", hint: "?" },
  { id: "history", label: "Open full history" },
  { id: "settings", label: "Open board settings" },
];

type ResultKind = "card" | "board" | "action";

interface ResultItem {
  kind: ResultKind;
  key: string;
  card?: Card;
  board?: Board;
  action?: StaticAction;
  /** Resolved column name for cards */
  columnName?: string;
}

interface Props {
  open: boolean;
  boardCards: Card[];
  columns: Column[];
  isAdmin: boolean;
  onClose: () => void;
  onOpenCard: (card: Card) => void;
  onAction: (actionId: string) => void;
}

export default function CommandPalette({ open, boardCards, columns, isAdmin, onClose, onOpenCard, onAction }: Props) {
  const [query, setQuery] = useState("");
  const [boards, setBoards] = useState<Board[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Fetch all boards once when opened
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setLoadingBoards(true);
    listBoards()
      .then((b) => setBoards(b))
      .catch(() => setBoards([]))
      .finally(() => setLoadingBoards(false));
  }, [open]);

  // Focus the input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const colMap = useCallback((): Map<number, string> => {
    const m = new Map<number, string>();
    for (const c of columns) m.set(c.id, c.name);
    return m;
  }, [columns])();

  const results: ResultItem[] = (() => {
    const q = query.trim().toLowerCase();
    const items: ResultItem[] = [];

    // Cards — match title
    const cardMatches = boardCards
      .filter((c) => c.archived_at === null && c.title.toLowerCase().includes(q))
      .slice(0, 6);
    for (const card of cardMatches) {
      items.push({
        kind: "card",
        key: `card-${card.id}`,
        card,
        columnName: colMap.get(card.column) ?? "",
      });
    }

    // Boards — match name (skip current board cards' board — not tracked here, show all)
    const boardMatches = boards
      .filter((b) => b.name.toLowerCase().includes(q))
      .slice(0, 5);
    for (const board of boardMatches) {
      items.push({ kind: "board", key: `board-${board.id}`, board });
    }

    // Actions — match label; filter settings to admins
    const actionMatches = STATIC_ACTIONS.filter((a) => {
      if (a.id === "settings" && !isAdmin) return false;
      return a.label.toLowerCase().includes(q);
    });
    for (const action of actionMatches) {
      items.push({ kind: "action", key: `action-${action.id}`, action });
    }

    return items;
  })();

  // Keep activeIndex in range
  useEffect(() => {
    setActiveIndex((prev) => (results.length === 0 ? 0 : Math.min(prev, results.length - 1)));
  }, [results.length]);

  // Scroll active row into view (scrollIntoView may be absent in some environments)
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(`[data-active="true"]`) as HTMLElement | null;
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  // Priority 60 — above most UI panels. Close on Escape.
  useEscapeStack(() => {
    if (!open) return false;
    onClose();
  }, 60);

  const activate = useCallback((item: ResultItem, newTab = false) => {
    if (item.kind === "card" && item.card) {
      onClose();
      onOpenCard(item.card);
    } else if (item.kind === "board" && item.board) {
      onClose();
      const path = `/boards/${item.board.id}`;
      if (newTab) {
        window.open(path, "_blank", "noreferrer");
      } else {
        navigate(path);
      }
    } else if (item.kind === "action" && item.action) {
      onClose();
      onAction(item.action.id);
    }
  }, [onClose, onOpenCard, navigate, onAction]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (results.length === 0 ? 0 : (prev - 1 + results.length) % results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) activate(item, e.metaKey || e.ctrlKey);
    }
  }, [results, activeIndex, activate]);

  if (!open) return null;

  // Group results by kind for section headers
  let lastKind: ResultKind | null = null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[480px] max-w-[90vw] bg-surface border border-line-strong rounded-lg shadow-2xl flex flex-col max-h-[60vh]">
        {/* Search input */}
        <div className="px-3 py-2 border-b border-line flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 text-fg-muted shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Jump to anything…"
            className="bg-transparent flex-1 text-sm text-fg placeholder-fg-muted outline-none"
            aria-label="Command palette search"
            aria-autocomplete="list"
            aria-activedescendant={results[activeIndex] ? `palette-item-${results[activeIndex].key}` : undefined}
            role="combobox"
            aria-expanded={results.length > 0}
          />
          <kbd className="text-[10px] px-1.5 py-0.5 bg-sunken border border-line rounded text-fg-muted shrink-0">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto flex-1 py-1" role="listbox" aria-label="Results">
          {loadingBoards && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-fg-muted italic">Loading…</p>
          )}
          {!loadingBoards && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-fg-muted italic text-center">No results</p>
          )}
          {results.map((item, i) => {
            const showHeader = item.kind !== lastKind;
            lastKind = item.kind;
            const isActive = i === activeIndex;

            const label =
              item.kind === "card" ? item.card!.title
              : item.kind === "board" ? item.board!.name
              : item.action!.label;

            const sublabel =
              item.kind === "card"
                ? item.columnName
                : item.kind === "board"
                ? (item.board!.group_name ?? "No group")
                : null;

            const sectionLabel =
              item.kind === "card" ? "Cards"
              : item.kind === "board" ? "Boards"
              : "Actions";

            return (
              <div key={item.key}>
                {showHeader && (
                  <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-fg-muted select-none">
                    {sectionLabel}
                  </div>
                )}
                <button
                  id={`palette-item-${item.key}`}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive}
                  onClick={() => activate(item)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition ${
                    isActive ? "bg-surface-hover/60" : "hover:bg-surface-hover/40"
                  }`}
                >
                  {item.kind === "card" && item.card && (
                    <span
                      className={`w-1 h-4 rounded shrink-0 ${PRIORITY_COLOR[priorityLevel(item.card.priority)]}`}
                      aria-hidden="true"
                    />
                  )}
                  <span className={`text-sm truncate ${isActive ? "text-fg" : "text-fg-secondary"}`}>
                    {label}
                  </span>
                  {sublabel && (
                    <span className="text-xs text-fg-muted ml-auto shrink-0 truncate max-w-[140px]">
                      {sublabel}
                    </span>
                  )}
                  {item.kind === "action" && item.action?.hint && (
                    <kbd className="text-[10px] px-1.5 py-0.5 bg-sunken border border-line rounded text-fg-muted ml-auto shrink-0">
                      {item.action.hint}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer hints */}
        <div className="px-3 py-2 border-t border-line text-[11px] text-fg-muted flex items-center gap-3 shrink-0">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>⌘↵ new tab</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
