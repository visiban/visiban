import { useCallback, useEffect, useRef, useState } from "react";
import { addCardRelation, deleteCardRelation, getCardRelations } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type {
  BoardFull,
  Card,
  CardRelation,
  CardRelationDirection,
} from "../../types";
import RelationCardPicker from "./RelationCardPicker";

interface Props {
  board: BoardFull;
  card: Card;
  /**
   * Member and above — deliberately `canEdit`, not `canComment`. A relation
   * changes how a *different* card reads for the whole board, so it sits on
   * the card-state side of the line rather than the annotation side that
   * collaborators get. This must stay in step with the backend allow-list on
   * the relations endpoints; the two are asserted separately, so a change to
   * one without the other shows up as a control the API then refuses.
   */
  canEdit: boolean;
  /**
   * Called with +1 / -1 when an incoming, non-archived `blocks` relation is
   * added or removed, so the open panel's card face tracks the change without
   * waiting for the WebSocket round trip.
   */
  onBlockerCountChange: (delta: number) => void;
}

/** Rendered top to bottom: what blocks me, what I block, loose associations. */
const GROUPS: { direction: CardRelationDirection; label: string }[] = [
  { direction: "blocked_by", label: "Blocked by" },
  { direction: "blocks", label: "Blocks" },
  { direction: "relates_to", label: "Relates to" },
];

// Machine-checkable `code` slugs from the backend mapped to copy. The frontend
// must not string-match `detail` — the code is the contract, the sentence is
// not.
const ERROR_COPY: Record<string, string> = {
  self_relation: "A card cannot be related to itself.",
  cross_board: "That card is on another board. Relations can only link cards on this board.",
  archived_card: "That card is archived and cannot be linked.",
  relation_exists: "That relation already exists.",
  relation_cycle: "Those two cards would block each other. Remove the existing relation first.",
};
const GENERIC_ADD_ERROR = "Could not add the relation. Try again.";

function errorCopy(err: unknown): string {
  const raw = (err as { response?: { data?: { code?: string | string[] } } })?.response?.data?.code;
  // DRF coerces a `.validate()` dict's scalar values into single-item lists.
  const code = Array.isArray(raw) ? raw[0] : raw;
  return (code && ERROR_COPY[code]) || GENERIC_ADD_ERROR;
}

/**
 * The Relations sub-section of the card detail panel (#449).
 *
 * Owns its own fetch rather than being fed by CardDetail, so the panel's diff
 * stays at one JSX block and the retry path lives next to the thing that
 * failed.
 */
