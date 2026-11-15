import { useRef, useState } from "react";
import type { RefObject } from "react";
import type { FlowFilters } from "../../api/flowMetrics";
import type { Column } from "../../types";
import AnalyticsOverview from "./flowMetrics/AnalyticsOverview";
import { formatDate } from "./flowMetrics/flowFormat";
import { useAnalyticsFilters } from "./flowMetrics/useAnalyticsFilters";

const DAY_MS = 86_400_000;

interface Props {
  boardId: number;
  currentUserRole: string | null;
  /** Called with a card ID when the user opens a card from a panel. */
  onOpenCard?: (cardId: number) => void;
  /** The filter bar's options (#448). */
  swimlanes?: { id: number; name: string }[];
  labels?: { id: number; name: string }[];
  /** The board's columns: WIP limits for the bottleneck panel and tiles (#2261). */
  columns?: (Pick<Column, "uid" | "wip_limit"> & { name?: string })[];
  /** Shown in the title row. */
  boardName?: string;
  /** "Go to board" and "Open on board" switch back to the board. */
  onGoToBoard?: () => void;
}

/** The period in words, in UTC like every bucket: "Aug 16 – Nov 14". */
function periodText({ days }: FlowFilters) {
  const end = Date.now();
  return `${formatDate(end - days * DAY_MS)} – ${formatDate(end)}`;
}

/** Region 1 (#2261): the page title, the Beta badge, the board and the period. */
function AnalyticsTitleRow({ boardName, filters, headingRef }: {
  boardName?: string; filters: FlowFilters; headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
      <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-fg focus:outline-none">Analytics</h1>
      <span className="text-xs font-medium rounded px-1.5 py-0.5 bg-surface text-warning-on-tint ring-1 ring-inset ring-warning/40">
        Beta
      </span>
      <p className="text-sm text-fg-tertiary min-w-0 break-words">
        {boardName && (
          <>
            {boardName}
            <span className="text-fg-faint select-none mx-1" aria-hidden="true">·</span>
            <span className="sr-only">, </span>
          </>
        )}
        {periodText(filters)}
      </p>
    </div>
  );
}

/**
 * The Analytics tab (#448, #2261). It owns the page's one filter selection, so
 * a later Swimlanes view (#2267, a `<nav>` between the title row and the
 * Overview) shares the same Period and Label. One return: the Overview keeps
 * its position whatever any region is doing.
 */
export default function AnalyticsView({
  boardId, currentUserRole, onOpenCard, swimlanes = [], labels = [], columns = [], boardName, onGoToBoard,
}: Props) {
  const { filters, setFilters } = useAnalyticsFilters();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The title row names the period of the numbers on screen, not the live selection (it lags during a refetch).
  const [fetchedFilters, setFetchedFilters] = useState<FlowFilters | null>(null);
  return (
    <div className="flex-1 overflow-y-auto bg-sunken" data-testid="analytics-page">
      <div className="flex flex-col gap-4 p-4 min-w-0">
        <AnalyticsTitleRow boardName={boardName} filters={fetchedFilters ?? filters} headingRef={headingRef} />
        <AnalyticsOverview
          boardId={boardId}
          filters={filters}
          onFiltersChange={setFilters}
          swimlanes={swimlanes}
          labels={labels}
          columns={columns}
          currentUserRole={currentUserRole}
          onOpenCard={onOpenCard}
          onGoToBoard={onGoToBoard}
          headingRef={headingRef}
          onFetchedFilters={setFetchedFilters}
        />
        <p className="text-xs text-fg-tertiary">
          Calendar days in UTC, from each card&apos;s movement history. Filters use each card&apos;s current swimlane
          and labels. Analytics is in beta: data may be incomplete in some configurations, so results are best used as
          directional guidance.
        </p>
      </div>
    </div>
  );
}
