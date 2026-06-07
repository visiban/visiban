import { useMemo } from "react";
import type { LensData, NormalizedIssue } from "../../../types";
import LensColumnHeader from "./LensColumnHeader";
import LensSwimlaneRow from "./LensSwimlaneRow";

interface Props {
  data: LensData;
}

const SIDEBAR_WIDTH = 200;
const COL_WIDTH = 280;
// Synthetic "no value" keys arrive from the backend with friendly labels
// already set. We only need the key to push these lanes to the end.
const NONE_KEYS = new Set(["__none__", "__nostatus__"]);

/**
 * Read-only 2D pivot grid for the lens. A forked, non-DnD sibling of the board
 * grid in BoardView — sticky header row, sticky swimlane sidebar, and a
 * stats corner cell, but no separators, trash zones, or add affordances.
 */
export default function LensGrid({ data }: Props) {
  // Synthetic "(none)" lanes render last so real milestones/assignees lead.
  const swimlanes = useMemo(() => {
    const real = data.swimlanes.filter((s) => !NONE_KEYS.has(s.key));
    const none = data.swimlanes.filter((s) => NONE_KEYS.has(s.key));
    return [...real, ...none];
  }, [data.swimlanes]);

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
          {/* Corner — sticky to the left; shows axis counts at a glance */}
          <div
            className="shrink-0 bg-surface flex flex-col items-center justify-center gap-0.5 sticky left-0 z-30 px-2"
            style={{ width: SIDEBAR_WIDTH }}
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
          </div>
          {data.columns.map((col) => (
            <LensColumnHeader
              key={col.key}
              column={col}
              count={columnCounts.get(col.key) ?? 0}
              width={COL_WIDTH}
            />
          ))}
        </div>

        {/* Swimlane rows */}
        {swimlanes.map((lane) => (
          <LensSwimlaneRow
            key={lane.key}
            swimlane={lane}
            columns={data.columns}
            sidebarWidth={SIDEBAR_WIDTH}
            colWidth={COL_WIDTH}
            issues={issuesByLane.get(lane.key) ?? []}
          />
        ))}
      </div>
    </div>
  );
}
