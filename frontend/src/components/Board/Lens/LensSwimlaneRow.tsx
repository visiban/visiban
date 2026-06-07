import type { LensAxis, NormalizedIssue } from "../../../types";
import type { LensDensity } from "../../../hooks/useLensDensityPref";
import LensIssueCard from "./LensIssueCard";

interface Props {
  swimlane: LensAxis;
  columns: LensAxis[];
  sidebarWidth: number;
  colWidth: number;
  /** Issues already filtered to this swimlane. */
  issues: NormalizedIssue[];
  /** Controlled collapse — hides this lane's cells, showing a count stub. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** True when this lane is the active focus target. */
  isFocused: boolean;
  onFocus: (key: string) => void;
  onExitFocus: () => void;
  density: LensDensity;
}

/**
 * Read-only swimlane row for the lens grid. A forked, non-DnD sibling of
 * SwimlaneRow — no drag handle, no edit pencil, no add-card cells. Mirrors the
 * label-panel visual treatment plus the read-only collapse + focus affordances.
 */
export default function LensSwimlaneRow({
  swimlane,
  columns,
  sidebarWidth,
  colWidth,
  issues,
  collapsed,
  onToggleCollapse,
  isFocused,
  onFocus,
  onExitFocus,
  density,
}: Props) {
  return (
    <div className="flex border-b border-line-subtle">
      {/* Swimlane label panel — sticky to the left edge of the scroll container */}
      <div
        className={`group shrink-0 bg-surface px-3 sticky left-0 z-10 border-r border-line-subtle flex items-center gap-1.5 ${
          collapsed ? "py-1" : "py-2"
        }`}
        style={{ width: sidebarWidth }}
      >
        <span className="flex-1 min-w-0 text-sm text-fg-secondary truncate" title={swimlane.label}>
          {swimlane.label}
        </span>
        {/* Focus toggle — hover-reveal (less common action) */}
        <button
          type="button"
          onClick={() => (isFocused ? onExitFocus() : onFocus(swimlane.key))}
          aria-pressed={isFocused}
          aria-label={isFocused ? "Exit focus" : `Focus on ${swimlane.label}`}
          title={isFocused ? "Exit focus" : `Focus on ${swimlane.label}`}
          className={`opacity-0 group-hover:opacity-100 focus:opacity-100 transition focus:ring-2 focus:ring-primary-emphasis rounded shrink-0 focus:outline-none ${
            isFocused ? "!opacity-100 text-info" : "text-fg-tertiary hover:text-fg"
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="3" />
            <line x1="8" y1="1" x2="8" y2="4" />
            <line x1="8" y1="12" x2="8" y2="15" />
            <line x1="1" y1="8" x2="4" y2="8" />
            <line x1="12" y1="8" x2="15" y2="8" />
          </svg>
        </button>
        {/* Collapse chevron — always visible (must communicate interactivity) */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-pressed={collapsed}
          aria-label={collapsed ? `Expand ${swimlane.label}` : `Collapse ${swimlane.label}`}
          title={collapsed ? `Expand ${swimlane.label}` : `Collapse ${swimlane.label}`}
          className="text-fg-tertiary hover:text-fg transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        >
          <svg className={`w-4 h-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {collapsed ? (
        <div className="flex-1 bg-canvas px-3 py-1.5 flex items-center text-xs text-fg-muted">
          <span className="tabular-nums">
            {issues.length} issue{issues.length !== 1 ? "s" : ""}
          </span>
        </div>
      ) : (
        columns.map((col) => {
          const cellIssues = issues.filter((i) => i.column_keys.includes(col.key));
          return (
            <div
              key={col.key}
              className="shrink-0 bg-canvas border-r border-line-subtle p-2 flex flex-col gap-2"
              style={{ width: colWidth }}
            >
              {cellIssues.length === 0 ? (
                // Canonical "no value" marker — pipeline always renders all five
                // columns, so empty Doing/Review cells are common and must read as
                // empty, not broken. The count lives in the column header stat.
                <div
                  className="flex items-center justify-center py-2 text-xs text-fg-faint select-none"
                  aria-hidden="true"
                >
                  —
                </div>
              ) : (
                cellIssues.map((issue) => (
                  <LensIssueCard
                    key={issue.number}
                    issue={issue}
                    laneCount={issue.swimlane_keys.length}
                    density={density}
                  />
                ))
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
