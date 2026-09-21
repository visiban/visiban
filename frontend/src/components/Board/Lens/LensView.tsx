import { useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import Spinner from "../../Common/Spinner";
import { useLensData } from "../../../hooks/useLensData";
import { useLensViewPrefs } from "../../../hooks/useLensViewPrefs";
import { useEscapeStack } from "../../../hooks/useEscapeStack";
import type { LensConnection } from "../../../types";
import type { CardLayout } from "../../../hooks/useCardLayoutPref";
import LensGrid from "./LensGrid";
import LensFocusBanner from "./LensFocusBanner";
import LensFilterBar, { type LensState } from "./LensFilterBar";
import LensProvenanceBanner from "./LensProvenanceBanner";
import {
  COLUMN_DIM_KEYS,
  SWIMLANE_DIM_KEYS,
  lensFilterActiveCount,
  parseLensLabels,
  serializeLensLabels,
} from "./lensDims";

interface Props {
  boardId: number;
  connection: LensConnection;
  /** Shared with the board's card-layout pref — "compact" = multi-card-per-row. */
  cardLayout: CardLayout;
  /** Filter-row visibility (toggled by the Filters button on the shared Row 2). */
  showFilters: boolean;
}

/**
 * Read-only "Lens" board view. Renders one public GitHub/GitLab repo's issues as
 * a configurable 2D pivot. The pivot/filter controls live on the shared Row-2
 * toolbar (LensToolbar, in BoardView); this component owns the data fetch, the
 * banners, the filter row, and the grid. Pivot/filter values are read from the
 * URL (?column_dim=&swimlane_dim=&state=&milestone=&q=).
 */
export default function LensView({ boardId, connection, cardLayout, showFilters }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const compact = cardLayout === "compact";

  // Ad-hoc pivot overrides from the URL, validated against the accepted dims.
  // A missing or invalid param falls back to the saved connection default.
  const rawColumnDim = searchParams.get("column_dim");
  const rawSwimlaneDim = searchParams.get("swimlane_dim");
  const columnDim =
    rawColumnDim && COLUMN_DIM_KEYS.has(rawColumnDim) ? rawColumnDim : connection.column_dim;
  const swimlaneDim =
    rawSwimlaneDim && SWIMLANE_DIM_KEYS.has(rawSwimlaneDim) ? rawSwimlaneDim : connection.swimlane_dim;

  // Filters. State, milestone, label and assignee are server-side (they flow into
  // the fetch, so they reach issues outside the fetch budget); text (q) is
  // client-side over the fetched set. All URL-persisted like the pivot.
  const rawState = searchParams.get("state");
  const stateFilter: LensState = rawState === "open" || rawState === "closed" ? rawState : "all";
  const milestone = searchParams.get("milestone") ?? "";
  // Canonicalized on read, exactly as the server canonicalizes it, so a hand-edited
  // or reordered shared link lands on the same cache key as the UI would produce.
  const labelsCsv = serializeLensLabels(parseLensLabels(searchParams.get("labels")));
  const labels = useMemo(() => parseLensLabels(labelsCsv), [labelsCsv]);
  const assignee = (searchParams.get("assignee") ?? "").trim();
  const q = searchParams.get("q") ?? "";

  // Resizable sidebar/columns view state (#1065) — board-scoped localStorage,
  // separate from the URL-persisted pivot/filter/collapse/focus state above
  // (a resize is per-device chrome, not something worth sharing via link).
  const { prefs: lensViewPrefs, setSidebarWidth, setColumnWidth } = useLensViewPrefs(boardId);

  const { data, error, loading, refetching, refresh } = useLensData(boardId, {
    columnDim,
    swimlaneDim,
    filters: {
      state: stateFilter === "all" ? undefined : stateFilter,
      milestone: milestone || undefined,
      labels,
      assignee: assignee || undefined,
    },
  });

  // Autocomplete suggestions for the label/assignee controls, derived from the
  // fetched issues rather than a new response field — every issue already carries
  // its labels and assignees, so this costs nothing and spends no permanent API
  // contract surface on something already derivable.
  //
  // Accumulated across fetches on purpose. Label filtering is SERVER-SIDE, so once
  // you filter to label X the response contains only issues carrying X — deriving
  // the options from just the current response would collapse the menu to the
  // labels already selected and make it impossible to add a second one. Keeping the
  // union of everything seen this session (plus whatever is currently selected, so
  // a filter arriving from a shared link is always listed) keeps the control usable.
  //
  // The memo below mutates this ref, which is a deliberate exception to useMemo
  // purity: accumulation has to survive the memo being recomputed, and the only
  // mutation is Set.add, which is idempotent — so Strict Mode's double invocation
  // and an abandoned concurrent render both cost a wasted add() and change nothing.
  // Do NOT copy this shape for a non-idempotent mutation; use an effect instead.
  // Growth is bounded by the distinct label/assignee cardinality of the one repo
  // this view is scoped to, and the ref dies with the component.
  const suggestionsRef = useRef({ labels: new Set<string>(), assignees: new Set<string>() });
  const { availableLabels, availableAssignees } = useMemo(() => {
    const acc = suggestionsRef.current;
    for (const issue of data?.issues ?? []) {
      for (const label of issue.labels) acc.labels.add(label.name);
      for (const user of issue.assignees) if (user.username) acc.assignees.add(user.username);
    }
    for (const label of parseLensLabels(labelsCsv)) acc.labels.add(label);
    if (assignee) acc.assignees.add(assignee);
    return {
      availableLabels: Array.from(acc.labels).sort(),
      availableAssignees: Array.from(acc.assignees).sort(),
    };
  }, [data, labelsCsv, assignee]);

  // Collapse/focus are properties of the shared link → URL params (validated
  // against live data so a key stale after a re-pivot or truncation is ignored).
  const laneKeys = useMemo(
    () => new Set((data?.swimlanes ?? []).map((s) => s.key)),
    [data],
  );
  const rawFocus = searchParams.get("lens_focus");
  const focusKey = rawFocus && laneKeys.has(rawFocus) ? rawFocus : null;
  // "*" is the collapse-all sentinel set by the Row-2 Collapse button (which has
  // no lane keys); resolve it here against the live keys.
  //
  // The sentinel is deliberately open-ended: it means "every lane", not "the lanes
  // that existed when you clicked". So a milestone that appears upstream after a
  // refresh arrives collapsed, which is what someone who chose Collapse all and
  // shared the link expects. Toggling any single lane writes the concrete key list
  // and drops that property.
  const collapsedKeys = useMemo(() => {
    const raw = searchParams.get("lens_collapsed");
    if (raw === "*") return new Set(laneKeys);
    if (!raw) return new Set<string>();
    return new Set(raw.split(",").map(decodeURIComponent).filter((k) => laneKeys.has(k)));
  }, [searchParams, laneKeys]);

  const toggleCollapse = (key: string) => {
    setSearchParams((prev) => {
      const raw = prev.get("lens_collapsed");
      // Filter against the LIVE lane keys, exactly as the read path above does.
      // Without this, keys left in the URL for lanes that no longer exist (after a
      // re-pivot, or after a filter shrank the lane set) still count toward
      // `cur.size`, so the `>= laneKeys.size` normalization below can trip while
      // real lanes are still expanded — collapsing the whole board on a single
      // lane toggle.
      const cur = raw === "*"
        ? new Set(laneKeys)
        : new Set(
            (raw?.split(",").map(decodeURIComponent) ?? []).filter((k) => laneKeys.has(k)),
          );
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);
      if (cur.size === 0) prev.delete("lens_collapsed");
      else if (cur.size >= laneKeys.size) prev.set("lens_collapsed", "*"); // normalize "all" → sentinel
      else prev.set("lens_collapsed", Array.from(cur).map(encodeURIComponent).join(","));
      return prev;
    }, { replace: true });
  };
  const enterFocus = (key: string) =>
    setSearchParams((prev) => { prev.set("lens_focus", key); return prev; }, { replace: true });
  const exitFocus = () =>
    setSearchParams((prev) => { prev.delete("lens_focus"); return prev; }, { replace: true });

  // Priority 12 mirrors the native board's focus-exit slot (the board and lens
  // are sibling tab views, never mounted together).
  useEscapeStack(() => {
    if (!focusKey) return false;
    exitFocus();
  }, 12);

  const setStateFilter = (next: LensState) =>
    setSearchParams((prev) => {
      if (next === "all") prev.delete("state");
      else prev.set("state", next);
      return prev;
    }, { replace: true });
  const setMilestone = (next: string) =>
    setSearchParams((prev) => {
      if (next) prev.set("milestone", next);
      else prev.delete("milestone");
      return prev;
    }, { replace: true });
  const setLabels = (next: string[]) =>
    setSearchParams((prev) => {
      // Serialize through the shared canonicalizer (sorted, deduped, capped) so the
      // URL — and therefore the server's cache key — is stable regardless of the
      // order the boxes were ticked in.
      const csv = serializeLensLabels(next);
      if (csv) prev.set("labels", csv);
      else prev.delete("labels");
      return prev;
    }, { replace: true });
  const setAssignee = (next: string) =>
    setSearchParams((prev) => {
      const value = next.trim();
      if (value) prev.set("assignee", value);
      else prev.delete("assignee");
      return prev;
    }, { replace: true });
  const setQ = (next: string) =>
    setSearchParams((prev) => {
      if (next) prev.set("q", next);
      else prev.delete("q");
      return prev;
    }, { replace: true });
  const clearFilters = () =>
    setSearchParams((prev) => {
      prev.delete("state");
      prev.delete("milestone");
      prev.delete("labels");
      prev.delete("assignee");
      prev.delete("q");
      return prev;
    }, { replace: true });

  // Shared with the Row-2 Filters badge (LensToolbar) — one implementation so the
  // badge and the row can never disagree about how many filters are active.
  const activeCount = lensFilterActiveCount(searchParams);
  const filtersActive =
    stateFilter !== "all" || milestone !== "" || labels.length > 0 || assignee !== "";

  // Client-side text filter over the fetched set (title substring / number prefix).
  const filteredData = useMemo(() => {
    if (!data) return null;
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    if (!needle) return data;
    const issues = data.issues.filter(
      (i) => i.title.toLowerCase().includes(needle) || String(i.number).startsWith(needle),
    );
    return { ...data, issues };
  }, [data, q]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter row — toggled by the Filters button on the shared Row 2; shown
          above the banners (inputs then status). */}
      {data && showFilters && (
        <LensFilterBar
          state={stateFilter}
          milestone={milestone}
          labels={labels}
          assignee={assignee}
          q={q}
          availableMilestones={data.available_milestones}
          availableLabels={availableLabels}
          availableAssignees={availableAssignees}
          activeCount={activeCount}
          onStateChange={setStateFilter}
          onMilestoneChange={setMilestone}
          onLabelsChange={setLabels}
          onAssigneeChange={setAssignee}
          onQChange={setQ}
          onClear={clearFilters}
        />
      )}

      {/* Provenance banner (now hosts the freshness control) — outside the grid
          scroll container so it never scrolls away. */}
      {data && (
        <LensProvenanceBanner
          provider={data.source.provider}
          repo={data.source.repo}
          url={data.source.url}
          truncated={data.truncated}
          shownCount={data.issues.length}
          filtersActive={filtersActive}
          fetchedAt={data.fetched_at}
          refetching={refetching}
          onRefresh={refresh}
        />
      )}

      {/* Focus banner stacks below provenance (source → mode), both outside the
          grid scroll container so neither scrolls away. */}
      {data && focusKey && (
        <LensFocusBanner
          label={data.swimlanes.find((s) => s.key === focusKey)?.label ?? focusKey}
          onExit={exitFocus}
        />
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="lg" label="Loading issues" />
        </div>
      ) : error && !data ? (
        <LensErrorState error={error} onRetry={refresh} provider={connection.provider} />
      ) : filteredData ? (
        <LensGrid
          data={filteredData}
          collapsedKeys={collapsedKeys}
          focusKey={focusKey}
          onToggleCollapse={toggleCollapse}
          onFocus={enterFocus}
          onExitFocus={exitFocus}
          compact={compact}
          sidebarWidth={lensViewPrefs.sidebarWidth}
          columnWidths={lensViewPrefs.columnWidths}
          onResizeSidebar={setSidebarWidth}
          onResizeColumn={setColumnWidth}
        />
      ) : null}
    </div>
  );
}

