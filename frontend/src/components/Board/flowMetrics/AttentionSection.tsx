import { useState } from "react";
import type { FlowAttention } from "../../../types";
import { PanelPlaceholder } from "./FlowChartPanels";
import type { Result } from "./useAnalyticsOverviewData";

const STALLED_PAGE_SIZE = 25;

interface Props {
  /** Undefined until the first answer. */
  attention: Result<FlowAttention> | undefined;
  swimlanes: { id: number; name: string }[];
  onOpenCard?: (cardId: number) => void;
}

/**
 * Region 8, right (#2261): today's stalled-cards table, now built from
 * `metrics/attention` so the page's filters apply to it. #2263 replaces it
 * with "Needs attention".
 */
export default function AttentionSection({ attention, swimlanes, onOpenCard }: Props) {
  const data = attention?.data;
  return data
    ? <StalledTable data={data} swimlanes={swimlanes} onOpenCard={onOpenCard} />
    : <PanelPlaceholder title="Stalled cards" failed={attention?.error !== undefined} height="h-24" />;
}

function StalledTable({ data, swimlanes, onOpenCard }: Omit<Props, "attention"> & { data: FlowAttention }) {
  const [requestedPage, setPage] = useState(1);
  const threshold = data.stalled_threshold_days;
  const lanes = new Map(swimlanes.map((s) => [s.id, s.name]));
  const cards = new Map(data.cards.map((c) => [c.uid, c]));
  const allStalled = data.items
    .filter((item) => item.reasons.includes("stalled"))
    .map((item) => ({
      uid: item.card_uid,
      id: cards.get(item.card_uid)?.id ?? null,
      title: cards.get(item.card_uid)?.title ?? item.card_uid,
      swimlane: lanes.get(item.swimlane_id) ?? "",
      days_since_move: item.unmoved_days ?? 0,
    }));
  const sorted = [...allStalled].sort((a, b) => b.days_since_move - a.days_since_move);
  const totalPages = Math.max(1, Math.ceil(sorted.length / STALLED_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const pageRows = sorted.slice((page - 1) * STALLED_PAGE_SIZE, page * STALLED_PAGE_SIZE);
  const open = (id: number | null) => { if (id !== null) onOpenCard?.(id); };
  const onPageChange = setPage;
  return (
    <section aria-labelledby="analytics-stalled-heading" className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-2 min-w-0" data-testid="analytics-attention">
      <div className="flex items-center gap-2">
        <h2 id="analytics-stalled-heading" className="text-sm font-semibold text-fg">
          Stalled cards (&gt;{threshold} days without movement)
        </h2>
        <span className="text-xs text-fg-tertiary">
          {allStalled.length} {allStalled.length === 1 ? "card" : "cards"} stalled
        </span>
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-fg-tertiary">No card in progress has gone that long without moving.</p>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse" aria-label="Stalled cards">
          <thead>
            <tr className="text-left text-xs text-fg-muted uppercase tracking-wider border-b border-line">
              <th className="pb-2 pr-4 font-medium sticky left-0 bg-surface w-32">Swimlane</th>
              <th className="pb-2 px-3 font-medium">Card</th>
              <th className="pb-2 px-3 font-medium text-right w-28">Days stalled</th>
              {onOpenCard && <th className="pb-2 pl-3 font-medium w-8" />}
            </tr>
          </thead>
          <tbody>
            {pageRows.map(c => (
              <tr
                key={c.uid}
                className={`border-b border-line transition ${onOpenCard ? "hover:bg-surface-hover cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis" : ""}`}
                onClick={() => open(c.id)}
                // Keyboard parity for the row click (#1376): a tab stop only when the row is actionable.
                tabIndex={onOpenCard ? 0 : undefined}
                onKeyDown={onOpenCard ? (e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(c.id); }
                } : undefined}
              >
                <td className="py-1.5 pr-4 text-xs text-fg-tertiary sticky left-0 bg-surface max-w-[8rem] truncate" title={c.swimlane}>
                  {c.swimlane}
                </td>
                <td className="py-1.5 px-3 text-fg-secondary max-w-[24rem] truncate" title={c.title}>
                  {c.title}
                </td>
                <td className="py-1.5 px-3 text-right font-mono text-warning font-medium text-xs">
                  {c.days_since_move}d
                </td>
                {onOpenCard && (
                  <td className="py-1.5 pl-3 text-fg-muted text-xs text-center">↗</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-fg-muted">
            {(page - 1) * STALLED_PAGE_SIZE + 1}–{Math.min(page * STALLED_PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2 py-1 text-xs rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              ← Prev
            </button>
            <span className="text-xs text-fg-muted px-2">{page} / {totalPages}</span>
            <button
              onClick={() => onPageChange(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-2 py-1 text-xs rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
