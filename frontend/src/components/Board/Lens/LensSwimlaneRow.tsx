import type { LensAxis, NormalizedIssue } from "../../../types";
import LensIssueCard from "./LensIssueCard";

interface Props {
  swimlane: LensAxis;
  columns: LensAxis[];
  sidebarWidth: number;
  colWidth: number;
  /** Issues already filtered to this swimlane. */
  issues: NormalizedIssue[];
}

/**
 * Read-only swimlane row for the lens grid. A forked, non-DnD sibling of
 * SwimlaneRow — no drag handle, no edit pencil, no add-card cells. Mirrors the
 * label-panel visual treatment (bg-surface, name) only.
 */
export default function LensSwimlaneRow({ swimlane, columns, sidebarWidth, colWidth, issues }: Props) {
  return (
    <div className="flex border-b border-line-subtle">
      {/* Swimlane label panel — sticky to the left edge of the scroll container */}
      <div
        className="shrink-0 bg-surface px-3 py-2 sticky left-0 z-10 border-r border-line-subtle"
        style={{ width: sidebarWidth }}
      >
        <span className="text-sm text-fg-secondary break-words" title={swimlane.label}>
          {swimlane.label}
        </span>
      </div>

      {columns.map((col) => {
        const cellIssues = issues.filter((i) => i.column_keys.includes(col.key));
        return (
          <div
            key={col.key}
            className="shrink-0 bg-canvas border-r border-line-subtle p-2 flex flex-col gap-2"
            style={{ width: colWidth }}
          >
            {cellIssues.map((issue) => (
              <LensIssueCard
                key={issue.number}
                issue={issue}
                laneCount={issue.swimlane_keys.length}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
