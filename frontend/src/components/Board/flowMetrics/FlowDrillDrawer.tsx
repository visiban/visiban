import { useEffect, useRef, useState } from "react";
import { getCardMovements } from "../../../api/cards";
import { useEscapeStack } from "../../../hooks/useEscapeStack";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type { CardMovement, FlowCard } from "../../../types";
import { formatDate, formatDays, pluralize } from "./flowFormat";

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
      /** Cards the response counted but did not list (#2429: a capped period). */
      more?: number;
      failed?: boolean;
      /** Why it failed, when the server said (#2428); the generic line otherwise. */
      failedMessage?: string;
      onRetry?: () => void;
    }
  | {
      /** One column's cards, oldest first (#2262): the flow row and the bottleneck panel open this. */
      kind: "column";
      uid: string;
      name: string;
      limit: number | null;
      count: number;
      medianWait: number | null;
      /** Cards in the column older than the 85th percentile of cycle time; null when the server withholds it. */
      pastP85: number | null;
      /** Cards with an age left out of `cards` because the Overview downsamples a large column (#2429). */
      notSampled?: number;
      cards: ColumnDrillCard[];
    };

/** A card in a column drawer: its days in progress, blocked state and time by column. */
export interface ColumnDrillCard {
  uid: string;
  days: number;
  /** Days spent in this column so far. */
  inColumnDays: number;
  blocked: boolean;
  blockedDays: number;
  dwell: DrillDwell[];
}

const COLUMN_PREVIEW = 5;

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

function cardFacts(card: ColumnDrillCard, name: string): DrillFact[] {
  return [
    { label: "Days in progress", value: formatDays(card.days) },
    { label: `In ${name}`, value: formatDays(card.inColumnDays) },
    { label: "Blocked time", value: formatDays(card.blockedDays) },
    ...(card.blocked ? [{ label: "Now", value: "Blocked" }] : []),
  ];
}

