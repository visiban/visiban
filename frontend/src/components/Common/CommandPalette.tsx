import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useRecentBoardsPref } from "../../hooks/useRecentBoardsPref";
import { listBoards } from "../../api/boards";
import type { Board, BoardFull, Card, Column } from "../../types";
import { userDisplayName } from "../../types";
import { PRIORITY_COLORS } from "../../constants/colors";
import {
  PALETTE_COMMAND_LABELS, PRIORITY_CHOICES, paletteCardActions,
  type CardActionDetail, type CardActionEntry, type CardTargetInfo,
} from "../../utils/cardActions";

type PriorityLevel = "high" | "medium" | "low" | "none";

const PRIORITY_COLOR: Record<PriorityLevel, string> = {
  high: "bg-danger-emphasis",
  medium: "bg-warning-emphasis",
  low: "bg-primary-emphasis",
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
  /** When true the action is only surfaced on board routes — it acts on the
   * currently-open board and has no meaning on Dashboard/Group/Settings/Admin. */
  boardOnly?: boolean;
  /** Card-scoped (#2059): listed only when a card target resolves (open sheet >
   * focused card > selection, or a card result drilled into with →). Carried
   * by the card-action rows built from `paletteCardActions()`, which dispatch
   * `visiban:card-action` instead of `onAction`. */
  cardTarget?: boolean;
}

const STATIC_ACTIONS: StaticAction[] = [
  { id: "my-cards", label: "Filter: assigned to me", hint: "M", boardOnly: true },
  { id: "shortcuts", label: "Show keyboard shortcuts", hint: "?" },
  { id: "history", label: "Open full history", boardOnly: true },
  { id: "settings", label: "Open board settings", boardOnly: true },
];

type ResultKind = "card-action" | "choice" | "card" | "board" | "action";

/** A second-level list behind a `…` card command (columns, people, priorities). */
type ChoiceKind = "move" | "assign" | "priority";
interface Choice { label: string; value: number | string | null; dot?: string }

interface ResultItem {
  kind: ResultKind;
  key: string;
  card?: Card;
  board?: Board;
  action?: StaticAction & { entry?: CardActionEntry };
  choice?: Choice;
  /** Resolved column name for cards */
  columnName?: string;
}

interface Props {
  open: boolean;
  /** Current user id; scopes the recent-boards list (#1955). Omit ⇒ no recents. */
  userId?: number | null;
  /** Board-scope inputs. Omit on off-board surfaces (Dashboard, Group,
   * Settings, Admin) to render the palette in "jump" mode: boards + global
   * actions only. */
  boardCards?: Card[];
  columns?: Column[];
  isAdmin?: boolean;
  /** Adaptive placeholder text. Supplied by the shell-level owner per
   * surface so the copy matches the scope the palette can actually cover. */
  placeholder?: string;
  onClose: () => void;
  /** Required only when `boardCards` are supplied; off-board callers can omit. */
  onOpenCard?: (card: Card) => void;
  onAction: (actionId: string) => void;
  /** Board members, for the "Assign card to…" list. */
  members?: BoardFull["members"];
  /** The card target resolved when the palette opened (#2059); null/omitted = none. */
  cardTarget?: CardTargetInfo | null;
  /** Target info for explicit cards: the `→` drill-in on a card result. */
  resolveCardActions?: (cardIds: number[]) => CardTargetInfo | null;
  /** Runs a card action; GlobalCommandPalette dispatches `visiban:card-action`. */
  onCardAction?: (detail: CardActionDetail) => void;
}

