import { useEffect, useRef, useState } from "react";
import { getCardMovements } from "../../../api/cards";
import { useEscapeStack } from "../../../hooks/useEscapeStack";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type { CardMovement, FlowCard } from "../../../types";
import { formatDate, formatDays } from "./flowFormat";

export interface DrillFact {
  label: string;
  value: string;
}

export interface DrillDwell {
  name: string;
  days: number;
}

/** What the drawer shows: one card, or the cards behind a point. */
export type DrillSelection =
  | {
      kind: "card";
      uid: string;
      facts: DrillFact[];
      dwell?: DrillDwell[];
      /** The list this card was opened from. */
      back?: DrillSelection;
    }
  | {
      kind: "cards";
      title: string;
      /** Null while the list is loading. */
      groups: { label: string | null; uids: string[] }[] | null;
      failed?: boolean;
      onRetry?: () => void;
    };

const ownerName = (card: FlowCard | undefined) =>
  card?.assignee ? card.assignee.display_name || card.assignee.username : "Unassigned";

function transitionText(movement: CardMovement) {
  if (movement.movement_type === "archived") return `Archived in ${movement.to_column_name || "a deleted column"}`;
  if (movement.movement_type === "unarchived") return `Restored in ${movement.to_column_name || "a deleted column"}`;
  if (!movement.from_column_name) return `Created in ${movement.to_column_name || "a deleted column"}`;
  if (movement.from_column_name === movement.to_column_name) return `Changed swimlane in ${movement.to_column_name}`;
  return `${movement.from_column_name} → ${movement.to_column_name || "a deleted column"}`;
}

