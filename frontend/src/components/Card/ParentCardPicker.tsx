import { useEffect, useId, useRef, useState } from "react";
import { getParentCandidates, linkCardParent } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { CardParentVisible, ParentBoardOption, ParentCandidate } from "../../types";
import { isImeComposing } from "../../utils/imeComposition";
import Avatar from "../Common/Avatar";
import SelectDropdown from "../Common/SelectDropdown";
import { candidateDisabledReason, linkErrorCopy } from "./cardParent";

interface Props {
  boardId: number;
  cardId: number;
  /** Parent boards the viewer is member+ on (`GET .../parent-boards/`); never empty here. */
  parentBoards: ParentBoardOption[];
  /** Called after a successful link with the parent as the picker knows it. */
  onLinked: (parent: CardParentVisible) => void;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;
/** Escape slot inside CardDetail (frontend/CLAUDE.md § Escape priority inside the card detail panel). */
export const PARENT_PICKER_ESCAPE_PRIORITY = 37.5;
const HEADING = "Link a parent card";
const HELPER = "Cards on boards you can open. Search by title or card number.";

/** The search the server answers: two characters, or any all-digit card number. */
function searchable(q: string): boolean {
  const t = q.trim();
  return t.length >= 2 || /^\d+$/.test(t);
}

/**
 * "Link a parent" picker (#1104, canvas artboards 4 and 2e §2).
 *
 * A dialog over the card panel: a Board select (only parent boards the viewer
 * is member+ on) and a card combobox. Focus stays in the search field; Up and
 * Down move the active option, Enter links it. A click selects an option and
 * the primary button links it. Disabled options stay listed with the reason.
 *
 * "No matching cards" is the one answer for a missing card, a card on a board
 * the viewer can't open and an unknown card number: the server returns an
 * empty list for all three, and nothing here hints at what it withheld.
 *
 * Phone (below 640px): a full-screen sheet with "‹ Card" and Close; the list
 * scrolls inside the sheet, which is sized from `visualViewport` (full height
 * where it is unavailable) so the keyboard never covers the list and Cancel and
 * Link stay pinned above it.
 */
export default function ParentCardPicker({ boardId, cardId, parentBoards, onLinked, onClose }: Props) {
  const ids = useId();
  const listId = `${ids}-list`;
  const helperId = `${ids}-helper`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [parentBoardId, setParentBoardId] = useState<number>(parentBoards[0].id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ParentCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // The phone sheet is as tall as what the user can see: the on-screen
  // keyboard shrinks `visualViewport` but not the layout viewport, so a
  // `h-full` sheet would run under it with Cancel and Link. Unset (no
  // visualViewport) the sheet falls back to the full height.
  const [visibleHeight, setVisibleHeight] = useState<number | null>(() =>
    typeof window !== "undefined" && window.visualViewport ? window.visualViewport.height : null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setVisibleHeight(vv.height);
    sync();
    vv.addEventListener("resize", sync);
    return () => vv.removeEventListener("resize", sync);
  }, []);

  useFocusTrap(dialogRef, true);
  useEscapeStack(() => {
    // Swallowed while the link request runs, so a failure is never hidden.
    if (!submittingRef.current) onClose();
  }, PARENT_PICKER_ESCAPE_PRIORITY);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search, cancelled when the query or board changes. The search
  // starts empty: nothing is requested until the user types.
  useEffect(() => {
    const q = query.trim();
    if (!searchable(q)) {
      setResults([]);
      setSearching(false);
      setFailed(false);
      setSearchedFor(null);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      getParentCandidates(boardId, cardId, parentBoardId, q, controller.signal)
        .then((rows) => {
          setResults(rows);
          setFailed(false);
          setSearchedFor(q);
          setSearching(false);
        })
        .catch((err) => {
          if (controller.signal.aborted || (err as { name?: string })?.name === "CanceledError") return;
          setResults([]);
          setFailed(true);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [boardId, cardId, parentBoardId, query]);

  const boardName = parentBoards.find((b) => b.id === parentBoardId)?.name ?? "";
  const selected = results.find((r) => r.id === selectedId) ?? null;

  const link = async (candidate: ParentCandidate) => {
    if (submittingRef.current || candidateDisabledReason(candidate)) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await linkCardParent(boardId, cardId, candidate.id);
      onLinked({
        hidden: false,
        id: candidate.id,
        title: candidate.title,
        board_id: parentBoardId,
        board_name: boardName,
        column_id: candidate.column_id,
        column_name: candidate.column_name,
        swimlane_id: candidate.swimlane_id,
        swimlane_name: candidate.swimlane_name,
        archived: false,
      });
    } catch (err) {
      setError(linkErrorCopy(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      const active = activeIndex >= 0 ? results[activeIndex] : selected;
      if (active && !candidateDisabledReason(active)) {
        setSelectedId(active.id);
        void link(active);
      }
    }
  };

  // Keep the keyboard-active option in view inside the capped list.
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = document.getElementById(`${ids}-opt-${results[activeIndex]?.id}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, ids, results]);

  const noResults = !searching && !failed && searchedFor !== null && results.length === 0;
  const status = searching
    ? "Searching…"
    : failed
      ? "Search failed. Try again."
      : noResults
        ? "No matching cards"
        : "";
  const linkName = selected ? `Link to ${selected.title}` : "Link";
  const linkDisabled = !selected || submitting || candidateDisabledReason(selected) !== null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center max-sm:items-start">
      <div className="absolute inset-0 bg-backdrop/40" aria-hidden="true" onClick={() => { if (!submittingRef.current) onClose(); }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={HEADING}
        tabIndex={-1}
        data-testid="parent-card-picker"
        style={visibleHeight ? ({ "--parent-picker-vh": `${visibleHeight}px` } as React.CSSProperties) : undefined}
        className="relative bg-surface border border-line rounded-lg shadow-xl w-[28rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex flex-col outline-none max-sm:w-full max-sm:max-w-none max-sm:h-[var(--parent-picker-vh,100%)] max-sm:max-h-none max-sm:rounded-none max-sm:border-0"
      >
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 max-sm:px-2 max-sm:pt-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to card"
            className="sm:hidden min-h-11 min-w-11 px-2 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            ‹ Card
          </button>
          <h3 className="flex-1 min-w-0 text-sm font-semibold text-fg truncate">{HEADING}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="px-5 flex flex-col gap-3 min-h-0 flex-1 max-sm:px-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-secondary" id={`${ids}-board-label`}>Board</span>
            <SelectDropdown
              value={String(parentBoardId)}
              onChange={(v) => {
                setParentBoardId(Number(v));
                setSelectedId(null);
                setActiveIndex(-1);
                setError(null);
              }}
              options={parentBoards.map((b) => ({ value: String(b.id), label: b.name }))}
              ariaLabel="Board"
              disabled={submitting}
              className="max-sm:min-h-11"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-search`} className="text-xs font-medium text-fg-secondary">Card</label>
            <input
              id={`${ids}-search`}
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(-1);
                setSelectedId(null);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-describedby={helperId}
              aria-activedescendant={activeIndex >= 0 && results[activeIndex] ? `${ids}-opt-${results[activeIndex].id}` : undefined}
              placeholder="Search cards…"
              className="min-h-11 sm:min-h-0 w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
            <p id={helperId} className="text-xs text-fg-muted">{HELPER}</p>
          </div>

          {/* Always mounted, so each state change is announced. */}
          <p role="status" aria-live="polite" aria-atomic="true" className={status ? "text-xs text-fg-muted" : "sr-only"} data-testid="parent-picker-status">
            {status}
            {noResults && (
              <span className="block mt-0.5">Check the spelling or try a card number. Only cards you can open are searched.</span>
            )}
          </p>

          <div
            id={listId}
            role="listbox"
            aria-label="Matching cards"
            aria-describedby={helperId}
            className={`min-h-0 overflow-y-auto max-sm:flex-1 sm:max-h-72 -mx-1 px-1 ${results.length === 0 ? "hidden" : ""}`}
          >
            {results.map((c, i) => {
              const reason = candidateDisabledReason(c);
              const isSelected = c.id === selectedId;
              return (
                <div
                  key={c.id}
                  id={`${ids}-opt-${c.id}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={reason ? true : undefined}
                  // mousedown, not click: focus stays in the search field.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (reason) return;
                    setSelectedId(c.id);
                    setActiveIndex(i);
                  }}
                  className={`min-h-14 flex items-center gap-2 px-3 py-2 rounded border-l-2 ${
                    isSelected ? "border-primary-emphasis bg-primary-emphasis/10" : "border-transparent"
                  } ${i === activeIndex ? "outline outline-2 outline-primary-emphasis -outline-offset-2" : ""} ${
                    reason ? "cursor-not-allowed" : "cursor-pointer hover:bg-surface-hover"
                  }`}
                >
                  <span aria-hidden="true" className="w-4 shrink-0 text-primary-emphasis text-sm">{isSelected ? "✓" : ""}</span>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm truncate ${reason ? "text-fg-muted" : "text-fg"}`}>{c.title}</span>
                    <span className="block text-xs text-fg-muted truncate">
                      {boardName} › {c.column_name} · {reason ?? c.swimlane_name}
                    </span>
                  </span>
                  {c.assignee && <Avatar user={c.assignee} size="sm" />}
                </div>
              );
            })}
          </div>

          {/* Link failures: always mounted beside the footer, text only. */}
          <p role="alert" className={error ? "text-xs text-danger" : "sr-only"} data-testid="parent-picker-error">{error ?? ""}</p>
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line mt-3 max-sm:px-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="min-h-11 sm:min-h-0 px-3 py-1.5 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            aria-disabled={linkDisabled || undefined}
            aria-label={linkName}
            onClick={() => { if (!linkDisabled && selected) void link(selected); }}
            className={`min-h-11 sm:min-h-0 max-w-[16rem] truncate px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${linkDisabled ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <span className="sm:hidden">{submitting ? "Linking…" : "Link"}</span>
            <span className="max-sm:hidden">{submitting ? "Linking…" : linkName}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