export default function CardRelationsSection({
  board,
  card,
  canEdit,
  onBlockerCountChange,
}: Props) {
  const [relations, setRelations] = useState<CardRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Seeded synchronously from `blocker_count`, which is already on the card
  // prop, so a blocked card paints expanded on the first frame instead of
  // reflowing when the fetch resolves. Re-set from the response below, which
  // also catches `relates_to`-only cards that the seed cannot see.
  const [open, setOpen] = useState(() => card.blocker_count > 0);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getCardRelations(board.id, card.id)
      .then((data) => {
        setRelations(data);
        setOpen(data.length > 0);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(true);
        setLoading(false);
      });
  }, [board.id, card.id]);

  useEffect(load, [load]);

  // Priority 37, NOT useDropdownEscape (25). The card detail panel's own close
  // handler sits at 30, so anything below it would let Escape dismiss the whole
  // panel instead of this picker. 35 is the confirm overlay and 36 the move
  // popover; 37 is the next free rung above them.
  useEscapeStack(() => {
    if (!addOpen) return false;
    setAddOpen(false);
    setActionError(null);
    addButtonRef.current?.focus();
  }, 37);

  const columnName = (id: number) => board.columns.find((c) => c.id === id)?.name ?? "";

  /** Only an active card blocking this one moves the card-face indicator. */
  const countsAsBlocker = (rel: CardRelation) =>
    rel.direction === "blocked_by" && !rel.card.archived;

  const handleSelect = async (picked: Card, direction: CardRelationDirection) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const created = await addCardRelation(board.id, card.id, picked.id, direction);
      setRelations((prev) => [...prev, created]);
      // A card with no relations renders collapsed, so the first one added
      // would otherwise land in a hidden list and read as a silent failure.
      setOpen(true);
      if (countsAsBlocker(created)) onBlockerCountChange(1);
    } catch (err) {
      setActionError(errorCopy(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (rel: CardRelation) => {
    setActionError(null);
    try {
      await deleteCardRelation(board.id, card.id, rel.id);
      setRelations((prev) => prev.filter((r) => r.id !== rel.id));
      // An archived blocker was never counted, so removing it must not
      // decrement — see the archived filter in _active_blockers_prefetch().
      if (countsAsBlocker(rel)) onBlockerCountChange(-1);
    } catch {
      setActionError("Could not remove the relation. Try again.");
    }
  };

  // A reader with nothing to read gets no section at all — not a header, not a
  // divider. Rendering a header while a fetch resolves and then removing it is
  // worse than a section that appears late.
  if (!canEdit && (loading || loadError || relations.length === 0)) return null;

  return (
    <>
      <div>
        <button
          className="flex items-center justify-between w-full mb-2 group/rel focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Relations
            {relations.length > 0 && (
              <span className="ml-1.5 normal-case font-normal text-fg-muted">
                ({relations.length})
              </span>
            )}
          </p>
          <svg
            className={`w-3.5 h-3.5 text-fg-faint group-hover/rel:text-fg-tertiary transition-transform ${open ? "" : "-rotate-90"}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <div className="flex flex-col gap-3">
          {/* Collapsing hides the rows, never the controls. An empty section
              collapses itself, and if the add button went with it the only way
              to create the first relation would be to expand an empty section
              first — the same reason the Checklist add row sits outside its own
              open gate. */}
          {open && (
            <>
              {loading && <p className="text-sm text-fg-tertiary">Loading relations…</p>}

              {loadError && (
                <p className="text-sm text-danger">
                  Failed to load relations.
                  <button
                    onClick={load}
                    className="text-xs text-info hover:underline font-medium ml-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                  >
                    Retry
                  </button>
                </p>
              )}

              {!loading && !loadError && (
                <>
                  {GROUPS.map(({ direction, label }) => {
                    const rows = relations.filter((r) => r.direction === direction);
                    if (rows.length === 0) return null;
                    return (
                      <div key={direction}>
                        <p className="text-xs text-fg-tertiary mb-1">{label}</p>
                        <div className="flex flex-col gap-0.5">
                          {rows.map((rel) => (
                            <RelationRow
                              key={rel.id}
                              rel={rel}
                              columnName={columnName(rel.card.column)}
                              canEdit={canEdit}
                              onRemove={() => handleRemove(rel)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}

                  {relations.length === 0 && canEdit && (
                    <p className="text-xs text-fg-faint italic">No relations yet.</p>
                  )}
                </>
              )}
            </>
          )}

          {/* Hidden while the list failed to load: the picker's duplicate and
              cycle exclusions are computed from the loaded relations, so
              offering an add flow that cannot dedupe would push those errors
              onto a server round trip for no reason. */}
          {canEdit && !loadError &&
            (addOpen ? (
              <RelationCardPicker
                boardId={board.id}
                columns={board.columns}
                currentCardId={card.id}
                existing={relations}
                submitting={submitting}
                onSelect={handleSelect}
                onCancel={() => {
                  setAddOpen(false);
                  setActionError(null);
                  addButtonRef.current?.focus();
                }}
              />
            ) : (
              <button
                ref={addButtonRef}
                onClick={() => setAddOpen(true)}
                className="text-xs text-fg-muted hover:text-fg-secondary border border-dashed border-line-strong hover:border-line-emphasis rounded px-2.5 py-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis self-start"
              >
                + Add relation
              </button>
            ))}

          {/* Reserved status line — always present so a message appearing does
              not shift the sections below it. */}
          {canEdit && !loadError && (
            <p className="text-xs h-4">
              {actionError && <span className="text-danger">{actionError}</span>}
            </p>
          )}
        </div>
      </div>
      <div className="border-t border-line" />
    </>
  );
}

function RelationRow({
  rel,
  columnName,
  canEdit,
  onRemove,
}: {
  rel: CardRelation;
  columnName: string;
  canEdit: boolean;
  onRemove: () => void;
}) {
  const remove = canEdit ? (
    <button
      onClick={onRemove}
      className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
      title="Remove relation"
      aria-label={`Remove relation to ${rel.card.title}`}
    >
      ✕
    </button>
  ) : null;

  if (rel.card.archived) {
    // No navigation affordance: `visiban:open-card` resolves against the
    // board's active cards, so a click would be a silent no-op. The ✕ stays —
    // removing the relation is the expected action on an archived row.
    return (
      <div
        className="flex items-center gap-2 group px-1 py-0.5 rounded hover:bg-surface-hover"
        title="Archived — this relation no longer counts toward the blocked indicator"
      >
        <span className="text-sm flex-1 min-w-0 truncate line-through text-fg-faint">
          {rel.card.title}
        </span>
        <span className="text-xs text-fg-faint shrink-0">Archived</span>
        {remove}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group px-1 py-0.5 rounded hover:bg-surface-hover">
      <button
        type="button"
        // BoardView owns the listener; panels replace rather than stack.
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("visiban:open-card", { detail: { cardId: rel.card.id } }),
          )
        }
        className="text-sm text-fg-secondary hover:text-fg flex-1 min-w-0 truncate text-left transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        title={rel.card.title}
      >
        {rel.card.title}
      </button>
      <span className="text-xs text-fg-muted shrink-0 max-w-[8rem] truncate" title={columnName}>
        {columnName}
      </span>
      {remove}
    </div>
  );
}
