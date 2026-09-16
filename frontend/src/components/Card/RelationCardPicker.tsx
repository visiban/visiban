import { Fragment, useMemo, useRef, useState } from "react";
import { useCardSearchResults } from "../../hooks/useCardSearchResults";
import type { Card, CardRelation, CardRelationDirection, Column } from "../../types";

interface Props {
  boardId: number;
  columns: Column[];
  /** The card the relation is being added from — never offerable as a target. */
  currentCardId: number;
  /** Already-linked relations, used to keep unpickable cards out of the list. */
  existing: CardRelation[];
  submitting: boolean;
  onSelect: (card: Card, direction: CardRelationDirection) => void;
  onCancel: () => void;
}

const DIRECTIONS: CardRelationDirection[] = ["blocked_by", "blocks", "relates_to"];

const DIRECTION_LABEL: Record<CardRelationDirection, string> = {
  blocked_by: "Blocked by",
  blocks: "Blocks",
  relates_to: "Relates to",
};

const PLACEHOLDER: Record<CardRelationDirection, string> = {
  blocked_by: "Search for the blocking card…",
  blocks: "Search for the card this blocks…",
  relates_to: "Search for a related card…",
};

/**
 * Two-step inline picker: choose a direction, then choose a card (#449).
 *
 * Direction first because it is a three-way instant choice that completes the
 * sentence the search then fills in, and because it decides which cards are
 * still pickable — the exclusions below depend on it.
 *
 * There is no Save button. The first field always holds a valid value and
 * selecting a card *is* the commit, so no partial state can be written.
 */
export default function RelationCardPicker({
  boardId,
  columns,
  currentCardId,
  existing,
  submitting,
  onSelect,
  onCancel,
}: Props) {
  const [direction, setDirection] = useState<CardRelationDirection>("blocked_by");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const { results, isSearching, failed } = useCardSearchResults(boardId, query);

  const columnName = (id: number) => columns.find((c) => c.id === id)?.name ?? "";

  // Keep every card the server would reject out of the list, so all of the
  // backend's 400s are unreachable through this control. The error mapping in
  // CardRelationsSection is the backstop for concurrent edits and non-UI API
  // clients, not the expected path.
  const options = useMemo(() => {
    const blockedIds = new Set(
      existing.filter((r) => r.relation_type === "blocks").map((r) => r.card.id),
    );
    const relatedIds = new Set(
      existing.filter((r) => r.relation_type === "relates_to").map((r) => r.card.id),
    );
    return results.filter((c) => {
      if (c.id === currentCardId) return false;
      if (direction === "relates_to") return !relatedIds.has(c.id);
      // For both block directions, exclude cards already linked by `blocks` in
      // EITHER direction. Excluding only the same direction would leave cards
      // that produce a mutual-block 400 selectable. A card that already blocks
      // this one is still offerable under `relates_to`, which the backend
      // permits — different relation_type, so no unique_together collision.
      return !blockedIds.has(c.id);
    });
  }, [results, existing, direction, currentCardId]);

  const allExcluded = results.length > 0 && options.length === 0;

  const commit = (card: Card) => {
    if (submitting) return;
    onSelect(card, direction);
    setQuery("");
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Never commits free text — only a highlighted option.
      e.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) commit(options[activeIndex]);
    }
  };

  return (
    <div className="bg-sunken border border-primary-soft rounded p-2.5 flex flex-col gap-2">
      {/* Native radios inside labels: one tab stop for the group, and arrow-key
          navigation comes free from the browser. */}
      <div className="flex gap-1" role="radiogroup" aria-label="Relation type">
        {DIRECTIONS.map((d) => (
          <label
            key={d}
            className={`border rounded px-2 py-1 text-xs cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
              direction === d
                ? "border-primary-emphasis bg-primary-emphasis/10 text-fg"
                : "border-line-strong hover:bg-surface-hover/40 text-fg-secondary"
            }`}
          >
            <input
              type="radio"
              name="relation-direction"
              className="sr-only"
              checked={direction === d}
              onChange={() => {
                setDirection(d);
                setActiveIndex(-1);
              }}
            />
            {DIRECTION_LABEL[d]}
          </label>
        ))}
      </div>

      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        placeholder={PLACEHOLDER[direction]}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls="relation-picker-list"
        aria-autocomplete="list"
        aria-label="Search for a card to link"
        aria-activedescendant={
          activeIndex >= 0 && options[activeIndex]
            ? `relation-option-${options[activeIndex].id}`
            : undefined
        }
        disabled={submitting}
        className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted disabled:opacity-40 disabled:cursor-not-allowed"
      />

      {query.trim().length === 1 && (
        <p className="text-xs text-fg-muted px-1">Type at least 2 characters.</p>
      )}
      {query.trim().length >= 2 && isSearching && (
        <p className="text-xs text-fg-muted px-1">Searching…</p>
      )}
      {query.trim().length >= 2 && !isSearching && !failed && results.length === 0 && (
        <p className="text-xs text-fg-muted px-1">No matching cards on this board.</p>
      )}
      {!isSearching && !failed && allExcluded && (
        <p className="text-xs text-fg-muted px-1">All matching cards are already linked.</p>
      )}
      {/* Rendered here rather than in the section's shared status line: the
          failure belongs next to the control that produced it, and the results
          area is exactly where the user is looking when a search comes back. */}
      {failed && (
        <p className="text-xs text-danger px-1">Search failed. Try again.</p>
      )}

      {options.length > 0 && (
        <div
          id="relation-picker-list"
          role="listbox"
          aria-label="Matching cards"
          className="border border-line-strong rounded-lg bg-surface shadow-lg max-h-56 overflow-y-auto py-1"
        >
          {options.map((c, i) => (
            <Fragment key={c.id}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
              )}
              <button
                type="button"
                role="option"
                id={`relation-option-${c.id}`}
                aria-selected={i === activeIndex}
                disabled={submitting}
                // onMouseDown + preventDefault, not onClick: a click would blur
                // the input and unmount this list before the click landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(c);
                }}
                className={`w-full text-left px-3 py-1.5 text-sm transition flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                  i === activeIndex
                    ? "bg-surface-hover text-fg"
                    : "text-fg-secondary hover:bg-surface-hover"
                }`}
              >
                <span className="flex-1 min-w-0 truncate" title={c.title}>
                  {c.title}
                </span>
                <span className="text-xs text-fg-muted shrink-0 max-w-[8rem] truncate">
                  {columnName(c.column)}
                </span>
              </button>
            </Fragment>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded transition self-start focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        Cancel
      </button>
    </div>
  );
}
