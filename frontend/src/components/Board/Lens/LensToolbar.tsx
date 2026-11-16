import ActiveUnderline from "../../Common/ActiveUnderline";
import { useSearchParams } from "react-router-dom";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import SplitButton from "../../Common/SplitButton";
import Tooltip from "../../Common/Tooltip";
import { MENU_ITEM_FOCUS_RING } from "../../Common/menuItemFocusRing";
import { FilterIcon, LayoutCompactIcon, LayoutExpandedIcon } from "../toolbarIcons";
import { formatShortcut } from "../../../utils/platform";
import { useLiveAnnouncer, laneStateMessage } from "../../../hooks/useLiveAnnouncer";
import type { LensConnection } from "../../../types";
import type { CardLayout } from "../../../hooks/useCardLayoutPref";
import {
  COLUMN_DIM_OPTIONS,
  SWIMLANE_DIM_OPTIONS,
  COLUMN_DIM_KEYS,
  SWIMLANE_DIM_KEYS,
  lensFilterActiveCount,
} from "./lensDims";

interface Props {
  connection: LensConnection;
  cardLayout: CardLayout;
  onToggleLayout: () => void;
  showFilters: boolean;
  onToggleFilters: () => void;
  /** Live lane count (from LensView) so the announcement can say "all N lanes"; omitted until data loads. */
  laneCount?: number;
}

/**
 * Lens controls rendered on the SHARED Row-2 board toolbar (in BoardView), so
 * switching Board↔Lens doesn't reflow the chrome. Like the board's toolbar
 * (#2269) the row wraps instead of scrolling and nothing folds by viewport
 * width (#2302): every control stays reachable at 390px. Pivot dropdowns + the Filters
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
  laneCount,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const layoutShortcutLabel = formatShortcut({ mod: true, shift: true, key: "L" });
  const layoutLabel =
    cardLayout === "compact" ? "Switch to expanded card layout" : "Switch to compact card layout";

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
  // Same rule as the board's Show-row button (#2321): the primary offers "Expand"
  // only once EVERY lane is collapsed. LensView normalizes "all lanes" to the
  // "*" sentinel, so a partial collapse leaves the primary on "Collapse".
  // Every path (primary click, menu Hide all / Show all, by mouse or keyboard) goes
  // through these two, so each announces the new lane state (#2323), matching the
  // Board Show row's wording.
  const { message: laneAnnouncement, announce } = useLiveAnnouncer();
  const collapseAll = () => {
    setSearchParams((prev) => { prev.set("lens_collapsed", "*"); return prev; }, { replace: true });
    announce(laneStateMessage(true, laneCount));
  };
  const expandAll = () => {
    setSearchParams((prev) => { prev.delete("lens_collapsed"); return prev; }, { replace: true });
    announce(laneStateMessage(false, laneCount));
  };

  return (
    <div data-testid="lens-toolbar" className="flex items-center gap-2 flex-wrap">
      {/* Board-style controls (Filters · layout · Collapse) share the board's
          bordered h-9 buttons; the lens-specific pivots follow. No vertical
          dividers: Row 2 has none (#2269). */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="lens-lanes-status">{laneAnnouncement}</span>
      <SplitButton
        size="toolbar"
        primaryLabel={allCollapsed ? "Expand" : "Collapse"}
        primaryAriaLabel={allCollapsed ? "Show all swimlanes" : "Hide all swimlanes"}
        primaryTitle={allCollapsed ? "Show all swimlanes" : "Hide all swimlanes"}
        menuAriaLabel="Collapse menu"
        onPrimary={allCollapsed ? expandAll : collapseAll}
        renderMenu={({ close }) => {
          const item = (label: string, onClick: () => void, disabled: boolean) => (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => { if (disabled) return; onClick(); close(); }}
              className={`w-full text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed ${MENU_ITEM_FOCUS_RING}`}
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
      <Tooltip content={showFilters ? "Hide filters (F)" : "Filters (F)"}>
        <button
          type="button"
          onClick={onToggleFilters}
          className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            showFilters || activeCount > 0 ? "text-info-on-tint bg-info/10 border-info/40" : "text-fg border-line-strong hover:bg-surface-hover"
          }`}
          aria-pressed={showFilters || activeCount > 0}
          aria-keyshortcuts="f"
          aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
        >
          {FilterIcon}
          Filters
          {activeCount > 0 && (
            <span className="bg-primary text-on-primary rounded-full px-1.5 text-xs font-medium leading-5">
              {activeCount}
            </span>
          )}
        </button>
      </Tooltip>
      <Tooltip content={`${layoutLabel} (${layoutShortcutLabel})`}>
        <button
          type="button"
          onClick={onToggleLayout}
          aria-pressed={cardLayout === "compact"}
          aria-label={layoutLabel}
          aria-keyshortcuts={formatShortcut({ mod: true, shift: true, key: "L" })}
          className={`relative inline-flex items-center justify-center h-9 w-9 rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            cardLayout === "compact" ? "text-info-on-tint bg-primary-emphasis/10 border-info/40" : "text-fg border-line-strong hover:bg-surface-hover"
          }`}
        >
          {cardLayout === "compact" ? LayoutCompactIcon : LayoutExpandedIcon}
          <ActiveUnderline active={cardLayout === "compact"} />
        </button>
      </Tooltip>

      {/* Lens-specific pivot controls. `portalMenu` stays (#1161): an in-flow
          `absolute top-full` menu can be clipped by an `overflow` ancestor
          (the tab group scrolls on its own); a portal is immune. */}
      <SingleSelectDropdown
        label="Columns: Status"
        options={COLUMN_DIM_OPTIONS.map((o) => ({ value: o.value, label: `Columns: ${o.label}` }))}
        selected={columnDim}
        onChange={(v) => setPivot({ column_dim: v ?? connection.column_dim })}
        portalMenu
      />
      <SingleSelectDropdown
        label="Swimlanes: Milestone"
        options={SWIMLANE_DIM_OPTIONS.map((o) => ({ value: o.value, label: `Swimlanes: ${o.label}` }))}
        selected={swimlaneDim}
        onChange={(v) => setPivot({ swimlane_dim: v ?? connection.swimlane_dim })}
        portalMenu
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
    </div>
  );
}
