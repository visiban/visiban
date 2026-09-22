import { useMemo } from "react";
import type { LensData, NormalizedIssue } from "../../../types";
import LensColumnHeader from "./LensColumnHeader";
import LensSwimlaneRow from "./LensSwimlaneRow";
import LensResizeHandle from "./LensResizeHandle";
import { DEFAULT_LENS_COL_WIDTH } from "./lensDims";

interface Props {
  data: LensData;
  collapsedKeys: Set<string>;
  focusKey: string | null;
  onToggleCollapse: (key: string) => void;
  onFocus: (key: string) => void;
  onExitFocus: () => void;
  compact: boolean;
  /** Width of the swimlane-label sidebar (#1065) — shared by the corner cell and every row's label panel. */
  sidebarWidth: number;
  /** Per-column-key widths (#1065); a key absent here renders at DEFAULT_LENS_COL_WIDTH. */
  columnWidths: Record<string, number>;
  /** Called continuously while the sidebar's resize handle is dragged. */
  onResizeSidebar: (width: number) => void;
  /** Called continuously while a column's resize handle is dragged. */
  onResizeColumn: (columnKey: string, width: number) => void;
}

// Synthetic "no value" keys arrive from the backend with friendly labels
// already set. We only need the key to push these lanes to the end.
const NONE_KEYS = new Set(["__none__", "__nostatus__"]);

/**
 * Read-only 2D pivot grid for the lens. A forked, non-DnD sibling of the board
 * grid in BoardView — sticky header row, sticky swimlane sidebar, and a
 * stats corner cell, but no separators, trash zones, or add affordances.
 */
export default function LensGrid({
  data,
  collapsedKeys,
  focusKey,
  onToggleCollapse,
  onFocus,
  onExitFocus,
  compact,
  sidebarWidth,
  columnWidths,
  onResizeSidebar,
  onResizeColumn,
}: Props) {
  // Ordering: the current milestone leads, then the rest in backend order, then
  // synthetic "(none)" lanes last (so real milestones/assignees lead).
  const swimlanes = useMemo(() => {
    const real = data.swimlanes.filter((s) => !NONE_KEYS.has(s.key));
    const none = data.swimlanes.filter((s) => NONE_KEYS.has(s.key));
    const current = real.filter((s) => s.is_current);
    const rest = real.filter((s) => !s.is_current);
    return [...current, ...rest, ...none];
  }, [data.swimlanes]);

  // Focus mode renders only the focused lane (if it still exists in the data).
  const visibleSwimlanes = useMemo(
    () => (focusKey ? swimlanes.filter((s) => s.key === focusKey) : swimlanes),
    [swimlanes, focusKey],
  );

  // Pre-bucket issues by swimlane key once, rather than re-filtering per row.
  const issuesByLane = useMemo(() => {
    const map = new Map<string, NormalizedIssue[]>();
    for (const lane of data.swimlanes) map.set(lane.key, []);
    for (const issue of data.issues) {
      for (const key of issue.swimlane_keys) {
        const bucket = map.get(key);
        if (bucket) bucket.push(issue);
      }
    }
    return map;
  }, [data.swimlanes, data.issues]);

  const columnCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const col of data.columns) counts.set(col.key, 0);
    for (const issue of data.issues) {
      for (const key of issue.column_keys) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [data.columns, data.issues]);

  // Resolved per-column widths as a Map — mirrors the native board's
  // `colWidths: Map<number, number>` shape (BoardView.tsx), keyed by the
  // pivot-derived column string key instead of a numeric ID (#1065).
  const colWidths = useMemo(() => {
    const map = new Map<string, number>();
    for (const col of data.columns) {
      map.set(col.key, columnWidths[col.key] ?? DEFAULT_LENS_COL_WIDTH);
    }
    return map;
  }, [data.columns, columnWidths]);

  if (data.issues.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-fg-tertiary">
        <span className="text-2xl text-fg-faint" aria-hidden="true">🔍</span>
        <p className="text-sm">No issues to show for this repository.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-sunken">
      <div className="min-w-max">
        {/* Header row — sticky to the top of the scroll container */}
        <div className="flex sticky top-0 z-20 border-b border-line bg-surface">
          {/* Corner — sticky to the left; shows axis counts at a glance. Also
              carries the sidebar's resize handle (#1065) — its width drives
              both this cell and every row's label panel below. */}
          <div
            className="relative shrink-0 bg-surface flex flex-col items-center justify-center gap-0.5 sticky left-0 z-30 px-2"
            style={{ width: sidebarWidth }}
          >
            <span className="text-xs text-fg-muted font-medium tabular-nums">
              {data.columns.length} col{data.columns.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-fg-muted font-medium tabular-nums">
              {swimlanes.length} lane{swimlanes.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-fg-faint tabular-nums">
              {data.issues.length} issue{data.issues.length !== 1 ? "s" : ""}
            </span>
            <LensResizeHandle
              currentWidth={sidebarWidth}
              setWidth={onResizeSidebar}
              ariaLabel="Resize swimlane label width"
            />
          </div>
          {data.columns.map((col) => (
            <LensColumnHeader
              key={col.key}
              column={col}
              count={columnCounts.get(col.key) ?? 0}
              width={colWidths.get(col.key) ?? DEFAULT_LENS_COL_WIDTH}
              onResize={(w) => onResizeColumn(col.key, w)}
            />
          ))}
        </div>

        {/* Swimlane rows */}
        {visibleSwimlanes.map((lane) => (
          <LensSwimlaneRow
            key={lane.key}
            swimlane={lane}
            columns={data.columns}
            sidebarWidth={sidebarWidth}
            colWidths={colWidths}
            issues={issuesByLane.get(lane.key) ?? []}
            collapsed={collapsedKeys.has(lane.key)}
            onToggleCollapse={() => onToggleCollapse(lane.key)}
            isFocused={focusKey === lane.key}
            onFocus={onFocus}
            onExitFocus={onExitFocus}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}