function LensErrorState({
  error,
  onRetry,
  provider,
}: {
  error: { code: string; detail: string };
  onRetry: () => void;
  provider: LensConnection["provider"];
}) {
  const providerName = provider === "github" ? "GitHub" : "GitLab";

  let heading: string;
  let body: React.ReactNode;
  if (error.code === "auth_required") {
    heading = `Connect your ${providerName} account`;
    body = (
      <>
        <p className="text-sm text-fg-tertiary">
          This lens reads issues using your own {providerName} connection.
        </p>
        <a
          href="/settings/account"
          className="text-sm text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Manage connected accounts
        </a>
      </>
    );
  } else if (error.code === "rate_limited") {
    heading = "Rate limited";
    body = <p className="text-sm text-fg-tertiary">{providerName} is rate-limiting requests. Try again shortly.</p>;
  } else if (error.code === "repo_not_found") {
    heading = "Repository not found";
    body = (
      <p className="text-sm text-fg-tertiary">
        {error.detail || "The configured repository could not be found. Check the lens settings."}
      </p>
    );
  } else {
    heading = "Could not load the lens";
    body = (
      <p className="text-sm text-fg-tertiary">
        {error.detail || "Something went wrong fetching issues from the provider."}
      </p>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-4">
      <span className="text-2xl text-fg-faint" aria-hidden="true">⚠</span>
      <h3 className="text-fg-tertiary text-sm font-medium">{heading}</h3>
      <div className="flex flex-col items-center gap-1">{body}</div>
      <button
        type="button"
        onClick={onRetry}
        className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        Try again
      </button>
    </div>
  );
}
