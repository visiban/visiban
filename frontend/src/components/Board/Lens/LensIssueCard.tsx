import Avatar from "../../Common/Avatar";
import type { NormalizedIssue } from "../../../types";

interface Props {
  issue: NormalizedIssue;
  /**
   * How many lanes this card is rendered in. When > 1 a small "🔗 ×N"
   * indicator is shown so the reader knows the same issue appears elsewhere
   * (an issue with multiple matching swimlane values renders in each lane).
   */
  laneCount?: number;
}

const MAX_AVATARS = 3;

/**
 * Read-only issue card for the lens grid. A forked, non-draggable sibling of
 * CardItem — it is a <button> (cursor-pointer + hover wash, never cursor-grab /
 * translate-y) and opens the upstream issue in a new tab on click. See the
 * "Read-only external cells/headers" rule in frontend/CLAUDE.md.
 */
export default function LensIssueCard({ issue, laneCount = 1 }: Props) {
  const closed = issue.state === "closed";
  const extraAssignees = issue.assignees.length - MAX_AVATARS;

  return (
    <button
      type="button"
      onClick={() => window.open(issue.url, "_blank", "noopener,noreferrer")}
      title={`#${issue.number} — open in new tab`}
      className={`group block w-full text-left bg-surface rounded-md border border-line p-2.5 transition-colors cursor-pointer hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        closed ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-xs text-fg-muted shrink-0">#{issue.number}</span>
        <span
          className={`text-xs font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
            closed
              ? "bg-surface-hover text-fg-muted"
              : "bg-success/15 text-success"
          }`}
        >
          {closed ? "Closed" : "Open"}
        </span>
        {laneCount > 1 && (
          <span
            className="text-xs text-fg-muted shrink-0 ml-auto"
            title={`This issue appears in ${laneCount} swimlanes`}
          >
            🔗 ×{laneCount}
          </span>
        )}
      </div>

      <p className="text-sm text-fg line-clamp-2">{issue.title}</p>

      {issue.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.name}
              className="text-xs font-semibold px-1 py-0.5 rounded leading-none"
              style={{
                backgroundColor: `#${label.color}22`,
                color: `#${label.color}`,
                border: `1px solid #${label.color}44`,
              }}
              title={label.name}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {(issue.milestone || issue.assignees.length > 0) && (
        <div className="flex items-center gap-2 mt-1.5 text-xs text-fg-muted">
          {issue.milestone && (
            <span className="flex items-center gap-1 min-w-0" title={`Milestone: ${issue.milestone}`}>
              <span aria-hidden="true">🚩</span>
              <span className="truncate">{issue.milestone}</span>
            </span>
          )}
          {issue.assignees.length > 0 && (
            <div className="flex items-center gap-0.5 ml-auto shrink-0">
              {issue.assignees.slice(0, MAX_AVATARS).map((a) => (
                <Avatar
                  key={a.username}
                  user={{ username: a.username, display_name: a.username, avatar_url: a.avatar_url }}
                  size="xs"
                />
              ))}
              {extraAssignees > 0 && (
                <span className="text-xs text-fg-tertiary ml-0.5">+{extraAssignees}</span>
              )}
            </div>
          )}
        </div>
      )}
    </button>
  );
}
