import { useEffect, useId, useRef, useState } from "react";
import { getChildCandidates, linkCardParent } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { ChildCandidate } from "../../types";
import { isImeComposing } from "../../utils/imeComposition";
import Avatar from "../Common/Avatar";
import SelectDropdown from "../Common/SelectDropdown";
import { childCandidateReason, linkErrorCopy } from "./cardParent";
import { CHILD_PICKER_ESCAPE_PRIORITY } from "./cardChildren";

interface Props {
  /** The parent card and the board it is on. */
  boardId: number;
  cardId: number;
  cardTitle: string;
  /**
   * Child boards the picker may search. One entry once the parent has children
   * (one child board per parent, #2206 decision A) or a default is set; the
   * #2208 chooser's boards otherwise, offered in a Board select.
   */
  boards: { id: number; name: string }[];
  onLinked: (child: ChildCandidate, boardId: number) => void;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;
const HEADING = "Link existing card";

function searchable(q: string): boolean {
  const t = q.trim();
  return t.length >= 2 || /^\d+$/.test(t);
}

/**
 * Link existing (#2209; picker spec on #1104, canvas 4 and 2f e). The parent-side mirror of
 * `ParentCardPicker`: the same combobox pattern, searching only this parent's child board. The link is
 * written on the child's own board (`POST .../cards/{child}/parent/`), so the child board's role decides it
 * and both cards log it in their history. "No matching cards" is the one answer for a missing card and a
 * card the viewer can't open.
 */
export default function ChildCardPicker({ boardId, cardId, cardTitle, boards, onLinked, onClose }: Props) {
  const ids = useId();
  const listId = `${ids}-list`;
  const helperId = `${ids}-helper`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [childBoardId, setChildBoardId] = useState<number>(boards[0].id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChildCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(dialogRef, true);
  useEscapeStack(() => {
    if (!submittingRef.current) onClose();
  }, CHILD_PICKER_ESCAPE_PRIORITY);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
      getChildCandidates(boardId, cardId, childBoardId, q, controller.signal)
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
  }, [boardId, cardId, childBoardId, query]);

  const boardName = boards.find((b) => b.id === childBoardId)?.name ?? "";
  const selected = results.find((r) => r.id === selectedId) ?? null;

  const link = async (candidate: ChildCandidate) => {
    if (submittingRef.current || childCandidateReason(candidate)) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Written on the child's board: its role, not this board's, authorizes it.
      await linkCardParent(childBoardId, candidate.id, cardId);
      onLinked(candidate, childBoardId);
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
      if (active && !childCandidateReason(active)) {
        setSelectedId(active.id);
        void link(active);
      }
    }
  };

  const noResults = !searching && !failed && searchedFor !== null && results.length === 0;
  const status = searching ? "Searching…" : failed ? "Search failed. Try again." : noResults ? "No matching cards" : "";
  const linkName = `Link to ${cardTitle}`;
  const linkDisabled = !selected || submitting || childCandidateReason(selected) !== null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center max-sm:items-start">
      <div className="absolute inset-0 bg-backdrop/40" aria-hidden="true" onClick={() => { if (!submittingRef.current) onClose(); }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={HEADING}
        tabIndex={-1}
        data-testid="child-card-picker"
        className="relative bg-surface border border-line rounded-lg shadow-xl w-[28rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex flex-col outline-none max-sm:w-full max-sm:max-w-none max-sm:h-full max-sm:max-h-none max-sm:rounded-none max-sm:border-0"
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
            <span className="text-xs font-medium text-fg-secondary">Board</span>
            {boards.length > 1 ? (
              <SelectDropdown
                value={String(childBoardId)}
                onChange={(v) => {
                  setChildBoardId(Number(v));
                  setSelectedId(null);
                  setActiveIndex(-1);
                  setError(null);
                }}
                options={boards.map((b) => ({ value: String(b.id), label: b.name }))}
                ariaLabel="Board"
                disabled={submitting}
                className="max-sm:min-h-11"
              />
            ) : (
              // Fixed: a parent's children all live on one board.
              <span className="text-sm text-fg">{boardName}</span>
            )}
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
            <p id={helperId} className="text-xs text-fg-muted">Cards on {boardName}, this card&apos;s child board. Search by title or card number.</p>
          </div>

          <p role="status" aria-live="polite" aria-atomic="true" className={status ? "text-xs text-fg-muted" : "sr-only"} data-testid="child-picker-status">
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
              const reason = childCandidateReason(c);
              const isSelected = c.id === selectedId;
              return (
                <div
                  key={c.id}
                  id={`${ids}-opt-${c.id}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={reason ? true : undefined}
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
                      {boardName} › {c.column_name} · {reason ?? "not linked"}
                    </span>
                  </span>
                  {c.assignee && <Avatar user={c.assignee} size="sm" />}
                </div>
              );
            })}
          </div>

          <p role="alert" className={error ? "text-xs text-danger" : "sr-only"} data-testid="child-picker-error">{error ?? ""}</p>
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
