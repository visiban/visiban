import { useSearchParams } from "react-router-dom";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import SplitButton from "../../Common/SplitButton";
import Tooltip from "../../Common/Tooltip";
import type { LensConnection } from "../../../types";
import type { CardLayout } from "../../../hooks/useCardLayoutPref";
import {
  COLUMN_DIM_OPTIONS,
  SWIMLANE_DIM_OPTIONS,
  COLUMN_DIM_KEYS,
  SWIMLANE_DIM_KEYS,
  lensFilterActiveCount,
} from "./lensDims";

// Reused verbatim from the board toolbar so board↔lens read identically.
const LayoutCompactIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="3" width="18" height="5" rx="1" />
    <rect x="3" y="10" width="18" height="5" rx="1" />
    <rect x="3" y="17" width="18" height="4" rx="1" />
  </svg>
);
const LayoutExpandedIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

interface Props {
  connection: LensConnection;
  cardLayout: CardLayout;
  onToggleLayout: () => void;
  showFilters: boolean;
  onToggleFilters: () => void;
}

/**
 * Lens controls rendered on the SHARED Row-2 board toolbar (in BoardView), so
 * switching Board↔Lens doesn't reflow the chrome. Pivot dropdowns + the Filters
 * toggle read/write the URL directly; the layout toggle reuses the board's
 * `useCardLayoutPref` (owned by BoardView). Freshness lives in the provenance
 * banner, not here.
 */
export default function LensToolbar({
  connection,
  cardLayout,
  onToggleLayout,
  showFilters,
  onToggleFilters,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawColumnDim = searchParams.get("column_dim");
  const rawSwimlaneDim = searchParams.get("swimlane_dim");
  const columnDim =
    rawColumnDim && COLUMN_DIM_KEYS.has(rawColumnDim) ? rawColumnDim : connection.column_dim;
  const swimlaneDim =
    rawSwimlaneDim && SWIMLANE_DIM_KEYS.has(rawSwimlaneDim) ? rawSwimlaneDim : connection.swimlane_dim;
  const isCustomPivot =
    columnDim !== connection.column_dim || swimlaneDim !== connection.swimlane_dim;
  const activeCount = lensFilterActiveCount(searchParams);

  const setPivot = (next: { column_dim?: string; swimlane_dim?: string }) => {
    setSearchParams((prev) => {
      if (next.column_dim !== undefined) {
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
  const resetPivot = () =>
    setSearchParams((prev) => {
      prev.delete("column_dim");
      prev.delete("swimlane_dim");
      return prev;
    }, { replace: true });

  // Collapse-all uses a "*" sentinel (LensView resolves it against the live lane
  // keys) so this toolbar — which has no fetched data — can hide every lane.
  const rawCollapsed = searchParams.get("lens_collapsed");
  const allCollapsed = rawCollapsed === "*";
  const noneCollapsed = !rawCollapsed;
  const collapseAll = () =>
    setSearchParams((prev) => { prev.set("lens_collapsed", "*"); return prev; }, { replace: true });
  const expandAll = () =>
    setSearchParams((prev) => { prev.delete("lens_collapsed"); return prev; }, { replace: true });

  return (
    <>
      <div className="w-px h-4 bg-surface-hover mx-1" aria-hidden="true" />
      {/* Board-identical control zone (Collapse · Filters · layout) leads, so it
          lines up with the board; the lens-specific pivots follow. */}
      <SplitButton
        primaryLabel={noneCollapsed ? "Collapse" : "Expand"}
        primaryAriaLabel={noneCollapsed ? "Hide all swimlanes" : "Show all swimlanes"}
        primaryTitle={noneCollapsed ? "Hide all swimlanes" : "Show all swimlanes"}
        menuAriaLabel="Collapse menu"
        onPrimary={noneCollapsed ? collapseAll : expandAll}
        renderMenu={({ close }) => {
          const item = (label: string, onClick: () => void, disabled: boolean) => (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => { if (disabled) return; onClick(); close(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {label}
            </button>
          );
          return (
            <>
              {item("Hide all swimlanes", collapseAll, allCollapsed)}
              <div role="separator" className="mx-4 my-1">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
              {item("Show all swimlanes", expandAll, noneCollapsed)}
            </>
          );
        }}
      />
      <Tooltip content={showFilters ? "Hide filters" : "Filters"}>
        <button
          type="button"
          onClick={onToggleFilters}
          className={`text-xs px-2 py-1 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            showFilters ? "text-info bg-info/10" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"
          }`}
          aria-pressed={showFilters || activeCount > 0}
          aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
        >
          {showFilters ? "Hide filters" : "Filters"}
          {!showFilters && activeCount > 0 && (
            <span className="ml-1.5 bg-primary-emphasis/20 text-info rounded-full px-1.5 py-0.5 font-medium">
              {activeCount}
            </span>
          )}
        </button>
      </Tooltip>
      <Tooltip
        content={
          cardLayout === "compact"
            ? "Switch to expanded card layout"
            : "Switch to compact card layout"
        }
      >
        <button
          type="button"
          onClick={onToggleLayout}
          aria-pressed={cardLayout === "compact"}
          aria-label={
            cardLayout === "compact" ? "Switch to expanded card layout" : "Switch to compact card layout"
          }
          className={`p-1.5 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            cardLayout === "compact" ? "text-info bg-info/10" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"
          }`}
        >
          {cardLayout === "compact" ? LayoutCompactIcon : LayoutExpandedIcon}
        </button>
      </Tooltip>

      <div className="w-px h-4 bg-surface-hover mx-1" aria-hidden="true" />
      {/* Lens-specific pivot controls — to the right of the board-shared zone. */}
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
        <span className="text-xs text-fg-muted flex items-center gap-1.5 shrink-0">
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
    </>
  );
}
