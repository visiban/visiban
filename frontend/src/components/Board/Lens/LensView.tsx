import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import Spinner from "../../Common/Spinner";
import { useLensData } from "../../../hooks/useLensData";
import { useEscapeStack } from "../../../hooks/useEscapeStack";
import { useLensDensityPref } from "../../../hooks/useLensDensityPref";
import type { LensConnection } from "../../../types";
import LensGrid from "./LensGrid";
import LensFreshness from "./LensFreshness";
import LensFocusBanner from "./LensFocusBanner";
import LensProvenanceBanner from "./LensProvenanceBanner";

interface Props {
  boardId: number;
  connection: LensConnection;
}

// Pivot options mirror the backend serializer's accepted dimension values
// (git_lens/serializers.py). Keep these two lists in lockstep.
const COLUMN_DIM_OPTIONS = [
  { value: "pipeline", label: "Pipeline (workflow)" },
  { value: "status", label: "Status" },
  { value: "state", label: "State (open/closed)" },
];
const SWIMLANE_DIM_OPTIONS = [
  { value: "milestone", label: "Milestone" },
  { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" },
];

const COLUMN_DIM_KEYS = new Set(COLUMN_DIM_OPTIONS.map((o) => o.value));
const SWIMLANE_DIM_KEYS = new Set(SWIMLANE_DIM_OPTIONS.map((o) => o.value));

/**
 * Read-only "Lens" board view. Renders one public GitHub/GitLab repo's issues
 * as a configurable 2D pivot. The pivot can be overridden ad-hoc via the URL
 * (?column_dim=&swimlane_dim=) without changing the board's saved default.
 */
export default function LensView({ boardId, connection }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Ad-hoc pivot overrides from the URL, validated against the accepted dims.
  // A missing or invalid param falls back to the saved connection default.
  const rawColumnDim = searchParams.get("column_dim");
  const rawSwimlaneDim = searchParams.get("swimlane_dim");
  const columnDim =
    rawColumnDim && COLUMN_DIM_KEYS.has(rawColumnDim) ? rawColumnDim : connection.column_dim;
  const swimlaneDim =
    rawSwimlaneDim && SWIMLANE_DIM_KEYS.has(rawSwimlaneDim) ? rawSwimlaneDim : connection.swimlane_dim;

  const isCustomPivot = columnDim !== connection.column_dim || swimlaneDim !== connection.swimlane_dim;

  const { data, error, loading, refetching, refresh } = useLensData(boardId, columnDim, swimlaneDim);

  // Compact density is a personal reading habit → user pref. Collapse/focus are
  // properties of the shared link → URL params (validated against live data so a
  // key stale after a re-pivot or truncation is silently ignored).
  const [density, setDensity] = useLensDensityPref();
  const laneKeys = useMemo(
    () => new Set((data?.swimlanes ?? []).map((s) => s.key)),
    [data],
  );
  const rawFocus = searchParams.get("lens_focus");
  const focusKey = rawFocus && laneKeys.has(rawFocus) ? rawFocus : null;
  const collapsedKeys = useMemo(() => {
    const raw = searchParams.get("lens_collapsed");
    if (!raw) return new Set<string>();
    return new Set(raw.split(",").map(decodeURIComponent).filter((k) => laneKeys.has(k)));
  }, [searchParams, laneKeys]);

  const toggleCollapse = (key: string) => {
    setSearchParams((prev) => {
      const cur = new Set((prev.get("lens_collapsed")?.split(",").map(decodeURIComponent)) ?? []);
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);
      if (cur.size === 0) prev.delete("lens_collapsed");
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

  const setPivot = (next: { column_dim?: string; swimlane_dim?: string }) => {
    setSearchParams((prev) => {
      if (next.column_dim !== undefined) {
        // Only persist a param when it differs from the saved default — keeps
        // the URL clean when the user is on the default pivot.
        if (next.column_dim === connection.column_dim) prev.delete("column_dim");
        else prev.set("column_dim", next.column_dim);
      }
      if (next.swimlane_dim !== undefined) {
        if (next.swimlane_dim === connection.swimlane_dim) prev.delete("swimlane_dim");
        else prev.set("swimlane_dim", next.swimlane_dim);
      }
      return prev;
    }, { replace: true });
  };

  const resetPivot = () => {
    setSearchParams((prev) => {
      prev.delete("column_dim");
      prev.delete("swimlane_dim");
      return prev;
    }, { replace: true });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Lens toolbar — re-pivot dropdowns + freshness control */}
      <div className="shrink-0 bg-surface border-b border-line flex items-center gap-3 px-3 py-1.5 flex-wrap">
        <SingleSelectDropdown
          label="Columns: Status"
          options={COLUMN_DIM_OPTIONS.map((o) => ({ value: o.value, label: `Columns: ${o.label}` }))}
          selected={columnDim}
          onChange={(v) => setPivot({ column_dim: v ?? connection.column_dim })}
        />
        <SingleSelectDropdown
          label="Swimlanes: Milestone"
          options={SWIMLANE_DIM_OPTIONS.map((o) => ({ value: o.value, label: `Swimlanes: ${o.label}` }))}
          selected={swimlaneDim}
          onChange={(v) => setPivot({ swimlane_dim: v ?? connection.swimlane_dim })}
        />
        {isCustomPivot && (
          <span className="text-xs text-fg-muted flex items-center gap-1.5">
            Viewing a custom pivot ·
            <button
              type="button"
              onClick={resetPivot}
              className="text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Reset
            </button>
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
          aria-pressed={density === "compact"}
          aria-label={density === "compact" ? "Comfortable cards" : "Compact cards"}
          title={density === "compact" ? "Comfortable cards" : "Compact cards"}
          className={`p-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            density === "compact"
              ? "text-info"
              : "text-fg-tertiary hover:text-fg hover:bg-surface-hover"
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <line x1="2.5" y1="4" x2="13.5" y2="4" />
            <line x1="2.5" y1="8" x2="13.5" y2="8" />
            <line x1="2.5" y1="12" x2="13.5" y2="12" />
          </svg>
        </button>
        {data && (
          <LensFreshness fetchedAt={data.fetched_at} refetching={refetching} onRefresh={refresh} />
        )}
      </div>

      {/* Provenance banner — outside the grid scroll container so it never
          scrolls away. Shown whenever we have data. */}
      {data && (
        <LensProvenanceBanner
          provider={data.source.provider}
          repo={data.source.repo}
          url={data.source.url}
          truncated={data.truncated}
          shownCount={data.issues.length}
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
      ) : data ? (
        <LensGrid
          data={data}
          collapsedKeys={collapsedKeys}
          focusKey={focusKey}
          onToggleCollapse={toggleCollapse}
          onFocus={enterFocus}
          onExitFocus={exitFocus}
          density={density}
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
