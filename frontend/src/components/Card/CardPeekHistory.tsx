import { useEffect, useMemo, useState } from "react";
import { getCardTimeline } from "../../api/cards";
import type { CardGateTransition, CardMovement } from "../../types";
import { describeMovement } from "../../utils/cardPeek";
import { gateTransitionLabel } from "../../utils/cardTimelineLabels";
import { formatDateTime } from "../../utils/date";
import { relativeTime } from "../../utils/relativeTime";

/** The most gate rows one timeline page returns (the endpoint's `limit` cap). */
const GATE_PAGE_LIMIT = 200;

interface CardPeekHistoryProps {
  boardId: number;
  cardId: number;
  /** Any change refetches the gate rows, as the sheet refetches its movements. */
  refreshKey: string;
  /** The sheet's movements: null while loading. */
  movements: CardMovement[] | null;
  movementsFailed: boolean;
  userDateFormat: string;
}

type Row = { key: string; ts: string; text: string };

/**
 * The peek sheet's History list: the card's movements plus its moves between
 * sub-columns inside a stage (#2365). Those write a gate transition but no
 * movement, so the movements alone left an in-stage move out of the history.
 * The gate rows come from the timeline's `gate` group, which lists only gates
 * crossed without a movement (a gate crossed by a column move is already on
 * that move's line), so nothing is listed twice.
 */
export default function CardPeekHistory({
  boardId, cardId, refreshKey, movements, movementsFailed, userDateFormat,
}: CardPeekHistoryProps) {
  const [gates, setGates] = useState<CardGateTransition[] | null>(null);
  const [gatesFailed, setGatesFailed] = useState(false);
  const [gateTotal, setGateTotal] = useState(0);

  useEffect(() => {
    let live = true;
    setGatesFailed(false);
    setGateTotal(0);
    getCardTimeline(boardId, cardId, { event_types: "gate", limit: GATE_PAGE_LIMIT })
      .then((page) => {
        if (!live) return;
        setGateTotal(page.count ?? 0);
        setGates(
          page.results
            .filter((e) => e.kind === "gate")
            .map((e) => e.data as unknown as CardGateTransition),
        );
      })
      .catch(() => { if (live) { setGates([]); setGatesFailed(true); } });
    return () => { live = false; };
  }, [boardId, cardId, refreshKey]);

  const rows = useMemo<Row[]>(() => [
    ...(movements ?? []).map((m) => ({ key: `m-${m.id}`, ts: m.moved_at, text: describeMovement(m) })),
    ...(gates ?? []).map((g) => ({ key: `g-${g.id}`, ts: g.created_at, text: gateTransitionLabel(g) })),
  ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()), [movements, gates]);

  if (movements === null || gates === null) {
    return <p className="text-sm text-fg-secondary">Loading history...</p>;
  }
  // The gate rows only enrich the movements, so their failure is soft: the
  // movements still render, with a note. Only a movements failure (or both)
  // replaces the list with the full error.
  if (movementsFailed) {
    return <p className="text-sm text-fg-secondary" role="alert">History could not be loaded.</p>;
  }
  if (gatesFailed && (movements ?? []).length === 0) {
    return <p className="text-sm text-fg-secondary" role="alert">History could not be loaded.</p>;
  }
  const gateRowCount = (gates ?? []).length;
  const notes = (
    <>
      {gatesFailed && (
        <p className="mt-2 text-xs text-fg-tertiary" role="status">Sub-column moves could not be loaded.</p>
      )}
      {!gatesFailed && gateRowCount > 0 && gateTotal > gateRowCount && (
        <p className="mt-2 text-xs text-fg-tertiary">Showing the latest {gateRowCount} sub-column moves</p>
      )}
    </>
  );
  if (rows.length === 0) {
    return <p className="text-sm text-fg-tertiary">No history yet.</p>;
  }
  return (
    <>
    <ul className="space-y-1.5 text-sm" data-testid="card-peek-history">
      {rows.map((r) => (
        <li key={r.key} className="flex justify-between gap-3">
          <span className="text-fg min-w-0 break-words">{r.text}</span>
          <span className="text-fg-secondary shrink-0" title={formatDateTime(r.ts, userDateFormat)}>{relativeTime(Date.parse(r.ts), Date.now())}</span>
        </li>
      ))}
    </ul>
    {notes}
    </>
  );
}