/** The card's transitions, oldest first, from the existing card movements endpoint. */
function Transitions({ boardId, card }: { boardId: number; card: FlowCard }) {
  const [movements, setMovements] = useState<CardMovement[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setMovements(null);
    setFailed(false);
    getCardMovements(boardId, card.id)
      .then((rows) => { if (current) setMovements([...rows].reverse()); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [boardId, card.id, attempt]);

  if (failed) {
    return (
      <p className="text-sm text-danger" role="alert">
        Failed to load transitions.{" "}
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Retry
        </button>
      </p>
    );
  }
  if (!movements) return <p className="text-sm text-fg-tertiary">Loading transitions…</p>;
  if (movements.length === 0) return <p className="text-xs text-fg-tertiary">No recorded transitions.</p>;
  return (
    <ol className="flex flex-col gap-1 text-sm" aria-label="Transitions">
      {movements.map((movement) => (
        <li key={movement.id} className="flex items-baseline justify-between gap-3">
          <span className="text-fg-secondary min-w-0 truncate" title={transitionText(movement)}>{transitionText(movement)}</span>
          <span className="text-xs text-fg-tertiary shrink-0">
            {formatDate(movement.moved_at)}
            {movement.moved_by ? ` · ${movement.moved_by.display_name || movement.moved_by.username}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CardBody({
  boardId, selection, card, onOpenCard, onClose,
}: {
  boardId: number;
  selection: Extract<DrillSelection, { kind: "card" }>;
  card: FlowCard | undefined;
  onOpenCard?: (cardId: number) => void;
  onClose: () => void;
}) {
  const longest = Math.max(0, ...(selection.dwell ?? []).map((d) => d.days));
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-tertiary">Owner</dt>
        <dd className="text-fg-secondary">{ownerName(card)}</dd>
        {selection.facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-fg-tertiary">{fact.label}</dt>
            <dd className="font-mono text-fg-secondary">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {selection.dwell && selection.dwell.length > 0 && (
        <section aria-label="Time per column" className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">Time per column</h3>
          {selection.dwell.map((entry, index) => (
            <div key={`${entry.name}-${index}`} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-2 text-sm">
              <span className="text-fg-secondary truncate" title={entry.name}>{entry.name}</span>
              <span className="h-2 rounded-sm bg-surface-hover" aria-hidden="true">
                <span
                  className="block h-2 rounded-sm bg-primary-emphasis"
                  style={{ width: `${longest > 0 ? (entry.days / longest) * 100 : 0}%` }}
                />
              </span>
              <span className="font-mono text-right text-fg-secondary">{formatDays(entry.days)}</span>
            </div>
          ))}
        </section>
      )}
      {card && (
        <section aria-label="Transitions section" className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">Transitions</h3>
          <Transitions boardId={boardId} card={card} />
        </section>
      )}
      {card && onOpenCard && !card.archived && (
        <div>
          <button
            type="button"
            onClick={() => { onClose(); onOpenCard(card.id); }}
            className="px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Open card
          </button>
        </div>
      )}
      {card?.archived && <p className="text-xs text-fg-tertiary">This card is archived.</p>}
    </div>
  );
}

function CardList({
  selection, cards, onSelectCard,
}: {
  selection: Extract<DrillSelection, { kind: "cards" }>;
  cards: Map<string, FlowCard>;
  onSelectCard: (uid: string) => void;
}) {
  if (selection.failed) {
    return (
      <p className="text-sm text-danger" role="alert">
        Failed to load these cards.{" "}
        <button
          type="button"
          onClick={selection.onRetry}
          className="underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Retry
        </button>
      </p>
    );
  }
  if (!selection.groups) return <p className="text-sm text-fg-tertiary">Loading cards…</p>;
  const groups = selection.groups.filter((group) => group.uids.length > 0);
  if (groups.length === 0) return <p className="text-xs text-fg-tertiary">No cards.</p>;
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.label ?? "cards"} aria-label={group.label ?? "Cards"} className="flex flex-col gap-1">
          {group.label && (
            <h3 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">
              {group.label} <span className="font-mono normal-case">({group.uids.length})</span>
            </h3>
          )}
          <ul className="flex flex-col">
            {group.uids.map((uid) => (
              <li key={uid}>
                <button
                  type="button"
                  onClick={() => onSelectCard(uid)}
                  className="w-full flex items-baseline justify-between gap-3 px-2 py-1.5 text-left text-sm rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <span className="text-fg-secondary min-w-0 truncate">{cards.get(uid)?.title ?? uid}</span>
                  <span className="text-xs text-fg-tertiary shrink-0">{ownerName(cards.get(uid))}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface Props {
  boardId: number;
  selection: DrillSelection;
  cards: Map<string, FlowCard>;
  onChange: (selection: DrillSelection) => void;
  onClose: () => void;
  onOpenCard?: (cardId: number) => void;
}

/** The click-through for every metric: the cards behind a mark, their transitions and owners. */
export default function FlowDrillDrawer({ boardId, selection, cards, onChange, onClose, onOpenCard }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeStack(onClose, 30);
  useFocusTrap(panelRef, true);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const card = selection.kind === "card" ? cards.get(selection.uid) : undefined;
  const title = selection.kind === "cards" ? selection.title : (card?.title ?? selection.uid);
  const back = selection.kind === "card" ? selection.back : undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop: decorative pointer-only dismiss; keyboard parity is Escape + the Close button (#1376) */}
      <div className="absolute inset-0 bg-backdrop/50" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative w-[540px] max-w-full h-full bg-surface border-l border-line shadow-xl flex flex-col outline-none"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-line shrink-0">
          {back && (
            <button
              type="button"
              onClick={() => onChange(back)}
              className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded px-2 py-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              ← Back
            </button>
          )}
          <h2 className="text-sm font-medium text-fg min-w-0 flex-1 truncate" title={title}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded p-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {selection.kind === "card" ? (
            <CardBody boardId={boardId} selection={selection} card={card} onOpenCard={onOpenCard} onClose={onClose} />
          ) : (
            <CardList
              selection={selection}
              cards={cards}
              onSelectCard={(uid) => onChange({ kind: "card", uid, facts: [], back: selection })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