export default function CommandPalette({
  open,
  userId,
  boardCards,
  columns,
  isAdmin,
  placeholder = "Jump to anything…",
  onClose,
  onOpenCard,
  onAction,
  members = [],
  cardTarget = null,
  resolveCardActions,
  onCardAction,
}: Props) {
  const boardMode = Array.isArray(boardCards) && Array.isArray(columns);
  const cardsForMode: Card[] = useMemo(
    () => (boardMode ? (boardCards as Card[]) : []),
    [boardMode, boardCards],
  );
  const columnsForMode: Column[] = useMemo(
    () => (boardMode ? (columns as Column[]) : []),
    [boardMode, columns],
  );
  const [query, setQuery] = useState("");
  const [boards, setBoards] = useState<Board[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Drill-in levels (#2059): a card result's actions (→), then a `…`
  // command's choices. Escape / ← / Backspace on empty back out one level.
  const [drill, setDrill] = useState<CardTargetInfo | null>(null);
  const [sub, setSub] = useState<ChoiceKind | null>(null);
  const [announce, setAnnounce] = useState("");
  const target = drill ?? (boardMode ? cardTarget : null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { recentBoards, pruneByIds } = useRecentBoardsPref(userId);

  // Fetch all boards once when opened. The authoritative board list is also used
  // to prune stale entries from the recent-boards localStorage cache (IDOR-safe:
  // a revoked-access board must not leak via palette recents).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setDrill(null);
    setSub(null);
    setAnnounce("");
    setLoadingBoards(true);
    listBoards()
      .then((b) => {
        setBoards(b);
        pruneByIds(new Set(b.map((x) => x.id)));
      })
      .catch(() => setBoards([]))
      .finally(() => setLoadingBoards(false));
  // pruneByIds is stable across renders via the hook's closure scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- pruneByIds intentionally excluded, see comment above
  }, [open]);

  // #1732 — the palette is modal-like: trap Tab and restore focus on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Focus the input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const colMap = useCallback((): Map<number, string> => {
    const m = new Map<number, string>();
    for (const c of columnsForMode) m.set(c.id, c.name);
    return m;
  }, [columnsForMode])();

  const choices = (kind: ChoiceKind): Choice[] => {
    if (kind === "move") return columnsForMode.map((c) => ({ label: c.name, value: c.id, dot: c.color }));
    if (kind === "assign") {
      return [
        { label: "Unassign", value: null },
        ...members.filter((m) => m.role !== "viewer").map((m) => ({ label: userDisplayName(m.user), value: m.user.id })),
      ];
    }
    return PRIORITY_CHOICES.map((p) => ({ label: p.charAt(0).toUpperCase() + p.slice(1), value: p, dot: PRIORITY_COLORS[p] }));
  };

  // Card commands for the target: enabled ones that match; disabled ones only
  // when a typed query matches them (a viewer who types "block" learns why),
  // never as noise on an empty query.
  const cardActionItems = (info: CardTargetInfo, q: string): ResultItem[] =>
    paletteCardActions(info)
      .filter((a) => a.label.toLowerCase().includes(q) && (a.enabled || q !== ""))
      .map((a) => ({
        kind: "card-action" as const,
        key: `card-action-${a.id}`,
        action: { id: a.id, label: a.label, cardTarget: true, entry: a },
      }));

  const results: ResultItem[] = (() => {
    const q = query.trim().toLowerCase();
    const items: ResultItem[] = [];

    if (sub) {
      return choices(sub)
        .filter((c) => c.label.toLowerCase().includes(q))
        .map((c) => ({ kind: "choice" as const, key: `choice-${sub}-${String(c.value)}`, choice: c }));
    }
    if (drill) return cardActionItems(drill, q);
    if (target) items.push(...cardActionItems(target, q));

    // Cards — only in board mode; match title
    if (boardMode) {
      const cardMatches = cardsForMode
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
    }

    // Boards — empty query surfaces starred (alpha) then recents (MRU, excluding
    // already-starred and intersected with the accessible board set). Non-empty
    // query filters by name with starred pinned to the top.
    let boardMatches: Board[];
    if (q === "") {
      const starred = boards
        .filter((b) => b.is_starred)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      const starredIds = new Set(starred.map((b) => b.id));
      const recents = recentBoards
        .map((r) => boards.find((b) => b.id === r.id))
        .filter((b): b is Board => !!b && !starredIds.has(b.id));
      boardMatches = [...starred, ...recents].slice(0, 5);
    } else {
      boardMatches = boards
        .filter((b) => b.name.toLowerCase().includes(q))
        .slice()
        .sort((a, b) => {
          const starDelta = Number(b.is_starred) - Number(a.is_starred);
          return starDelta !== 0 ? starDelta : a.name.localeCompare(b.name);
        })
        .slice(0, 5);
    }
    for (const board of boardMatches) {
      items.push({ kind: "board", key: `board-${board.id}`, board });
    }

    // Actions — match label; filter settings to admins; drop board-only actions off-board.
    const actionMatches = STATIC_ACTIONS.filter((a) => {
      if (a.boardOnly && !boardMode) return false;
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

  const resetLevel = () => { setQuery(""); setActiveIndex(0); };
  const backOut = (): boolean => {
    if (sub) { setSub(null); resetLevel(); setAnnounce(target ? `Card actions for ${target.summary}` : ""); return true; }
    if (drill) { setDrill(null); resetLevel(); setAnnounce("All results"); return true; }
    return false;
  };

  // Priority 60 — above most UI panels. Escape backs out one drill-in level,
  // then closes.
  useEscapeStack(() => {
    if (!open) return false;
    if (backOut()) return;
    onClose();
  }, 60);

  // No card target and a query that names a card command: say how to get one.
  const q0 = query.trim().toLowerCase();
  const showNoTargetHint = boardMode && !target && !sub && q0 !== ""
    && PALETTE_COMMAND_LABELS.some((l) => l.toLowerCase().includes(q0));

  const activate = useCallback((item: ResultItem, newTab = false) => {
    if (item.kind === "card" && item.card && onOpenCard) {
      onClose();
      onOpenCard(item.card);
    } else if (item.kind === "board" && item.board) {
      onClose();
      const path = `/boards/${item.board.id}`;
      if (newTab) {
        window.open(path, "_blank", "noreferrer");
      } else {
        // Fire-and-forget: the declarative router resolves navigate()
        // synchronously, and any failure is handled by its own error boundary.
        void navigate(path);
      }
    } else if (item.kind === "card-action" && item.action?.entry && target) {
      const entry = item.action.entry;
      if (!entry.enabled) {
        // Disabled commands do nothing and re-announce why.
        setAnnounce((prev) => (prev === entry.reason ? `${entry.reason}\u00a0` : entry.reason ?? ""));
        return;
      }
      if (entry.id === "move" || entry.id === "assign" || entry.id === "priority") {
        setSub(entry.id);
        setAnnounce(entry.id === "move" ? "Choose a column" : entry.id === "assign" ? "Choose a person" : "Choose a priority");
        resetLevel();
        return;
      }
      // Block card… closes the palette and opens the reason form in the sheet.
      onClose();
      onCardAction?.({ cardIds: target.cardIds, action: entry.id });
    } else if (item.kind === "choice" && item.choice && sub && target) {
      onClose();
      onCardAction?.({ cardIds: target.cardIds, action: sub, value: item.choice.value });
    } else if (item.kind === "action" && item.action) {
      onClose();
      onAction(item.action.id);
    }
  }, [onClose, onOpenCard, navigate, onAction, onCardAction, target, sub]);

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
    } else if (e.key === "ArrowRight" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // → on a card result drills into its actions. Only with the caret at
      // the end, so → still moves the caret inside a typed query.
      const item = results[activeIndex];
      const input = e.currentTarget as HTMLInputElement;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (item?.kind === "card" && item.card && atEnd && resolveCardActions) {
        const info = resolveCardActions([item.card.id]);
        if (info) {
          e.preventDefault();
          setDrill(info);
          setAnnounce(`Card actions for ${info.summary}`);
          resetLevel();
        }
      }
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && query === "" && (sub || drill)) {
      e.preventDefault();
      backOut();
    }
  // resetLevel/backOut only touch local state.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resetLevel/backOut touch only local state
  }, [results, activeIndex, activate, resolveCardActions, query, sub, drill]);

  if (!open) return null;

  // Group results by kind for section headers
  let lastKind: ResultKind | null = null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-backdrop/60 flex items-start justify-center pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="w-[480px] max-w-[90vw] bg-surface border border-line-strong rounded-lg shadow-2xl flex flex-col max-h-[60vh] outline-none"
      >
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
            placeholder={sub === "move" ? "Choose a column…" : sub === "assign" ? "Choose a person…" : sub === "priority" ? "Choose a priority…" : drill ? "Search card actions…" : placeholder}
            className="bg-transparent flex-1 text-sm text-fg placeholder-fg-muted outline-none"
            aria-label="Command palette search"
            aria-autocomplete="list"
            aria-activedescendant={results[activeIndex] ? `palette-item-${results[activeIndex].key}` : undefined}
            role="combobox"
            aria-expanded={results.length > 0}
          />
          <kbd className="text-xs px-1.5 py-0.5 bg-sunken border border-line rounded text-fg-muted shrink-0">
            esc
          </kbd>
        </div>

        {/* The card the card commands act on (#2059). */}
        {target && (
          <div className="px-3 py-1.5 border-b border-line text-xs text-fg-tertiary flex items-center gap-2 shrink-0" data-testid="palette-card-target">
            {(drill || sub) && <span aria-hidden="true">←</span>}
            <span className="truncate">
              Acting on <span className="text-fg-secondary">{target.summary}</span>
              {sub && <> · {sub === "move" ? "Move card to" : sub === "assign" ? "Assign card to" : "Set priority"}</>}
            </span>
          </div>
        )}

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto flex-1 py-1" role="listbox" aria-label="Results">
          {loadingBoards && !drill && !sub && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-fg-muted italic">Loading…</p>
          )}
          {(!loadingBoards || drill || sub) && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-fg-muted italic text-center">
              {drill || sub
                ? "No matching card actions"
                : !boardMode && boards.length === 0 && query.trim() === ""
                ? "You don't have any boards yet."
                : query.trim() === "" && boards.length > 0
                ? (boardMode ? "Start typing to search boards and cards" : "Start typing to jump to a board")
                : "No results"}
            </p>
          )}
          {results.map((item, i) => {
            const showHeader = item.kind !== lastKind;
            lastKind = item.kind;
            const isActive = i === activeIndex;

            const label =
              item.kind === "card" ? item.card!.title
              : item.kind === "board" ? item.board!.name
              : item.kind === "choice" ? item.choice!.label
              : item.action!.label;

            const entry = item.kind === "card-action" ? item.action!.entry : undefined;
            const disabled = entry !== undefined && !entry.enabled;
            const sublabel =
              item.kind === "card"
                ? item.columnName
                : item.kind === "board"
                ? (item.board!.group_name ?? "No group")
                : null;

            const sectionLabel =
              item.kind === "card-action" ? "Card actions"
              : item.kind === "choice" ? (sub === "move" ? "Columns" : sub === "assign" ? "People" : "Priorities")
              : item.kind === "card" ? "Cards"
              : item.kind === "board" ? "Boards"
              : "Actions";

            return (
              <div key={item.key}>
                {showHeader && (
                  <div className="px-3 pt-2 pb-0.5 text-xs uppercase tracking-wide text-fg-muted select-none">
                    {sectionLabel}
                  </div>
                )}
                <button
                  id={`palette-item-${item.key}`}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={disabled || undefined}
                  aria-describedby={disabled ? `palette-reason-${item.key}` : undefined}
                  data-active={isActive}
                  onClick={() => activate(item)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition ${
                    isActive ? "bg-surface-hover/60" : "hover:bg-surface-hover/40"
                  } ${disabled ? "cursor-not-allowed" : ""}`}
                >
                  {item.kind === "choice" && item.choice?.dot && (
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: item.choice.dot }} aria-hidden="true" />
                  )}
                  {item.kind === "card" && item.card && (
                    <span
                      className={`w-1 h-4 rounded shrink-0 ${PRIORITY_COLOR[priorityLevel(item.card.priority)]}`}
                      aria-hidden="true"
                    />
                  )}
                  {item.kind === "board" && item.board?.is_starred && (
                    <>
                      <span className="sr-only">Favorite</span>
                      <span className="text-warning text-xs shrink-0" aria-hidden="true">★</span>
                    </>
                  )}
                  {disabled ? (
                    <span className="flex flex-col min-w-0">
                      <span className="text-sm truncate text-fg-tertiary">{label}</span>
                      <span id={`palette-reason-${item.key}`} className="text-xs text-fg-tertiary">{entry?.reason}</span>
                    </span>
                  ) : (
                    <span className={`text-sm truncate ${isActive ? "text-fg" : "text-fg-secondary"}`}>
                      {label}
                    </span>
                  )}
                  {sublabel && (
                    <span className="text-xs text-fg-muted ml-auto shrink-0 truncate max-w-[140px]">
                      {sublabel}
                    </span>
                  )}
                  {item.kind === "card" && isActive && resolveCardActions && (
                    <kbd className="text-xs px-1.5 py-0.5 bg-sunken border border-line rounded text-fg-muted shrink-0" title="Card actions">→</kbd>
                  )}
                  {item.kind === "action" && item.action?.hint && (
                    <kbd className="text-xs px-1.5 py-0.5 bg-sunken border border-line rounded text-fg-muted ml-auto shrink-0">
                      {item.action.hint}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* No target: card commands are not listed, so say how to get one. */}
        {showNoTargetHint && (
          <div role="group" aria-label="Card actions" className="px-3 pb-2 shrink-0" data-testid="palette-no-card-target">
            <div className="pt-1 pb-0.5 text-xs uppercase tracking-wide text-fg-muted select-none">Card actions</div>
            <p className="text-xs text-fg-tertiary italic">Select, focus or open a card to act on it.</p>
            <p className="text-xs text-fg-tertiary italic">Or search for a card and press →.</p>
          </div>
        )}

        {/* Always mounted, so a disabled command's re-announced reason is read. */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announce}</p>

        {/* Footer hints */}
        <div className="px-3 py-2 border-t border-line text-xs text-fg-muted flex items-center gap-3 shrink-0">
          <span>↑↓ navigate</span>
          {drill || sub ? (
            <>
              <span>↵ run</span>
              <span>← back</span>
            </>
          ) : (
            <>
              <span>↵ open</span>
              <span>⌘↵ new tab</span>
              {boardMode && resolveCardActions && <span>→ card actions</span>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
