import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FlowFilters } from "../../api/flowMetrics";
import type { Column, CustomFieldDefinition } from "../../types";
import AnalyticsOverview from "./flowMetrics/AnalyticsOverview";
import AnalyticsSwimlanes from "./flowMetrics/AnalyticsSwimlanes";
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
  /** The board's card custom fields: dropdown and checkbox ones are "Break down by" entries (#2268). */
  customFields?: Pick<CustomFieldDefinition, "id" | "name" | "field_type" | "position">[];
  /** Shown in the title row. */
  boardName?: string;
  /** Swimlane custom fields, for the Swimlanes view's "Group lanes by" (#2267). */
  swimlaneFields?: { id: number; name: string }[];
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
  boardId, currentUserRole, onOpenCard, swimlanes = [], labels = [], columns = [], boardName, onGoToBoard, swimlaneFields = [], customFields,
}: Props) {
  const { filters, setFilters } = useAnalyticsFilters();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<"overview" | "swimlanes">("overview");
  // The title row names the period of the numbers on screen, not the live selection (it lags during a refetch).
  const [fetchedFilters, setFetchedFilters] = useState<FlowFilters | null>(null);
  // One update: the Overview mounts already filtered to the lane, never unfiltered first.
  const openSwimlane = useCallback((swimlaneId: number) => {
    setFilters((f) => ({ ...f, swimlaneId }));
    setFetchedFilters(null);
    setView("overview");
  }, [setFilters]);
  return (
    <div className="flex-1 overflow-y-auto bg-page" data-testid="analytics-page">
      <div className="flex flex-col gap-4 p-4 min-w-0">
        <AnalyticsTitleRow boardName={boardName} filters={fetchedFilters ?? filters} headingRef={headingRef} />
        <nav aria-label="Analytics views" className="flex gap-6 border-b border-line">
          {([["overview", "Overview"], ["swimlanes", "Swimlanes"]] as const).map(([id, text]) => (
            <a
              key={id}
              href={`#analytics-${id}`}
              aria-current={view === id ? "page" : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault(); // the view is page state, not a URL
                if (view !== id) { setFetchedFilters(null); setView(id); }
              }}
              className={`px-1 py-2 -mb-px text-sm border-b-2 min-h-6 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded-t ${
                view === id ? "font-semibold text-fg border-primary-emphasis underline underline-offset-4" : "text-fg-secondary border-transparent hover:text-fg"
              }`}
            >
              {text}
            </a>
          ))}
        </nav>
        {view === "swimlanes" ? (
          <AnalyticsSwimlanes
            boardId={boardId}
            filters={filters}
            onFiltersChange={setFilters}
            labels={labels}
            swimlaneFields={swimlaneFields}
            onOpenSwimlane={openSwimlane}
            onFetchedFilters={setFetchedFilters}
          />
        ) : (
        <AnalyticsOverview
          boardId={boardId}
          filters={filters}
          onFiltersChange={setFilters}
          swimlanes={swimlanes}
          labels={labels}
          columns={columns}
          customFields={customFields}
          currentUserRole={currentUserRole}
          onOpenCard={onOpenCard}
          onGoToBoard={onGoToBoard}
          headingRef={headingRef}
          onFetchedFilters={setFetchedFilters}
        />
        )}
        <p className="text-xs text-fg-tertiary">
          Calendar days in UTC, from each card&apos;s movement history. Filters use each card&apos;s current swimlane
          and labels. Analytics is in beta: data may be incomplete in some configurations, so results are best used as
          directional guidance.
        </p>
      </div>
    </div>
  );
}