function ColumnBody({
  selection, cards, onChange, onOpenCard, onClose,
}: {
  selection: Extract<DrillSelection, { kind: "column" }>;
  cards: Map<string, FlowCard>;
  onChange: (selection: DrillSelection) => void;
  onOpenCard?: (cardId: number) => void;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const firstRevealed = useRef<HTMLButtonElement>(null);
  // "Show N more" unmounts on click; hand focus to the first newly revealed row so it stays inside the drawer.
  useEffect(() => {
    if (showAll) firstRevealed.current?.focus();
  }, [showAll]);
  const [oldest, ...rest] = selection.cards;
  const shown = showAll ? rest : rest.slice(0, COLUMN_PREVIEW);
  const oldestCard = oldest ? cards.get(oldest.uid) : undefined;
  const longest = oldest ? Math.max(0, ...oldest.dwell.map((d) => d.days)) : 0;
  const figures: [string, string][] = [
    ["In column", selection.limit !== null ? `${selection.count} of ${selection.limit}` : String(selection.count)],
    ["Median wait", selection.medianWait !== null ? formatDays(selection.medianWait) : "—"],
    ["Past 85th percentile", selection.pastP85 !== null ? String(selection.pastP85) : "—"],
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-3 gap-2">
        {figures.map(([label, value]) => (
          <div key={label} className="bg-sunken border border-line rounded-lg p-2 flex flex-col gap-0.5 min-w-0">
            <dt className="text-xs text-fg-tertiary">{label}</dt>
            <dd className="font-mono text-base text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      {oldest && (
        <section aria-label="Oldest card" className="bg-sunken border border-line rounded-lg p-3 flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-fg min-w-0 truncate">{oldestCard?.title ?? oldest.uid}</span>
            <span className="font-mono text-sm text-fg-secondary shrink-0">{formatDays(oldest.days)}</span>
          </div>
          {/* break-words: a lane name with no spaces must not overflow the drawer. `swimlane?` guards a
              response from an API older than #2283 during a rolling deploy. */}
          <span className="text-xs text-fg-tertiary min-w-0 break-words">
            {[ownerName(oldestCard), oldestCard?.swimlane?.name, oldest.blocked ? "Blocked now" : null].filter(Boolean).join(" · ")}
          </span>
          <div className="flex flex-col gap-1" role="group" aria-label="Time by column">
            {oldest.dwell.map((entry, index) => (
              <div key={`${entry.name}-${index}`} className="grid grid-cols-[6rem_1fr_3.5rem] items-center gap-2 text-xs">
                <span className={`truncate ${entry.name === selection.name ? "font-semibold text-fg" : "text-fg-secondary"}`} title={entry.name}>{entry.name}</span>
                <span className="h-2 rounded-sm bg-surface-hover" aria-hidden="true">
                  <span
                    className="block h-2 rounded-sm bg-primary-emphasis"
                    style={{ width: `${longest > 0 ? (entry.days / longest) * 100 : 0}%` }}
                  />
                </span>
                <span className="font-mono text-right text-fg-secondary">{formatDays(entry.days)}</span>
              </div>
            ))}
          </div>
          <p className="text-sm text-fg-secondary">
            {formatDays(oldest.inColumnDays)} of its {formatDays(oldest.days)} in progress {Number(oldest.inColumnDays.toFixed(1)) === 1 ? "was" : "were"} spent in {selection.name}.
          </p>
          {oldestCard && onOpenCard && !oldestCard.archived && (
            <div>
              <button
                type="button"
                onClick={() => { onClose(); onOpenCard(oldestCard.id); }}
                className="px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Open card
              </button>
            </div>
          )}
        </section>
      )}
      {rest.length > 0 && (
        <section aria-label="Other cards, oldest first" className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">Oldest first</h3>
          <ul className="flex flex-col">
            {shown.map((card, rowIndex) => (
              <li key={card.uid}>
                <button
                  type="button"
                  ref={rowIndex === COLUMN_PREVIEW ? firstRevealed : undefined}
                  onClick={() => onChange({ kind: "card", uid: card.uid, facts: cardFacts(card, selection.name), dwell: card.dwell, back: selection })}
                  className="group w-full flex items-baseline justify-between gap-3 px-2 py-1.5 text-left text-sm rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <span className="text-fg-secondary min-w-0 truncate">{cards.get(card.uid)?.title ?? card.uid}</span>
                  <span className="font-mono text-xs text-fg-tertiary group-hover:text-fg-secondary shrink-0">{formatDays(card.days)}</span>
                </button>
              </li>
            ))}
          </ul>
          {!showAll && rest.length > COLUMN_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="self-start text-sm text-info rounded px-2 py-1 hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Show {rest.length - COLUMN_PREVIEW} more
            </button>
          )}
        </section>
      )}
      {selection.count === 0 && <p className="text-xs text-fg-tertiary">No cards in this column now.</p>}
      {/* The count is every card in the column (#2287); only cards with an age are listed. */}
      {(selection.notSampled ?? 0) > 0 && (
        <p className="text-xs text-fg-tertiary">
          {pluralize(selection.notSampled ?? 0, "more card")} not listed: a large column shows a sample, the oldest always included.
        </p>
      )}
      {selection.count > selection.cards.length + (selection.notSampled ?? 0) && (
        <p className="text-xs text-fg-tertiary">
          {pluralize(selection.count - selection.cards.length - (selection.notSampled ?? 0), "card")} not listed: no age yet (not started, or missing history).
        </p>
      )}
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
        {selection.failedMessage ?? "Failed to load these cards."}{" "}
        {selection.onRetry && (
          <button
            type="button"
            onClick={selection.onRetry}
            className="underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        )}
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
                  className="group w-full flex items-baseline justify-between gap-3 px-2 py-1.5 text-left text-sm rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <span className="text-fg-secondary min-w-0 truncate">{cards.get(uid)?.title ?? uid}</span>
                  <span className="text-xs text-fg-tertiary group-hover:text-fg-secondary shrink-0">{ownerName(cards.get(uid))}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {(selection.more ?? 0) > 0 && (
        <p className="text-xs text-fg-tertiary">{pluralize(selection.more ?? 0, "more card")} not listed.</p>
      )}
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
  const title = selection.kind === "cards" ? selection.title
    : selection.kind === "column" ? selection.name
      : (card?.title ?? selection.uid);
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
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-fg truncate" title={title}>{title}</h2>
            {selection.kind === "column" && (
              <p className="text-xs text-fg-tertiary">
                {pluralize(selection.count, "card")} in this column now{selection.limit !== null ? `, limit ${selection.limit}` : ""}
              </p>
            )}
          </div>
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
          {selection.kind === "column" ? (
            <ColumnBody selection={selection} cards={cards} onChange={onChange} onOpenCard={onOpenCard} onClose={onClose} />
          ) : selection.kind === "card" ? (
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
