import { useState } from "react";
import type { FlowAttention, FlowAttentionItem } from "../../../types";
import { PanelPlaceholder } from "./FlowChartPanels";
import type { Result } from "./useAnalyticsOverviewData";

const PREVIEW_ROWS = 5;
const PAGE_SIZE = 25;

interface Props {
  /** Undefined until the first answer. */
  attention: Result<FlowAttention> | undefined;
  swimlanes: { id: number; name: string }[];
  /** Board columns, to turn an item's `column_uid` into a name. */
  columns?: { uid: string; name?: string }[];
  onOpenCard?: (cardId: number) => void;
}

const days = (n: number) => `${Math.round(n)} ${Math.round(n) === 1 ? "day" : "days"}`;

/** The reason line: every reason the card qualifies for, in the service's order. */
function reasonText(item: FlowAttentionItem, p85: number | null, stalledDays: number | null): string {
  return item.reasons
    .map((r) => {
      if (r === "blocked") return "blocked";
      if (r === "past_p85") return p85 !== null ? `past ${days(p85)}` : "past the 85th percentile";
      return stalledDays !== null ? `no movement for ${days(stalledDays)}` : "no movement";
    })
    .join(", ");
}

/**
 * Region 8, right (#2263): one list of blocked, stalled and long-running cards,
 * oldest first, from `metrics/attention` so the page's filters apply. Five rows
 * show first; "All N cards" expands the list in place, 25 per page.
 */
export default function AttentionSection({ attention, swimlanes, columns = [], onOpenCard }: Props) {
  const data = attention?.data;
  if (!data) return <PanelPlaceholder title="Needs attention" failed={attention?.error !== undefined} height="h-24" />;
  return <NeedsAttention data={data} swimlanes={swimlanes} columns={columns} onOpenCard={onOpenCard} />;
}

function NeedsAttention({ data, swimlanes, columns, onOpenCard }: Omit<Props, "attention"> & { data: FlowAttention; columns: NonNullable<Props["columns"]> }) {
  const [expanded, setExpanded] = useState(false);
  const [requestedPage, setPage] = useState(1);
  const lanes = new Map(swimlanes.map((s) => [s.id, s.name]));
  const colNames = new Map(columns.map((c) => [c.uid, c.name ?? ""]));
  const cards = new Map(data.cards.map((c) => [c.uid, c]));
  const p85 = data.cycle_time_percentiles.p85;
  const age = (i: FlowAttentionItem) => i.age_days ?? i.unmoved_days ?? 0;
  // Membership and order come from one backend service (the spec: #1358 reuses it), so the list
  // renders in the service's order and never re-sorts on the client.
  const sorted = data.items;
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rows = expanded ? sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : sorted.slice(0, PREVIEW_ROWS);

  return (
    <section aria-labelledby="analytics-attention-heading" className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-3 min-w-0" data-testid="analytics-attention">
      <div className="flex items-center justify-between gap-2">
        <h2 id="analytics-attention-heading" className="text-sm font-semibold text-fg">Needs attention</h2>
        {total > PREVIEW_ROWS && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => { setExpanded((e) => !e); setPage(1); }}
            className="text-xs text-info underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {expanded ? "Show fewer" : `All ${total} cards`}
          </button>
        )}
      </div>
      {total === 0 ? (
        <p className="text-sm text-fg-tertiary">No card is blocked, stalled or older than most finished cards.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Cards that need attention">
          {rows.map((item) => {
            const card = cards.get(item.card_uid);
            const title = card?.title ?? item.card_uid;
            const where = [colNames.get(item.column_uid), lanes.get(item.swimlane_id), reasonText(item, p85, item.unmoved_days)]
              .filter(Boolean)
              .join(" · ");
            const pastP85 = item.reasons.includes("past_p85");
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg truncate" title={title}>{title}</span>
                  <span className="block text-xs text-fg-tertiary group-hover:text-fg-secondary truncate" title={where}>{where}</span>
                </span>
                <span aria-label={`${days(age(item))} old`} className={`font-mono text-sm font-semibold shrink-0 ${pastP85 ? "text-danger" : "text-warning"}`}>
                  {Math.round(age(item))}d
                </span>
              </>
            );
            const rowClass = "w-full flex items-center gap-3 rounded-md group border border-line bg-sunken px-3 py-2 text-left";
            const id = card?.id;
            return (
              <li key={item.card_uid}>
                {onOpenCard && id !== undefined ? (
                  <button
                    type="button"
                    onClick={() => onOpenCard(id)}
                    className={`${rowClass} hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={rowClass}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {expanded && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-tertiary">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-2 py-1 text-xs rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              ← Prev
            </button>
            <span className="text-xs text-fg-tertiary px-2">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="px-2 py-1 text-xs rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Next →
            </button>
          </div>
        </div>
      )}
      <p className="text-xs text-fg-tertiary">One list for blocked, stalled and long-running cards, oldest first.</p>
    </section>
  );
}
